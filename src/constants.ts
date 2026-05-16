import { join } from "path"
import type { QueueConfig } from "./types.js"

export const CONFIG_DIR = process.env.XDG_CONFIG_HOME || join(process.env.HOME!, ".config")
export const OPENCODE_DIR = join(CONFIG_DIR, "opencode")
export const QUEUE_FILE = join(OPENCODE_DIR, "queue.json")
export const QUEUE_CORRUPTION_MARKER_FILE = join(OPENCODE_DIR, "queue.json.corrupt")
export const LAST_ACTIVITY_FILE = join(OPENCODE_DIR, "queue.last-activity")
export const LOCK_FILE = join(OPENCODE_DIR, "queue.lock")
export const STORE_LOCK_FILE = join(OPENCODE_DIR, "queue.store.lock")

export const PROCESSING_LOCK_STALE_MS = 120_000
export const PROCESSING_LOCK_REFRESH_MS = 30_000
export const STORE_LOCK_STALE_MS = 15_000
export const STORE_LOCK_RETRY_MS = 50
export const STORE_LOCK_WAIT_MS = 5_000

export const SIGNAL_EXIT_CODE: Record<"SIGINT" | "SIGTERM", number> = {
  SIGINT: 130,
  SIGTERM: 143,
}

export const DEFAULT_CONFIG: QueueConfig = {
  idleTimeoutSeconds: 3600,
  blockedReminderMinutes: 30,
  maxRetries: 3,
  retryDelaysMinutes: [5, 10, 15],
  reminderIntervalMessages: 30,
}
