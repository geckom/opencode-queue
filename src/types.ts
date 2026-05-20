/**
 * Core queue domain types shared across the plugin runtime and tests.
 * Keep status and dependency unions centralized so behavior stays explicit.
 */

export type QueueItemStatus =
  | "pending"
  | "running"
  | "blocked"
  | "review_pending"
  | "completed"
  | "failed"

export type DependencyMode = "review_pending" | "completed"
export type DependencySourceStatus = "review_pending" | "completed" | null

export interface QueueConfig {
  idleTimeoutSeconds: number
  blockedReminderMinutes: number
  maxRetries: number
  retryDelaysMinutes: number[]
  reminderIntervalMessages: number
  sessionTimeoutMinutes: number
}

export interface BlockedReason {
  type: "permission" | "question"
  permissionId: string | null
  requestId?: string | null
  details: string
  options: string[] | null
  userResponse: string | null
}

/**
 * Queue items represent both runnable work and review state. Dependencies are
 * stored directly on items so scheduling and processing can resolve eligibility
 * from persisted state only.
 */
export interface QueueItem {
  id: string
  workspace: string
  goal: string
  status: QueueItemStatus
  parentItemId: string | null
  dependencyMode: DependencyMode
  dependencySatisfiedAt: string | null
  dependencySourceStatus: DependencySourceStatus
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
  followupMessage?: string | null
  sourceScheduleId: string | null
}

export interface ScheduledTask {
  id: string
  workspace: string
  goal: string
  scheduledFor: string | null
  cronExpression: string | null
  timezone: string
  enabled: boolean
  lastTriggeredAt: string | null
  nextTriggerAt: string | null
  occurrenceCount: number
  maxOccurrences: number | null
  parentItemId: string | null
  dependencyMode: DependencyMode
  createdAt: string
}

export interface QueueStore {
  config: QueueConfig
  items: QueueItem[]
  schedules: ScheduledTask[]
}
