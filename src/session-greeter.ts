import type { OpencodeClient } from "@opencode-ai/sdk"
import type { QueueConfig } from "./types.js"
import { QueueManager } from "./queue-manager.js"

export class SessionGreeter {
  constructor(_getConfig: () => QueueConfig, _queueManager: QueueManager, _client: OpencodeClient) {}

  async onSessionCreated(): Promise<void> {
  }

  startBlockedReminders(): void {
  }

  stop(): void {
  }

  async onMessageUpdated(sessionId: string): Promise<void> {
    void sessionId
  }

  async checkBlockedReminder(): Promise<void> {
  }
}
