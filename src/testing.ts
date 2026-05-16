/**
 * Dedicated test surface. This keeps runtime bundle exports minimal while
 * preserving compiled-output tests against stable internal modules.
 */

export { BlockWatcher } from "./block-watcher.js"
export { QUEUE_CORRUPTION_MARKER_FILE, QUEUE_FILE } from "./constants.js"
export { FileLock } from "./file-lock.js"
export { IdleDetector } from "./idle-detector.js"
export { QueueProcessor } from "./queue-processor.js"
export { QueueManager } from "./queue-manager.js"
export { ScheduleManager } from "./schedule-manager.js"
export { SessionGreeter } from "./session-greeter.js"
export { resetSharedState } from "./shared-state.js"
export type { BlockedReason, QueueConfig, QueueItem, QueueStore, ScheduledTask } from "./types.js"
