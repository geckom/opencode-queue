import { randomUUID } from "crypto"
import { CronJob } from "cron"
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import {
  DEFAULT_CONFIG,
  OPENCODE_DIR,
  QUEUE_CORRUPTION_MARKER_FILE,
  QUEUE_FILE,
  STORE_LOCK_FILE,
  STORE_LOCK_RETRY_MS,
  STORE_LOCK_STALE_MS,
  STORE_LOCK_WAIT_MS,
} from "./constants.js"
import { FileLock } from "./file-lock.js"
import type { DependencyMode, DependencySourceStatus, QueueConfig, QueueItem, QueueStore, ScheduledTask } from "./types.js"
import { createQueueItemFromSchedule } from "./utils.js"

/**
 * QueueManager owns queue.json persistence, normalization, and all state
 * transitions that must be serialized across processes.
 */
export class QueueManager {
  private clearCorruptionMarker(): void {
    try {
      if (existsSync(QUEUE_CORRUPTION_MARKER_FILE)) {
        unlinkSync(QUEUE_CORRUPTION_MARKER_FILE)
      }
    } catch {}
  }

  private handleCorruptedStore(error: unknown): never {
    if (!existsSync(OPENCODE_DIR)) {
      mkdirSync(OPENCODE_DIR, { recursive: true })
    }

    let backupPath: string | null = null
    try {
      if (existsSync(QUEUE_CORRUPTION_MARKER_FILE)) {
        const marker = JSON.parse(readFileSync(QUEUE_CORRUPTION_MARKER_FILE, "utf-8")) as { backupPath?: string }
        if (typeof marker.backupPath === "string") {
          backupPath = marker.backupPath
        }
      }
    } catch {}

    if (!backupPath) {
      backupPath = `${QUEUE_FILE}.corrupt-${Date.now()}`
      copyFileSync(QUEUE_FILE, backupPath)
      writeFileSync(
        QUEUE_CORRUPTION_MARKER_FILE,
        JSON.stringify(
          {
            detectedAt: new Date().toISOString(),
            backupPath,
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
        "utf-8",
      )
    }

    throw new Error(
      `Queue store is corrupted: ${QUEUE_FILE}. Backup preserved at ${backupPath}. Repair or replace queue.json before continuing.`,
    )
  }

  private normalizeItem(item: Partial<QueueItem>): QueueItem {
    return {
      id: String(item.id || randomUUID()),
      workspace: String(item.workspace || ""),
      goal: String(item.goal || ""),
      status: item.status || "pending",
      parentItemId: item.parentItemId ?? null,
      dependencyMode: item.dependencyMode === "completed" ? "completed" : "review_pending",
      dependencySatisfiedAt: item.dependencySatisfiedAt ?? null,
      dependencySourceStatus:
        item.dependencySourceStatus === "completed" || item.dependencySourceStatus === "review_pending"
          ? item.dependencySourceStatus
          : null,
      dependencyBlockedReason: item.dependencyBlockedReason ?? null,
      staleDependency: Boolean(item.staleDependency),
      sessionId: item.sessionId ?? null,
      createdAt: String(item.createdAt || new Date().toISOString()),
      startedAt: item.startedAt ?? null,
      completedAt: item.completedAt ?? null,
      reviewedAt: item.reviewedAt ?? null,
      blockedReason: item.blockedReason ?? null,
      error: item.error ?? null,
      result: item.result ?? null,
      sessionUrl: item.sessionUrl ?? null,
      retryCount: typeof item.retryCount === "number" ? item.retryCount : 0,
      nextRetryAt: item.nextRetryAt ?? null,
      followupMessage: item.followupMessage ?? null,
      sourceScheduleId: item.sourceScheduleId ?? null,
    }
  }

  private normalizeSchedule(schedule: Partial<ScheduledTask>): ScheduledTask {
    return {
      id: String(schedule.id || randomUUID()),
      workspace: String(schedule.workspace || ""),
      goal: String(schedule.goal || ""),
      scheduledFor: schedule.scheduledFor ?? null,
      cronExpression: schedule.cronExpression ?? null,
      timezone: String(schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone),
      enabled: Boolean(schedule.enabled),
      lastTriggeredAt: schedule.lastTriggeredAt ?? null,
      nextTriggerAt: schedule.nextTriggerAt ?? null,
      occurrenceCount: typeof schedule.occurrenceCount === "number" ? schedule.occurrenceCount : 0,
      maxOccurrences: typeof schedule.maxOccurrences === "number" ? schedule.maxOccurrences : null,
      parentItemId: schedule.parentItemId ?? null,
      dependencyMode: schedule.dependencyMode === "completed" ? "completed" : "review_pending",
      createdAt: String(schedule.createdAt || new Date().toISOString()),
    }
  }

  private normalizeConfig(config?: Partial<QueueConfig> | null): QueueConfig {
    return {
      ...DEFAULT_CONFIG,
      ...(config ?? {}),
    }
  }

  private readStore(): QueueStore {
    if (!existsSync(QUEUE_FILE)) {
      this.clearCorruptionMarker()
      return { config: { ...DEFAULT_CONFIG }, items: [], schedules: [] }
    }

    try {
      const raw = readFileSync(QUEUE_FILE, "utf-8")
      const parsed = JSON.parse(raw) as Partial<QueueStore>
      this.clearCorruptionMarker()
      return {
        config: this.normalizeConfig(parsed.config),
        items: Array.isArray(parsed.items) ? parsed.items.map((item) => this.normalizeItem(item)) : [],
        schedules: Array.isArray(parsed.schedules) ? parsed.schedules.map((schedule) => this.normalizeSchedule(schedule)) : [],
      }
    } catch (error) {
      this.handleCorruptedStore(error)
    }
  }

  private writeStore(store: QueueStore): void {
    if (!existsSync(OPENCODE_DIR)) {
      mkdirSync(OPENCODE_DIR, { recursive: true })
    }
    const tmp = QUEUE_FILE + ".tmp"
    writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8")
    renameSync(tmp, QUEUE_FILE)
  }

  private getNextCronTrigger(schedule: ScheduledTask): string | null {
    if (!schedule.cronExpression) return null
    try {
      const job = new CronJob(schedule.cronExpression, () => {}, undefined, false, schedule.timezone)
      const nextDate = job.nextDate()
      job.stop()
      return nextDate ? nextDate.toISO() : null
    } catch {
      return null
    }
  }

  private wouldCreateDependencyCycle(itemId: string, parentItemId: string | null, items: QueueItem[]): boolean {
    if (!parentItemId) return false
    let currentId: string | null = parentItemId
    const visited = new Set<string>()
    while (currentId) {
      if (currentId === itemId) return true
      if (visited.has(currentId)) return true
      visited.add(currentId)
      const parent = items.find((candidate) => candidate.id === currentId)
      currentId = parent?.parentItemId ?? null
    }
    return false
  }

  private evaluateDependency(
    item: QueueItem,
    items: QueueItem[],
  ): { eligible: boolean; blockedReason: string | null; sourceStatus: DependencySourceStatus } {
    if (!item.parentItemId) {
      return { eligible: true, blockedReason: null, sourceStatus: null }
    }

    const parent = items.find((candidate) => candidate.id === item.parentItemId)
    if (!parent) {
      return { eligible: false, blockedReason: `Parent item ${item.parentItemId} not found.`, sourceStatus: null }
    }

    if (parent.status === "completed") {
      return { eligible: true, blockedReason: null, sourceStatus: "completed" }
    }
    if (parent.status === "review_pending" && item.dependencyMode === "review_pending") {
      return { eligible: true, blockedReason: null, sourceStatus: "review_pending" }
    }
    if (parent.status === "review_pending") {
      return { eligible: false, blockedReason: `Waiting for parent ${parent.id} to be completed.`, sourceStatus: null }
    }
    if (parent.status === "failed") {
      return { eligible: false, blockedReason: `Parent ${parent.id} failed.`, sourceStatus: null }
    }
    if (parent.status === "blocked") {
      return { eligible: false, blockedReason: `Parent ${parent.id} is blocked.`, sourceStatus: null }
    }
    if (parent.status === "running") {
      return { eligible: false, blockedReason: `Parent ${parent.id} is running.`, sourceStatus: null }
    }
    return { eligible: false, blockedReason: `Waiting for parent ${parent.id} to start.`, sourceStatus: null }
  }

  private async mutateStore<T>(work: (store: QueueStore) => T): Promise<T> {
    return FileLock.withLock(STORE_LOCK_FILE, STORE_LOCK_STALE_MS, STORE_LOCK_RETRY_MS, STORE_LOCK_WAIT_MS, async () => {
      const store = this.readStore()
      const result = work(store)
      this.writeStore(store)
      return result
    })
  }

  getConfig(): QueueConfig {
    return this.readStore().config
  }

  async updateConfig(updates: Partial<QueueConfig>): Promise<QueueConfig> {
    return this.mutateStore((store) => {
      store.config = this.normalizeConfig({
        ...store.config,
        ...updates,
      })
      return store.config
    })
  }

  listItems(status?: string): QueueItem[] {
    const store = this.readStore()
    return status ? store.items.filter((item) => item.status === status) : store.items
  }

  getItem(id: string): QueueItem | undefined {
    return this.readStore().items.find((item) => item.id === id)
  }

  async addItem(
    workspace: string,
    goal: string,
    options?: {
      parentItemId?: string | null
      dependencyMode?: DependencyMode
      sourceScheduleId?: string | null
      prepend?: boolean
    },
  ): Promise<QueueItem | { error: string }> {
    const absWorkspace = resolve(workspace)
    if (!existsSync(absWorkspace)) {
      return { error: `Directory not found: ${absWorkspace}` }
    }
    if (!statSync(absWorkspace).isDirectory()) {
      return { error: `Path is not a directory: ${absWorkspace}` }
    }

    return this.mutateStore((store) => {
      const parentItemId = options?.parentItemId ?? null
      if (parentItemId && !store.items.some((item) => item.id === parentItemId)) {
        return { error: `Parent item not found: ${parentItemId}` }
      }
      const item: QueueItem = {
        id: randomUUID(),
        workspace: absWorkspace,
        goal,
        status: "pending",
        parentItemId,
        dependencyMode: options?.dependencyMode === "completed" ? "completed" : "review_pending",
        dependencySatisfiedAt: null,
        dependencySourceStatus: null,
        dependencyBlockedReason: parentItemId ? `Waiting for parent ${parentItemId} to start.` : null,
        staleDependency: false,
        sessionId: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        reviewedAt: null,
        blockedReason: null,
        error: null,
        result: null,
        sessionUrl: null,
        retryCount: 0,
        nextRetryAt: null,
        followupMessage: null,
        sourceScheduleId: options?.sourceScheduleId ?? null,
      }
      if (this.wouldCreateDependencyCycle(item.id, item.parentItemId, store.items)) {
        return { error: `Dependency cycle detected for parent ${item.parentItemId}.` }
      }
      if (options?.prepend) store.items.unshift(item)
      else store.items.push(item)
      return item
    })
  }

  async updateItem(id: string, updates: Partial<QueueItem>): Promise<QueueItem | undefined> {
    return this.mutateStore((store) => {
      const idx = store.items.findIndex((item) => item.id === id)
      if (idx === -1) return undefined
      Object.assign(store.items[idx], updates)
      return store.items[idx]
    })
  }

  async removeItem(id: string): Promise<boolean> {
    return this.mutateStore((store) => {
      const idx = store.items.findIndex((item) => item.id === id)
      if (idx === -1) return false
      store.items.splice(idx, 1)
      return true
    })
  }

  async markDescendantsStale(parentItemId: string): Promise<void> {
    await this.mutateStore((store) => {
      const descendants = new Set<string>()
      const queue = [parentItemId]
      while (queue.length > 0) {
        const current = queue.shift()!
        for (const item of store.items) {
          if (item.parentItemId === current && !descendants.has(item.id)) {
            descendants.add(item.id)
            queue.push(item.id)
          }
        }
      }
      for (const item of store.items) {
        if (!descendants.has(item.id)) continue
        if (!["running", "review_pending", "completed", "blocked"].includes(item.status)) continue
        item.staleDependency = true
      }
    })
  }

  async getNextPending(): Promise<QueueItem | undefined> {
    return FileLock.withLock(
      STORE_LOCK_FILE,
      STORE_LOCK_STALE_MS,
      STORE_LOCK_RETRY_MS,
      STORE_LOCK_WAIT_MS,
      async () => {
        const store = this.readStore()
        const now = Date.now()
        let changed = false
        let nextItem: QueueItem | undefined

        for (const item of store.items) {
          const isReadyRetry = item.status === "running" && item.nextRetryAt && new Date(item.nextRetryAt).getTime() <= now
          const isPending = item.status === "pending"
          if (!isPending && !isReadyRetry) continue

          const dependency = this.evaluateDependency(item, store.items)
          if (item.dependencyBlockedReason !== dependency.blockedReason) {
            item.dependencyBlockedReason = dependency.blockedReason
            changed = true
          }
          if (!dependency.eligible) continue

          if (item.dependencySourceStatus !== dependency.sourceStatus) {
            item.dependencySourceStatus = dependency.sourceStatus
            changed = true
          }
          if (dependency.sourceStatus && !item.dependencySatisfiedAt) {
            item.dependencySatisfiedAt = new Date().toISOString()
            changed = true
          }
          if (item.dependencyBlockedReason !== null) {
            item.dependencyBlockedReason = null
            changed = true
          }
          nextItem = { ...item }
          break
        }

        if (changed) this.writeStore(store)
        return nextItem
      },
    )
  }

  countByStatus(): Record<string, number> {
    const store = this.readStore()
    const counts: Record<string, number> = {}
    for (const item of store.items) {
      counts[item.status] = (counts[item.status] || 0) + 1
    }
    return counts
  }

  async resetRunningToPending(): Promise<void> {
    await this.mutateStore((store) => {
      for (const item of store.items) {
        if (item.status === "running") {
          item.status = "pending"
        }
      }
    })
  }

  listSchedules(): ScheduledTask[] {
    return this.readStore().schedules
  }

  getSchedule(id: string): ScheduledTask | undefined {
    return this.readStore().schedules.find((schedule) => schedule.id === id)
  }

  async addSchedule(
    schedule: Omit<ScheduledTask, "id" | "lastTriggeredAt" | "nextTriggerAt" | "occurrenceCount" | "createdAt">,
  ): Promise<ScheduledTask> {
    const task: ScheduledTask = {
      ...schedule,
      id: randomUUID(),
      lastTriggeredAt: null,
      nextTriggerAt: null,
      occurrenceCount: 0,
      createdAt: new Date().toISOString(),
    }
    await this.mutateStore((store) => {
      store.schedules.push(task)
    })
    return task
  }

  async updateSchedule(id: string, updates: Partial<ScheduledTask>): Promise<ScheduledTask | undefined> {
    return this.mutateStore((store) => {
      const idx = store.schedules.findIndex((schedule) => schedule.id === id)
      if (idx === -1) return undefined
      Object.assign(store.schedules[idx], updates)
      return store.schedules[idx]
    })
  }

  async removeSchedule(id: string): Promise<boolean> {
    return this.mutateStore((store) => {
      const idx = store.schedules.findIndex((schedule) => schedule.id === id)
      if (idx === -1) return false
      store.schedules.splice(idx, 1)
      return true
    })
  }

  async triggerSchedule(scheduleId: string): Promise<{ schedule: ScheduledTask; itemId: string } | null> {
    return this.mutateStore((store) => {
      const schedule = store.schedules.find((candidate) => candidate.id === scheduleId)
      if (!schedule || !schedule.enabled) return null

      const now = new Date()
      const triggerAt = schedule.nextTriggerAt || schedule.scheduledFor
      if (triggerAt) {
        const triggerMs = new Date(triggerAt).getTime()
        if (!Number.isNaN(triggerMs) && triggerMs > now.getTime()) {
          return null
        }
      }

      schedule.lastTriggeredAt = now.toISOString()
      schedule.occurrenceCount += 1

      if (schedule.maxOccurrences !== null && schedule.occurrenceCount >= schedule.maxOccurrences) {
        schedule.enabled = false
      }

      if (schedule.scheduledFor) {
        schedule.enabled = false
        schedule.nextTriggerAt = null
      } else if (schedule.cronExpression && schedule.enabled) {
        schedule.nextTriggerAt = this.getNextCronTrigger(schedule)
      } else if (!schedule.enabled) {
        schedule.nextTriggerAt = null
      }

      const item = createQueueItemFromSchedule(schedule, scheduleId)
      store.items.unshift(item)

      return { schedule: { ...schedule }, itemId: item.id }
    })
  }
}
