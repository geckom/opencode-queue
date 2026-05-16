import { CronJob } from "cron"
import type { QueueManager } from "./queue-manager.js"
import type { ScheduledTask } from "./types.js"

/**
 * ScheduleManager is responsible only for CronJob lifecycle and translating
 * schedule triggers into queue items via QueueManager APIs.
 */
export class ScheduleManager {
  private queueManager: QueueManager
  private jobs: Map<string, CronJob> = new Map()

  constructor(queueManager: QueueManager) {
    this.queueManager = queueManager
  }

  start(): void {
    const schedules = this.queueManager.listSchedules()
    for (const schedule of schedules) {
      if (schedule.enabled) this.startJob(schedule)
    }
  }

  stop(): void {
    for (const [id, job] of this.jobs) {
      job.stop()
      this.jobs.delete(id)
    }
  }

  private startJob(schedule: ScheduledTask): void {
    if (this.jobs.has(schedule.id)) {
      this.jobs.get(schedule.id)!.stop()
    }

    const onFire = () => void this.onTrigger(schedule.id)

    if (schedule.scheduledFor) {
      const fireDate = new Date(schedule.scheduledFor)
      if (Number.isNaN(fireDate.getTime())) return
      if (fireDate.getTime() <= Date.now()) {
        void this.onTrigger(schedule.id)
        return
      }
      const job = new CronJob(fireDate, onFire, undefined, true, schedule.timezone)
      this.jobs.set(schedule.id, job)
      return
    }

    if (schedule.cronExpression) {
      try {
        const job = new CronJob(schedule.cronExpression, onFire, undefined, true, schedule.timezone)
        this.jobs.set(schedule.id, job)
      } catch {
        // Invalid cron expression. Leave the persisted schedule untouched.
      }
    }
  }

  private async onTrigger(scheduleId: string): Promise<void> {
    const result = await this.queueManager.triggerSchedule(scheduleId)
    if (!result) return

    if (result.schedule.cronExpression && result.schedule.enabled) {
      try {
        const next = new CronJob(result.schedule.cronExpression, () => {}, undefined, true, result.schedule.timezone)
        const nextDate = next.nextDate()
        await this.queueManager.updateSchedule(scheduleId, {
          nextTriggerAt: nextDate ? nextDate.toISO() : null,
        })
        next.stop()
      } catch {
        await this.queueManager.updateSchedule(scheduleId, { nextTriggerAt: null })
      }
    } else if (!result.schedule.enabled) {
      await this.queueManager.updateSchedule(scheduleId, { nextTriggerAt: null })
    }

    if (!result.schedule.enabled && this.jobs.has(scheduleId)) {
      this.jobs.get(scheduleId)!.stop()
      this.jobs.delete(scheduleId)
    }
  }

  async addAndStart(
    schedule: Omit<ScheduledTask, "id" | "lastTriggeredAt" | "nextTriggerAt" | "occurrenceCount" | "createdAt">,
  ): Promise<ScheduledTask> {
    const task = await this.queueManager.addSchedule(schedule)

    if (task.cronExpression) {
      try {
        const job = new CronJob(task.cronExpression, () => {}, undefined, true, task.timezone)
        const nextDate = job.nextDate()
        await this.queueManager.updateSchedule(task.id, {
          nextTriggerAt: nextDate ? nextDate.toISO() : null,
        })
        job.stop()
      } catch {}
    } else if (task.scheduledFor) {
      await this.queueManager.updateSchedule(task.id, { nextTriggerAt: task.scheduledFor })
    }

    const updated = this.queueManager.getSchedule(task.id)!
    if (updated.enabled) this.startJob(updated)
    return updated
  }

  async removeAndStop(id: string): Promise<boolean> {
    const job = this.jobs.get(id)
    if (job) {
      job.stop()
      this.jobs.delete(id)
    }
    return this.queueManager.removeSchedule(id)
  }

  async pause(id: string): Promise<ScheduledTask | undefined> {
    const job = this.jobs.get(id)
    if (job) {
      job.stop()
      this.jobs.delete(id)
    }
    return this.queueManager.updateSchedule(id, { enabled: false, nextTriggerAt: null })
  }

  async resume(id: string): Promise<ScheduledTask | undefined> {
    const updated = await this.queueManager.updateSchedule(id, { enabled: true })
    if (!updated) return updated

    if (updated.cronExpression) {
      try {
        const job = new CronJob(updated.cronExpression, () => {}, undefined, true, updated.timezone)
        const nextDate = job.nextDate()
        job.stop()
        await this.queueManager.updateSchedule(updated.id, {
          nextTriggerAt: nextDate ? nextDate.toISO() : null,
        })
      } catch {
        await this.queueManager.updateSchedule(updated.id, { nextTriggerAt: null })
      }
    } else if (updated.scheduledFor) {
      await this.queueManager.updateSchedule(updated.id, { nextTriggerAt: updated.scheduledFor })
    }

    const resumed = this.queueManager.getSchedule(updated.id)
    if (resumed) this.startJob(resumed)
    return resumed
  }
}
