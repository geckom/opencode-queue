import type { OpencodeClient } from "@opencode-ai/sdk"
import { existsSync, readFileSync } from "fs"
import { LAST_ACTIVITY_FILE, LOCK_FILE, PROCESSING_LOCK_REFRESH_MS, PROCESSING_LOCK_STALE_MS } from "./constants.js"
import { BlockWatcher } from "./block-watcher.js"
import { FileLock } from "./file-lock.js"
import { IdleDetector } from "./idle-detector.js"
import { QueueManager } from "./queue-manager.js"

/**
 * QueueProcessor is the state machine executor. It owns session creation,
 * completion polling, and retry transitions for a single coordinator.
 */
export class QueueProcessor {
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
      const isFollowup = Boolean(item.followupMessage) && Boolean(item.sessionId)
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
        await this.queueManager.updateItem(item.id, {
          status: "running",
          ...(isFollowup ? { followupMessage: null } : {}),
        })
      }

      if (isFollowup) {
        await this.queueManager.markDescendantsStale(item.id)
      }

      await this.client.session.promptAsync({
        path: { id: sessionId },
        query: q,
        body: {
          parts: [{ type: "text", text: isFollowup ? item.followupMessage! : item.goal }],
        },
      })

      await this.waitForCompletion(item.id, sessionId, q)
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
    try {
      const maxWaitMs = this.queueManager.getConfig().sessionTimeoutMinutes * 60 * 1000
      const pollIntervalMs = 5_000
      const startTime = Date.now()

      while (Date.now() - startTime < maxWaitMs) {
        const item = this.queueManager.getItem(itemId)
        if (!item) return

        const blocked = await this.blockWatcher.checkForBlocks(item)
        if (blocked) return

        const { data: statusMap } = await this.client.session.status({ query: q })
        if (statusMap && statusMap[sessionId]) {
          const status = statusMap[sessionId]
          if (status.type === "idle") {
            await this.captureResult(itemId, sessionId, q)
            return
          }
          if (status.type === "retry" && status.next) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(status.next - Date.now(), pollIntervalMs)))
            continue
          }
        } else if (statusMap && !statusMap[sessionId]) {
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

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
      }

      await this.queueManager.updateItem(itemId, {
        status: "failed",
        error: "Session timed out",
        completedAt: new Date().toISOString(),
      })
    } catch (err) {
      this.queueManager.updateItem(itemId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        completedAt: new Date().toISOString(),
      })
    }
  }

  private async captureResult(itemId: string, sessionId: string, q: { directory: string }): Promise<void> {
    try {
      const { data: messages } = await this.client.session.messages({
        path: { id: sessionId },
        query: q,
      })
      let result = "Task completed"
      if (messages && messages.length > 0) {
        const lastAssistant = [...messages].reverse().find((message) => message.info.role === "assistant")
        if (lastAssistant) {
          const textParts = lastAssistant.parts.filter((part) => part.type === "text")
          if (textParts.length > 0) {
            result = textParts.map((part) => (part as { type: "text"; text: string }).text).join("\n").substring(0, 1000)
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
            return Number.parseInt(readFileSync(LAST_ACTIVITY_FILE, "utf-8").trim(), 10)
          } catch {
            return 0
          }
        })()
        const stillIdle = Date.now() - lastActivity >= this.queueManager.getConfig().idleTimeoutSeconds * 1000
        if (!stillIdle) hasMore = false
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
