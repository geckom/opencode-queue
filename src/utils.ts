import type { QueueItem, ScheduledTask } from "./types.js"

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createQueueItemFromSchedule(schedule: ScheduledTask, scheduleId: string): QueueItem {
  return {
    id: crypto.randomUUID(),
    workspace: schedule.workspace,
    goal: schedule.goal,
    status: "pending",
    parentItemId: schedule.parentItemId,
    dependencyMode: schedule.dependencyMode,
    dependencySatisfiedAt: null,
    dependencySourceStatus: null,
    dependencyBlockedReason: schedule.parentItemId ? `Waiting for parent ${schedule.parentItemId} to start.` : null,
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
    sourceScheduleId: scheduleId,
  }
}
