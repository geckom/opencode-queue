/**
 * File-based locking is the only concurrency primitive used by this plugin.
 * All persisted queue state mutations must flow through this helper.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs"
import { randomUUID } from "crypto"
import {
  CONFIG_DIR,
  LOCK_FILE,
  OPENCODE_DIR,
  PROCESSING_LOCK_REFRESH_MS,
  PROCESSING_LOCK_STALE_MS,
} from "./constants.js"
import { sleep } from "./utils.js"

void CONFIG_DIR

const LOCK_OWNERS = new Map<string, string>()

export class FileLock {
  static isFresh(lockFile = LOCK_FILE, staleMs = PROCESSING_LOCK_STALE_MS): boolean {
    try {
      if (!existsSync(lockFile)) return false
      const stat = statSync(lockFile)
      return Date.now() - stat.mtimeMs <= staleMs
    } catch {
      return false
    }
  }

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
      const owner = `${process.pid}:${randomUUID()}`
      const fd = openSync(lockFile, "wx")
      try {
        writeFileSync(fd, `${owner}\n${Date.now()}`, "utf-8")
      } finally {
        closeSync(fd)
      }
      LOCK_OWNERS.set(lockFile, owner)
      return true
    } catch {
      return false
    }
  }

  static refresh(lockFile = LOCK_FILE): void {
    try {
      const owner = LOCK_OWNERS.get(lockFile)
      if (!owner) return
      if (!existsSync(OPENCODE_DIR)) {
        mkdirSync(OPENCODE_DIR, { recursive: true })
      }
      writeFileSync(lockFile, `${owner}\n${Date.now()}`, "utf-8")
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
      const owner = LOCK_OWNERS.get(lockFile)
      if (!owner) return
      if (existsSync(lockFile)) {
        const currentOwner = readFileSync(lockFile, "utf-8").split("\n", 1)[0]
        if (currentOwner === owner) {
          unlinkSync(lockFile)
        }
      }
    } catch {}
    LOCK_OWNERS.delete(lockFile)
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
