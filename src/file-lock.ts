/**
 * File-based locking is the only concurrency primitive used by this plugin.
 * All persisted queue state mutations must flow through this helper.
 */

import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "fs"
import {
  CONFIG_DIR,
  LOCK_FILE,
  OPENCODE_DIR,
  PROCESSING_LOCK_REFRESH_MS,
  PROCESSING_LOCK_STALE_MS,
} from "./constants.js"
import { sleep } from "./utils.js"

void CONFIG_DIR

export class FileLock {
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
