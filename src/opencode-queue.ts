import type { OpencodeClient } from "@opencode-ai/sdk"
import { tool, type Plugin } from "@opencode-ai/plugin"
import { randomUUID } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from "fs"
import { join, resolve } from "path"

const CONFIG_DIR = process.env.XDG_CONFIG_HOME || join(process.env.HOME!, ".config")
const OPENCODE_DIR = join(CONFIG_DIR, "opencode")
const QUEUE_FILE = join(OPENCODE_DIR, "queue.json")
const LAST_ACTIVITY_FILE = join(OPENCODE_DIR, "queue.last-activity")
const LOCK_FILE = join(OPENCODE_DIR, "queue.lock")
const STORE_LOCK_FILE = join(OPENCODE_DIR, "queue.store.lock")
const PROCESSING_LOCK_STALE_MS = 120_000
const PROCESSING_LOCK_REFRESH_MS = 30_000
const STORE_LOCK_STALE_MS = 15_000
const STORE_LOCK_RETRY_MS = 50
const STORE_LOCK_WAIT_MS = 5_000
const SIGNAL_EXIT_CODE: Record<"SIGINT" | "SIGTERM", number> = {
  SIGINT: 130,
  SIGTERM: 143,
}

interface QueueConfig {
  idleTimeoutSeconds: number
  blockedReminderMinutes: number
  maxRetries: number
  retryDelaysMinutes: number[]
  reminderIntervalMessages: number
}

interface BlockedReason {
  type: "permission" | "question"
  permissionId: string | null
  requestId?: string | null
  details: string
  options: string[] | null
  userResponse: string | null
}

interface QueueItem {
  id: string
  workspace: string
  goal: string
  status: "pending" | "running" | "blocked" | "review_pending" | "completed" | "failed"
  parentItemId: string | null
  dependencyMode: "review_pending" | "completed"
  dependencySatisfiedAt: string | null
  dependencySourceStatus: "review_pending" | "completed" | null
  dependencyBlockedReason: string | null
  staleDependency: boolean
  sessionId: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  reviewedAt?: string | null
  blockedReason: BlockedReason | null
  error: string | null
  result: string | null
  sessionUrl: string | null
  retryCount: number
  nextRetryAt: string | null
}

interface QueueStore {
  config: QueueConfig
  items: QueueItem[]
}

const DEFAULT_CONFIG: QueueConfig = {
  idleTimeoutSeconds: 3600,
  blockedReminderMinutes: 30,
  maxRetries: 3,
  retryDelaysMinutes: [5, 10, 15],
  reminderIntervalMessages: 30,
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class QueueManager {
  private normalizeItem(item: Partial<QueueItem>): QueueItem {
    return {
      id: String(item.id || randomUUID()),
      workspace: String(item.workspace || ""),
      goal: String(item.goal || ""),
      status: (item.status as QueueItem["status"]) || "pending",
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
  ): { eligible: boolean; blockedReason: string | null; sourceStatus: "review_pending" | "completed" | null } {
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

  private normalizeConfig(config?: Partial<QueueConfig> | null): QueueConfig {
    return {
      ...DEFAULT_CONFIG,
      ...(config ?? {}),
    }
  }

  private readStore(): QueueStore {
    try {
      if (!existsSync(QUEUE_FILE)) {
        return { config: { ...DEFAULT_CONFIG }, items: [] }
      }
      const raw = readFileSync(QUEUE_FILE, "utf-8")
      const parsed = JSON.parse(raw) as Partial<QueueStore>
      return {
        config: this.normalizeConfig(parsed.config),
        items: Array.isArray(parsed.items) ? parsed.items.map((item) => this.normalizeItem(item)) : [],
      }
    } catch {
      return { config: { ...DEFAULT_CONFIG }, items: [] }
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

  getConfig(): QueueConfig {
    return this.readStore().config
  }

  async updateConfig(updates: Partial<QueueConfig>): Promise<QueueConfig> {
    return FileLock.withLock(STORE_LOCK_FILE, STORE_LOCK_STALE_MS, STORE_LOCK_RETRY_MS, STORE_LOCK_WAIT_MS, async () => {
      const store = this.readStore()
      store.config = this.normalizeConfig({
        ...store.config,
        ...updates,
      })
      this.writeStore(store)
      return store.config
    })
  }

  listItems(status?: string): QueueItem[] {
    const store = this.readStore()
    if (status) {
      return store.items.filter((item) => item.status === status)
    }
    return store.items
  }

  getItem(id: string): QueueItem | undefined {
    return this.readStore().items.find((item) => item.id === id)
  }

  async addItem(
    workspace: string,
    goal: string,
    options?: { parentItemId?: string | null; dependencyMode?: "review_pending" | "completed" },
  ): Promise<QueueItem | { error: string }> {
    const absWorkspace = resolve(workspace)
    if (!existsSync(absWorkspace)) {
      return { error: `Directory not found: ${absWorkspace}` }
    }
    if (!statSync(absWorkspace).isDirectory()) {
      return { error: `Path is not a directory: ${absWorkspace}` }
    }
    return FileLock.withLock(STORE_LOCK_FILE, STORE_LOCK_STALE_MS, STORE_LOCK_RETRY_MS, STORE_LOCK_WAIT_MS, async () => {
      const store = this.readStore()
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
      }
      if (item.parentItemId === item.id || this.wouldCreateDependencyCycle(item.id, item.parentItemId, store.items)) {
        return { error: `Dependency cycle detected for parent ${item.parentItemId}.` }
      }
      store.items.push(item)
      this.writeStore(store)
      return item
    })
  }

  async updateItem(id: string, updates: Partial<QueueItem>): Promise<QueueItem | undefined> {
    return FileLock.withLock(STORE_LOCK_FILE, STORE_LOCK_STALE_MS, STORE_LOCK_RETRY_MS, STORE_LOCK_WAIT_MS, async () => {
      const store = this.readStore()
      const idx = store.items.findIndex((item) => item.id === id)
      if (idx === -1) return undefined
      Object.assign(store.items[idx], updates)
      this.writeStore(store)
      return store.items[idx]
    })
  }

  async removeItem(id: string): Promise<boolean> {
    return FileLock.withLock(STORE_LOCK_FILE, STORE_LOCK_STALE_MS, STORE_LOCK_RETRY_MS, STORE_LOCK_WAIT_MS, async () => {
      const store = this.readStore()
      const idx = store.items.findIndex((item) => item.id === id)
      if (idx === -1) return false
      store.items.splice(idx, 1)
      this.writeStore(store)
      return true
    })
  }

  async markDescendantsStale(parentItemId: string): Promise<void> {
    await FileLock.withLock(STORE_LOCK_FILE, STORE_LOCK_STALE_MS, STORE_LOCK_RETRY_MS, STORE_LOCK_WAIT_MS, async () => {
      const store = this.readStore()
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
      let changed = false
      for (const item of store.items) {
        if (!descendants.has(item.id)) continue
        if (!["running", "review_pending", "completed", "blocked"].includes(item.status)) continue
        item.staleDependency = true
        changed = true
      }
      if (changed) this.writeStore(store)
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
          const nextBlockedReason = dependency.blockedReason
          if (item.dependencyBlockedReason !== nextBlockedReason) {
            item.dependencyBlockedReason = nextBlockedReason
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
    await FileLock.withLock(STORE_LOCK_FILE, STORE_LOCK_STALE_MS, STORE_LOCK_RETRY_MS, STORE_LOCK_WAIT_MS, async () => {
      const store = this.readStore()
      let changed = false
      for (const item of store.items) {
        if (item.status === "running") {
          item.status = "pending"
          changed = true
        }
      }
      if (changed) this.writeStore(store)
    })
  }
}

class IdleDetector {
  private timer: ReturnType<typeof setInterval> | null = null
  private getConfig: () => QueueConfig
  private onIdle: () => Promise<void>

  constructor(getConfig: () => QueueConfig, onIdle: () => Promise<void>) {
    this.getConfig = getConfig
    this.onIdle = onIdle
  }

  start(): void {
    this.writeActivity()
    this.timer = setInterval(() => this.checkIdle(), 30_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  writeActivity(): void {
    try {
      if (!existsSync(OPENCODE_DIR)) {
        mkdirSync(OPENCODE_DIR, { recursive: true })
      }
      writeFileSync(LAST_ACTIVITY_FILE, Date.now().toString(), "utf-8")
    } catch {}
  }

  private async checkIdle(): Promise<void> {
    try {
      if (!existsSync(LAST_ACTIVITY_FILE)) {
        await this.onIdle()
        return
      }
      const lastActivity = parseInt(readFileSync(LAST_ACTIVITY_FILE, "utf-8").trim(), 10)
      const elapsed = Date.now() - lastActivity
      if (elapsed >= this.getConfig().idleTimeoutSeconds * 1000) {
        await this.onIdle()
      }
    } catch {}
  }
}

class FileLock {
  static async acquire(lockFile = LOCK_FILE, staleMs = PROCESSING_LOCK_STALE_MS): Promise<boolean> {
    try {
      if (!existsSync(OPENCODE_DIR)) {
        mkdirSync(OPENCODE_DIR, { recursive: true })
      }
      if (existsSync(lockFile)) {
        const stat = statSync(lockFile)
        if (Date.now() - stat.mtimeMs > staleMs) {
          unlinkSync(lockFile)
        } else {
          return false
        }
      }
      writeFileSync(lockFile, `${process.pid}\n${Date.now()}`, "utf-8")
      return true
    } catch {
      return false
    }
  }

  static refresh(lockFile = LOCK_FILE): void {
    try {
      if (!existsSync(OPENCODE_DIR)) {
        mkdirSync(OPENCODE_DIR, { recursive: true })
      }
      writeFileSync(lockFile, `${process.pid}\n${Date.now()}`, "utf-8")
    } catch {}
  }

  static startHeartbeat(lockFile = LOCK_FILE, refreshMs = PROCESSING_LOCK_REFRESH_MS): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      this.refresh(lockFile)
    }, refreshMs)
    timer.unref?.()
    return timer
  }

  static stopHeartbeat(timer: ReturnType<typeof setInterval> | null): void {
    if (timer) {
      clearInterval(timer)
    }
  }

  static release(lockFile = LOCK_FILE): void {
    try {
      if (existsSync(lockFile)) {
        unlinkSync(lockFile)
      }
    } catch {}
  }

  static async withLock<T>(
    lockFile: string,
    staleMs: number,
    retryMs: number,
    timeoutMs: number,
    work: () => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs
    while (!(await this.acquire(lockFile, staleMs))) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring lock: ${lockFile}`)
      }
      await sleep(retryMs)
    }
    try {
      return await work()
    } finally {
      this.release(lockFile)
    }
  }
}

class BlockWatcher {
  private queueManager: QueueManager
  private client: OpencodeClient

  constructor(queueManager: QueueManager, client: OpencodeClient) {
    this.queueManager = queueManager
    this.client = client
  }

  async handleEvent(event: { type: string; properties?: Record<string, unknown> }): Promise<void> {
    if (event.type === "permission.asked") {
      const permission = event.properties as
        | {
            id?: string
            sessionID?: string
            permission?: string
            patterns?: string[]
          }
        | undefined

      if (!permission?.sessionID) return
      const item = this.queueManager
        .listItems("running")
        .find((candidate) => candidate.sessionId === permission.sessionID)
      if (!item) return

      const patterns = Array.isArray(permission.patterns) ? permission.patterns : []
      const details = [permission.permission, patterns.length > 0 ? `Patterns: ${patterns.join(", ")}` : null]
        .filter(Boolean)
        .join(" | ")

      await this.queueManager.updateItem(item.id, {
        status: "blocked",
        blockedReason: {
          type: "permission",
          permissionId: typeof permission.id === "string" ? permission.id : null,
          requestId: typeof permission.id === "string" ? permission.id : null,
          details: details || "Permission request pending",
          options: ["once", "always", "reject"],
          userResponse: null,
        },
      })
      return
    }

    if (event.type === "question.asked") {
      const question = event.properties as
        | {
            id?: string
            sessionID?: string
            questions?: Array<{
              question?: string
              options?: Array<{ label?: string }>
            }>
          }
        | undefined

      if (!question?.sessionID) return
      const item = this.queueManager
        .listItems("running")
        .find((candidate) => candidate.sessionId === question.sessionID)
      if (!item) return

      const questions = Array.isArray(question.questions) ? question.questions : []
      const details = questions
        .map((entry) => entry.question)
        .filter((entry): entry is string => Boolean(entry))
        .join(" | ")
      const options = questions.flatMap((entry) =>
        Array.isArray(entry.options)
          ? entry.options
              .map((option) => option.label)
              .filter((label): label is string => Boolean(label))
          : [],
      )

      await this.queueManager.updateItem(item.id, {
        status: "blocked",
        blockedReason: {
          type: "question",
          permissionId: null,
          requestId: typeof question.id === "string" ? question.id : null,
          details: details || "Question pending",
          options: options.length > 0 ? options : null,
          userResponse: null,
        },
      })
    }
  }

  async checkForBlocks(item: QueueItem): Promise<boolean> {
    if (!item.sessionId) return false
    if (item.status === "blocked") return true
    const q = { directory: item.workspace }

    try {
      const { data: messages } = await this.client.session.messages({
        path: { id: item.sessionId! },
        query: q,
      })
      if (!messages) return false

      for (const msg of messages) {
        for (const part of msg.parts) {
          if (
            part.type === "tool" &&
            part.tool === "question" &&
            part.state.status === "pending"
          ) {
            const input = part.state.input as Record<string, unknown>
            await this.queueManager.updateItem(item.id, {
              status: "blocked",
              blockedReason: {
                type: "question",
                permissionId: null,
                requestId: null,
                details: String(input.text || input.message || input.question || JSON.stringify(input)),
                options: Array.isArray(input.options) ? input.options.map(String) : null,
                userResponse: null,
              },
            })
            return true
          }
        }
      }

      const { data: statusMap } = await this.client.session.status({ query: q })
      if (statusMap) {
        for (const [, sessionStatus] of Object.entries(statusMap)) {
          if (sessionStatus?.type === "idle") {
            return false
          }
        }
      }
    } catch {}

    return false
  }

  async respondToBlock(item: QueueItem, response: string): Promise<boolean> {
    if (!item.blockedReason || !item.sessionId) return false
    const q = { directory: item.workspace }

    try {
      if (item.blockedReason.type === "permission" && item.blockedReason.permissionId) {
        const normalized = response.toLowerCase()
        const allowAlways = normalized === "always"
        const allowOnce = normalized === "yes" || normalized === "allow" || normalized === "once"
        const reject = normalized === "no" || normalized === "reject"
        await this.client.postSessionIdPermissionsPermissionId({
          path: { id: item.sessionId!, permissionID: item.blockedReason.permissionId },
          body: { response: reject ? "reject" : allowAlways ? "always" : allowOnce ? "once" : "once" },
          query: q,
        })
      } else {
        await this.client.session.prompt({
          path: { id: item.sessionId! },
          query: q,
          body: {
            parts: [{ type: "text", text: response }],
          },
        })
      }

      await this.queueManager.updateItem(item.id, {
        status: "pending",
        blockedReason: {
          ...item.blockedReason,
          userResponse: response,
        },
      })
      return true
    } catch {
      return false
    }
  }
}

class QueueProcessor {
  private isProcessing = false
  private blockWatcher: BlockWatcher
  private queueManager: QueueManager
  private client: OpencodeClient
  private idleDetector: IdleDetector
  private serverUrl: URL

  constructor(queueManager: QueueManager, client: OpencodeClient, idleDetector: IdleDetector, serverUrl: URL) {
    this.queueManager = queueManager
    this.client = client
    this.idleDetector = idleDetector
    this.serverUrl = serverUrl
    this.blockWatcher = new BlockWatcher(queueManager, client)
  }

  async processNext(): Promise<boolean> {
    if (this.isProcessing) return false
    const item = await this.queueManager.getNextPending()
    if (!item) return false

    this.isProcessing = true
    try {
      if (!existsSync(item.workspace)) {
        await this.queueManager.updateItem(item.id, {
          status: "failed",
          error: `Directory not found: ${item.workspace}`,
          completedAt: new Date().toISOString(),
        })
        this.isProcessing = false
        return true
      }

      const q = { directory: item.workspace }

      let sessionId = item.sessionId
      if (!sessionId) {
        const { data: session } = await this.client.session.create({
          query: q,
          body: { title: item.goal.substring(0, 100) },
        })
        if (!session) {
          await this.queueManager.updateItem(item.id, {
            status: "failed",
            error: "Failed to create session",
          })
          this.isProcessing = false
          return true
        }
        sessionId = session.id
        await this.queueManager.updateItem(item.id, {
          sessionId: session.id,
          sessionUrl: new URL(`/session/${session.id}`, this.serverUrl).toString(),
          startedAt: new Date().toISOString(),
          status: "running",
        })
      } else {
        await this.queueManager.updateItem(item.id, { status: "running" })
      }

      await this.client.session.promptAsync({
        path: { id: sessionId! },
        query: q,
        body: {
          parts: [{ type: "text", text: item.goal }],
        },
      })

      await this.waitForCompletion(item.id, sessionId!, q)

      return true
    } catch (err) {
      this.handleSessionError(item.id, err)
      return true
    } finally {
      this.isProcessing = false
    }
  }

  async continueSession(itemId: string, sessionId: string, workspace: string): Promise<void> {
    await this.waitForCompletion(itemId, sessionId, { directory: workspace })
  }

  private async waitForCompletion(itemId: string, sessionId: string, q: { directory: string }): Promise<void> {
    const maxWaitMs = 30 * 60 * 1000
    const pollIntervalMs = 5_000
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      const blocked = await this.blockWatcher.checkForBlocks(
        this.queueManager.getItem(itemId)!,
      )
      if (blocked) return

      const { data: statusMap } = await this.client.session.status({ query: q })
      if (statusMap && statusMap[sessionId]) {
        const status = statusMap[sessionId]
        if (status.type === "idle") {
          await this.captureResult(itemId, sessionId, q)
          return
        }
        if (status.type === "retry" && status.next) {
          await new Promise((r) => setTimeout(r, Math.min(status.next - Date.now(), pollIntervalMs)))
          continue
        }
      } else if (statusMap && !statusMap[sessionId]) {
        // This server only reports non-idle sessions in session.status().
        // Treat the missing entry as completion only after the session has
        // produced at least one assistant message.
        const { data: messages } = await this.client.session.messages({
          path: { id: sessionId },
          query: q,
        })
        const hasAssistantMessage = Boolean(messages?.some((message) => message.info.role === "assistant"))
        if (hasAssistantMessage) {
          await this.captureResult(itemId, sessionId, q)
          return
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs))
    }

    await this.queueManager.updateItem(itemId, {
      status: "failed",
      error: "Session timed out after 30 minutes",
      completedAt: new Date().toISOString(),
    })
  }

  private async captureResult(itemId: string, sessionId: string, q: { directory: string }): Promise<void> {
    try {
      const { data: messages } = await this.client.session.messages({
        path: { id: sessionId },
        query: q,
      })
      let result = "Task completed"
      if (messages && messages.length > 0) {
        const lastAssistant = [...messages].reverse().find((m) => m.info.role === "assistant")
        if (lastAssistant) {
          const textParts = lastAssistant.parts.filter((p) => p.type === "text")
          if (textParts.length > 0) {
            result = textParts.map((p) => (p as { type: "text"; text: string }).text).join("\n").substring(0, 1000)
          }
        }
      }
      await this.queueManager.updateItem(itemId, {
        status: "review_pending",
        result,
        completedAt: null,
        reviewedAt: null,
        retryCount: 0,
      })
    } catch {
      await this.queueManager.updateItem(itemId, {
        status: "review_pending",
        result: "Task completed (could not fetch result)",
        completedAt: null,
        reviewedAt: null,
        retryCount: 0,
      })
    }
  }

  private handleSessionError(itemId: string, err: unknown): void {
    const item = this.queueManager.getItem(itemId)
    if (!item) return

    const config = this.queueManager.getConfig()
    const newRetryCount = item.retryCount + 1

    if (newRetryCount >= config.maxRetries) {
      void this.queueManager.updateItem(itemId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        retryCount: newRetryCount,
        completedAt: new Date().toISOString(),
      })
      return
    }

    const delayMinutes = config.retryDelaysMinutes[newRetryCount - 1] || 15
    void this.queueManager.updateItem(itemId, {
      status: "running",
      retryCount: newRetryCount,
      nextRetryAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
      error: err instanceof Error ? err.message : String(err),
    })
  }

  async processQueue(): Promise<void> {
    if (!(await FileLock.acquire(LOCK_FILE, PROCESSING_LOCK_STALE_MS))) return
    const heartbeat = FileLock.startHeartbeat(LOCK_FILE, PROCESSING_LOCK_REFRESH_MS)
    try {
      let hasMore = true
      while (hasMore) {
        const processed = await this.processNext()
        if (!processed) {
          hasMore = false
          continue
        }

        const lastActivity = (() => {
          try {
            return parseInt(readFileSync(LAST_ACTIVITY_FILE, "utf-8").trim(), 10)
          } catch {
            return 0
          }
        })()
        const stillIdle = Date.now() - lastActivity >= this.queueManager.getConfig().idleTimeoutSeconds * 1000
        if (!stillIdle) {
          hasMore = false
        }
      }
    } finally {
      FileLock.stopHeartbeat(heartbeat)
      FileLock.release(LOCK_FILE)
    }
  }

  getBlockWatcher(): BlockWatcher {
    return this.blockWatcher
  }
}

class SessionGreeter {
  private messageCounts: Map<string, number> = new Map()
  private getConfig: () => QueueConfig
  private queueManager: QueueManager
  private client: OpencodeClient

  constructor(getConfig: () => QueueConfig, queueManager: QueueManager, client: OpencodeClient) {
    this.getConfig = getConfig
    this.queueManager = queueManager
    this.client = client
  }

  async onSessionCreated(): Promise<void> {
    this.showToast()
  }

  async onMessageUpdated(sessionId: string): Promise<void> {
    const count = (this.messageCounts.get(sessionId) || 0) + 1
    this.messageCounts.set(sessionId, count)
    if (count >= this.getConfig().reminderIntervalMessages) {
      this.messageCounts.set(sessionId, 0)
      this.showToast()
    }
  }

  private showToast(): void {
    const counts = this.queueManager.countByStatus()
    const pending = counts["pending"] || 0
    const blocked = counts["blocked"] || 0
    const reviewPending = counts["review_pending"] || 0
    const completed = counts["completed"] || 0
    const running = counts["running"] || 0
    const failed = counts["failed"] || 0

    const total = pending + blocked + reviewPending + completed + running + failed
    if (total === 0) return

    const parts: string[] = []
    if (pending > 0) parts.push(`${pending} pending`)
    if (blocked > 0) parts.push(`${blocked} blocked`)
    if (reviewPending > 0) parts.push(`${reviewPending} review`)
    if (running > 0) parts.push(`${running} running`)
    if (completed > 0) parts.push(`${completed} completed`)
    if (failed > 0) parts.push(`${failed} failed`)

    safeToast(this.client, `Queue: ${parts.join(", ")}`, blocked > 0 ? "warning" : "info")
  }
}

const SHARED_STATE_KEY = Symbol.for("opencode.queue.shared-state")

interface SharedState {
  queueManager: QueueManager
  idleDetector: IdleDetector
  coordinatorClaimed: boolean
  initialized: Promise<void>
  cleanupHandlers: Array<{
    event: "exit" | "beforeExit" | NodeJS.Signals
    handler: () => void
  }>
  cleanedUp: boolean
}

function createSharedState(client: OpencodeClient, serverUrl: URL): SharedState {
  const queueManager = new QueueManager()
  const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {
    const processor = new QueueProcessor(queueManager, client, idleDetector, serverUrl)
    await processor.processQueue()
  })

  return {
    queueManager,
    idleDetector,
    coordinatorClaimed: false,
    initialized: queueManager.resetRunningToPending(),
    cleanupHandlers: [],
    cleanedUp: false,
  }
}

function cleanupSharedState(shared: SharedState): void {
  if (shared.cleanedUp) return
  shared.cleanedUp = true
  shared.idleDetector.stop()
  FileLock.release(LOCK_FILE)
}

function registerProcessCleanup(shared: SharedState): void {
  if (shared.cleanupHandlers.length > 0) return

  const onExit = () => {
    cleanupSharedState(shared)
  }
  const onBeforeExit = () => {
    cleanupSharedState(shared)
  }
  const registerSignalHandler = (signal: "SIGINT" | "SIGTERM") => {
    const handler = () => {
      cleanupSharedState(shared)
      process.exit(SIGNAL_EXIT_CODE[signal] ?? 0)
    }
    process.once(signal, handler)
    shared.cleanupHandlers.push({ event: signal, handler })
  }

  process.once("exit", onExit)
  shared.cleanupHandlers.push({ event: "exit", handler: onExit })
  process.once("beforeExit", onBeforeExit)
  shared.cleanupHandlers.push({ event: "beforeExit", handler: onBeforeExit })
  registerSignalHandler("SIGINT")
  registerSignalHandler("SIGTERM")
}

function unregisterProcessCleanup(shared: SharedState): void {
  for (const { event, handler } of shared.cleanupHandlers) {
    process.removeListener(event, handler)
  }
  shared.cleanupHandlers = []
}

function getSharedState(client: OpencodeClient, serverUrl: URL): SharedState {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_STATE_KEY]?: SharedState
  }
  if (!globalState[SHARED_STATE_KEY]) {
    globalState[SHARED_STATE_KEY] = createSharedState(client, serverUrl)
  }
  return globalState[SHARED_STATE_KEY]
}

function resetSharedState(): void {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_STATE_KEY]?: SharedState
  }
  if (globalState[SHARED_STATE_KEY]) {
    unregisterProcessCleanup(globalState[SHARED_STATE_KEY]!)
    cleanupSharedState(globalState[SHARED_STATE_KEY]!)
  }
  delete globalState[SHARED_STATE_KEY]
}

function findQueueItem(queueManager: QueueManager, itemId: string): QueueItem | undefined {
  return queueManager.getItem(itemId) || queueManager.listItems().find((item) => item.id.startsWith(itemId))
}

function formatQueueItemSummary(item: QueueItem): string {
  let line = `[${item.status.toUpperCase()}] ${item.id.substring(0, 8)} ${item.goal.substring(0, 80)}`
  if (item.parentItemId) {
    line += `\nDepends: ${item.parentItemId.substring(0, 8)} @ ${item.dependencyMode}`
  }
  if (item.dependencyBlockedReason && item.status === "pending") {
    line += `\nWaiting: ${item.dependencyBlockedReason.substring(0, 160)}`
  }
  if (item.staleDependency) {
    line += `\nStale: Parent changed after this item became eligible`
  }
  if (item.status === "blocked" && item.blockedReason) {
    line += `\nBlocked: ${item.blockedReason.details.substring(0, 160)}`
  }
  if (item.status === "review_pending" && item.result) {
    line += `\nReview: ${item.result.substring(0, 160)}`
  }
  if (item.status === "completed" && item.result) {
    line += `\nResult: ${item.result.substring(0, 160)}`
  }
  if (item.status === "failed" && item.error) {
    line += `\nError: ${item.error.substring(0, 160)}`
  }
  return line
}

function formatQueueItemFull(item: QueueItem): string {
  let output = `ID: ${item.id}\nStatus: ${item.status}\nGoal: ${item.goal}\nWorkspace: ${item.workspace}`
  if (item.parentItemId) output += `\nParent: ${item.parentItemId}`
  output += `\nDependency Mode: ${item.dependencyMode}`
  if (item.dependencySatisfiedAt) output += `\nDependency Satisfied: ${item.dependencySatisfiedAt}`
  if (item.dependencySourceStatus) output += `\nDependency Source: ${item.dependencySourceStatus}`
  if (item.dependencyBlockedReason) output += `\nDependency Waiting: ${item.dependencyBlockedReason}`
  if (item.staleDependency) output += `\nStale Dependency: true`
  output += `\nCreated: ${item.createdAt}`
  if (item.startedAt) output += `\nStarted: ${item.startedAt}`
  if (item.completedAt) output += `\nCompleted: ${item.completedAt}`
  if (item.reviewedAt) output += `\nReviewed: ${item.reviewedAt}`
  if (item.sessionId) output += `\nSession: ${item.sessionId}`
  if (item.sessionUrl) output += `\nURL: ${item.sessionUrl}`
  if (item.retryCount > 0) output += `\nRetries: ${item.retryCount}`
  if (item.nextRetryAt) output += `\nNext Retry: ${item.nextRetryAt}`
  if (item.blockedReason) output += `\nBlocked (${item.blockedReason.type}): ${item.blockedReason.details}`
  if (item.status === "review_pending" && item.result) output += `\nReview Result: ${item.result}`
  else if (item.result) output += `\nResult: ${item.result}`
  if (item.error) output += `\nError: ${item.error}`
  return output
}

async function formatQueueItemLog(client: OpencodeClient, item: QueueItem): Promise<string> {
  if (!item.sessionId) return `No session for item ${item.id}.`

  let output = `Session: ${item.sessionId}\nURL: ${item.sessionUrl || "N/A"}`
  try {
    const { data: messages } = await client.session.messages({
      path: { id: item.sessionId },
      query: { directory: item.workspace },
    })
    if (!messages || messages.length === 0) {
      return `${output}\n\n(No messages)`
    }

    const lines: string[] = []
    for (const msg of messages.slice(-4)) {
      const role = msg.info.role
      const textParts = msg.parts.filter((part) => part.type === "text")
      for (const part of textParts) {
        const text = (part as { type: "text"; text: string }).text
        lines.push(`[${role}] ${text.substring(0, 300)}`)
      }
    }
    return lines.length > 0 ? `${output}\n\n${lines.join("\n\n")}` : `${output}\n\n(No text messages)`
  } catch {
    return `${output}\n\n(Could not fetch messages)`
  }
}

const OpencodeQueuePlugin: Plugin = async (ctx) => {
  const client = ctx.client
  const shared = getSharedState(client, ctx.serverUrl)
  await shared.initialized
  shared.cleanedUp = false
  const { queueManager, idleDetector } = shared
  const isCoordinator = !shared.coordinatorClaimed
  if (isCoordinator) {
    shared.coordinatorClaimed = true
    registerProcessCleanup(shared)
    idleDetector.start()
  }

  const greeter = new SessionGreeter(() => queueManager.getConfig(), queueManager, client)
  const blockWatcher = new BlockWatcher(queueManager, client)

  if (isCoordinator) {
    safeToast(client, "opencode-queue loaded", "info", 3000)
  }

  const hooks: Awaited<ReturnType<Plugin>> = {
    "chat.message": async () => {
      idleDetector.writeActivity()
    },
    "tool.execute.before": async () => {
      idleDetector.writeActivity()
    },
    "tool.execute.after": async () => {
      idleDetector.writeActivity()
    },
    tool: {
      "queue-list": tool({
        description: "Show queue items or one item in summary, full, or log view.",
        args: {
          itemId: tool.schema.string().optional().describe("Item ID or prefix"),
          status: tool.schema.enum(["pending", "running", "blocked", "review_pending", "completed", "failed"]).optional().describe("Status filter"),
          view: tool.schema.enum(["summary", "full", "log"]).optional().describe("Output style"),
        },
        async execute(args) {
          if (args.itemId) {
            const item = findQueueItem(queueManager, args.itemId)
            if (!item) return `Error: Item ${args.itemId} not found.`
            switch (args.view) {
              case "log":
                return formatQueueItemLog(client, item)
              case "full":
                return formatQueueItemFull(item)
              default:
                return formatQueueItemSummary(item)
            }
          }

          const items = queueManager.listItems(args.status as string | undefined)
          if (items.length === 0) return "Queue is empty."
          return items.map((item) => formatQueueItemSummary(item)).join("\n\n")
        },
      }),

      "queue-add": tool({
        description: "Add a queue item.",
        args: {
          workspace: tool.schema.string().describe("Absolute workspace path"),
          goal: tool.schema.string().describe("Task goal"),
          parentItemId: tool.schema.string().optional().describe("Parent item ID or prefix"),
          dependencyMode: tool.schema.enum(["review_pending", "completed"]).optional().describe("When parent unlocks this item"),
        },
        async execute(args) {
          let parentId: string | null = null
          if (args.parentItemId) {
            const parent = findQueueItem(queueManager, args.parentItemId)
            if (!parent) return `Error: Parent item ${args.parentItemId} not found.`
            parentId = parent.id
          }
          const result = await queueManager.addItem(args.workspace, args.goal, {
            parentItemId: parentId,
            dependencyMode: args.dependencyMode as "review_pending" | "completed" | undefined,
          })
          if (!("id" in (result as QueueItem | { error: string }))) return `Error: ${(result as { error: string }).error}`
          const item = result as QueueItem
          let output = `Added ${item.id}.\nStatus: ${item.status}\nGoal: ${item.goal}`
          if (item.parentItemId) output += `\nDepends: ${item.parentItemId} @ ${item.dependencyMode}`
          return output
        },
      }),

      "queue-answer": tool({
        description: "Respond to a blocked item.",
        args: {
          itemId: tool.schema.string().describe("Item ID or prefix"),
          response: tool.schema.string().describe("Response text"),
        },
        async execute(args) {
          const item = findQueueItem(queueManager, args.itemId)
          if (!item) return `Error: Item ${args.itemId} not found.`
          if (item.status !== "blocked") return `Error: Item ${item.id} is not blocked (status: ${item.status}).`
          const success = await blockWatcher.respondToBlock(item, args.response)
          if (success) return `Response sent for ${item.id}.`
          return `Error: Failed to send response for item ${item.id}.`
        },
      }),

      "queue-confirm": tool({
        description: "Mark a review item complete.",
        args: {
          itemId: tool.schema.string().describe("Item ID or prefix"),
        },
        async execute(args) {
          const item = findQueueItem(queueManager, args.itemId)
          if (!item) return `Error: Item ${args.itemId} not found.`
          if (item.status !== "review_pending") {
            return `Error: Item ${item.id} is not awaiting review (status: ${item.status}).`
          }
          const now = new Date().toISOString()
          await queueManager.updateItem(item.id, {
            status: "completed",
            completedAt: now,
            reviewedAt: now,
            staleDependency: false,
          })
          return `Item ${item.id} marked completed.`
        },
      }),

      "queue-followup": tool({
        description: "Send follow-up on a review item.",
        args: {
          itemId: tool.schema.string().describe("Item ID or prefix"),
          message: tool.schema.string().describe("Follow-up message"),
        },
        async execute(args) {
          const item = findQueueItem(queueManager, args.itemId)
          if (!item) return `Error: Item ${args.itemId} not found.`
          if (item.status !== "review_pending") {
            return `Error: Item ${item.id} is not awaiting review (status: ${item.status}).`
          }
          if (!item.sessionId) return `Error: Item ${item.id} has no session.`

          try {
            await client.session.prompt({
              path: { id: item.sessionId },
              query: { directory: item.workspace },
              body: {
                parts: [{ type: "text", text: args.message }],
              },
            })
          } catch {
            return `Error: Failed to send follow-up for item ${item.id}.`
          }

          await queueManager.updateItem(item.id, {
            status: "running",
            completedAt: null,
            reviewedAt: null,
            result: null,
          })
          await queueManager.markDescendantsStale(item.id)
          const processor = new QueueProcessor(queueManager, client, idleDetector, ctx.serverUrl)
          await processor.continueSession(item.id, item.sessionId, item.workspace)
          return `Follow-up sent for ${item.id}.`
        },
      }),

      "queue-remove": tool({
        description: "Remove a queue item.",
        args: {
          itemId: tool.schema.string().describe("Item ID or prefix"),
        },
        async execute(args) {
          const item = findQueueItem(queueManager, args.itemId)
          if (!item) return `Error: Item ${args.itemId} not found.`
          const dependents = queueManager.listItems().filter((candidate) => candidate.parentItemId === item.id)
          if (dependents.length > 0) {
            return `Error: Item ${item.id} has dependent tasks and cannot be removed.`
          }
          if (item.sessionId) {
            try {
              await client.session.abort({
                path: { id: item.sessionId },
                query: { directory: item.workspace },
              })
            } catch {}
          }
          const removed = await queueManager.removeItem(item.id)
          return removed ? `Removed item ${item.id}.` : `Error: Could not remove item ${item.id}.`
        },
      }),

      "queue-retry": tool({
        description: "Retry a failed item.",
        args: {
          itemId: tool.schema.string().describe("Item ID or prefix"),
        },
        async execute(args) {
          const item = findQueueItem(queueManager, args.itemId)
          if (!item) return `Error: Item ${args.itemId} not found.`
          if (item.status !== "failed") return `Error: Item ${item.id} is not failed (status: ${item.status}).`
          await queueManager.updateItem(item.id, {
            status: "pending",
            retryCount: 0,
            nextRetryAt: null,
            error: null,
            staleDependency: false,
          })
          return `Item ${item.id} reset to pending.`
        },
      }),
    },
  }

  if (isCoordinator) {
    hooks.event = async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      try {
        await blockWatcher.handleEvent(event)
        switch (event.type) {
          case "session.created":
            await greeter.onSessionCreated()
            break
          case "session.updated":
          case "command.executed":
          case "tui.command.execute":
          case "permission.replied":
          case "question.replied":
          case "question.rejected":
            idleDetector.writeActivity()
            break
          case "message.updated": {
            idleDetector.writeActivity()
            const info = event.properties?.info as { sessionID?: string } | undefined
            if (info?.sessionID) {
              await greeter.onMessageUpdated(info.sessionID)
            }
            break
          }
          case "session.idle":
            break
        }
      } catch {}
    }
  }

  return hooks
}

function safeToast(
  client: OpencodeClient,
  message: string,
  variant: "info" | "success" | "warning" | "error",
  duration?: number,
): void {
  void client.tui
    .showToast({
      body: {
        message,
        variant,
        duration,
      },
    })
    .catch(() => {})
}

const internals = {
  QueueManager,
  IdleDetector,
  FileLock,
  QueueProcessor,
  BlockWatcher,
  SessionGreeter,
  resetSharedState,
}

export type { QueueConfig, QueueItem, QueueStore, BlockedReason }
export default Object.assign(OpencodeQueuePlugin, {
  __internals: internals,
})
