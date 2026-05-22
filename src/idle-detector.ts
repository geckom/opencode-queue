import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { LAST_ACTIVITY_FILE, OPENCODE_DIR } from "./constants.js"
import type { QueueConfig } from "./types.js"

/**
 * IdleDetector is intentionally filesystem-backed so all plugin instances share
 * the same notion of activity.
 */
export class IdleDetector {
  private timer: ReturnType<typeof setInterval> | null = null
  private getConfig: () => QueueConfig
  private onIdle: () => Promise<void>

  constructor(getConfig: () => QueueConfig, onIdle: () => Promise<void>) {
    this.getConfig = getConfig
    this.onIdle = onIdle
  }

  start(): void {
    this.writeActivity()
    this.timer = setInterval(() => void this.checkIdle(), 30_000)
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

  isIdle(): boolean {
    try {
      if (!existsSync(LAST_ACTIVITY_FILE)) return true
      const lastActivity = Number.parseInt(readFileSync(LAST_ACTIVITY_FILE, "utf-8").trim(), 10)
      if (Number.isNaN(lastActivity)) return false
      return Date.now() - lastActivity >= this.getConfig().idleTimeoutSeconds * 1000
    } catch {
      return false
    }
  }

  async checkIdle(): Promise<void> {
    try {
      if (this.isIdle()) {
        await this.onIdle()
      }
    } catch {}
  }
}
