import type { OpencodeClient } from "@opencode-ai/sdk"
import type { QueueConfig } from "./types.js"
import { QueueManager } from "./queue-manager.js"
import { safeToast } from "./toast.js"

export class SessionGreeter {
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
    const pending = counts.pending || 0
    const blocked = counts.blocked || 0
    const reviewPending = counts.review_pending || 0
    const completed = counts.completed || 0
    const running = counts.running || 0
    const failed = counts.failed || 0

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
