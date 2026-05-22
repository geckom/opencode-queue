import type { OpencodeClient } from "@opencode-ai/sdk"
import type { BlockedReason, QueueItem } from "./types.js"
import { QueueManager } from "./queue-manager.js"
import { safeToast } from "./toast.js"

export class BlockWatcher {
  private queueManager: QueueManager
  private client: OpencodeClient

  constructor(queueManager: QueueManager, client: OpencodeClient) {
    this.queueManager = queueManager
    this.client = client
  }

  async handleEvent(event: { type: string; properties?: Record<string, unknown> }): Promise<void> {
    if (event.type === "permission.updated" || event.type === "permission.asked") {
      const permission = event.properties as
        | {
            id?: string
            sessionID?: string
            type?: string
            title?: string
            pattern?: string | string[]
            permission?: string
            patterns?: string[]
          }
        | undefined

      if (!permission?.sessionID) return
      const item = this.queueManager.listItems("running").find((candidate) => candidate.sessionId === permission.sessionID)
      if (!item) return

      const patternValues = Array.isArray(permission.pattern)
        ? permission.pattern
        : typeof permission.pattern === "string"
          ? [permission.pattern]
          : Array.isArray(permission.patterns)
            ? permission.patterns
            : []
      const details = [
        permission.title || permission.permission || permission.type,
        patternValues.length > 0 ? `Patterns: ${patternValues.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" | ")

      await this.blockItem(item.id, {
        type: "permission",
        permissionId: typeof permission.id === "string" ? permission.id : null,
        requestId: typeof permission.id === "string" ? permission.id : null,
        details: details || "Permission request pending",
        options: ["once", "always", "reject"],
        userResponse: null,
      })
      return
    }

    if (event.type === "question.asked") {
      const question = event.properties as
        | {
            id?: string
            sessionID?: string
            questions?: Array<{
              question?: string
              options?: Array<{ label?: string }>
            }>
          }
        | undefined

      if (!question?.sessionID) return
      const item = this.queueManager.listItems("running").find((candidate) => candidate.sessionId === question.sessionID)
      if (!item) return

      const questions = Array.isArray(question.questions) ? question.questions : []
      const details = questions
        .map((entry) => entry.question)
        .filter((entry): entry is string => Boolean(entry))
        .join(" | ")
      const options = questions.flatMap((entry) =>
        Array.isArray(entry.options)
          ? entry.options.map((option) => option.label).filter((label): label is string => Boolean(label))
          : [],
      )

      await this.blockItem(item.id, {
        type: "question",
        permissionId: null,
        requestId: typeof question.id === "string" ? question.id : null,
        details: details || "Question pending",
        options: options.length > 0 ? options : null,
        userResponse: null,
      })
    }
  }

  async checkForBlocks(item: QueueItem): Promise<boolean> {
    if (!item.sessionId) return false
    if (item.status === "blocked") return true
    const q = { directory: item.workspace }

    try {
      const { data: messages } = await this.client.session.messages({
        path: { id: item.sessionId },
        query: q,
      })
      if (!messages) return false

      for (const msg of messages) {
        for (const part of msg.parts) {
          if (part.type === "tool" && part.tool === "question" && part.state.status === "pending") {
            const input = part.state.input as Record<string, unknown>
            await this.blockItem(item.id, {
              type: "question",
              permissionId: null,
              requestId: null,
              details: String(input.text || input.message || input.question || JSON.stringify(input)),
              options: Array.isArray(input.options) ? input.options.map(String) : null,
              userResponse: null,
            })
            return true
          }
        }
      }

      const { data: statusMap } = await this.client.session.status({ query: q })
      if (statusMap) {
        for (const [, sessionStatus] of Object.entries(statusMap)) {
          if (sessionStatus?.type === "idle") {
            return false
          }
        }
      }
    } catch {}

    return false
  }

  private async blockItem(itemId: string, blockedReason: BlockedReason): Promise<void> {
    await this.queueManager.updateItem(itemId, {
      status: "blocked",
      blockedReason,
    })
    this.showBlockedToast(itemId)
  }

  private showBlockedToast(itemId: string): void {
    const item = this.queueManager.getItem(itemId)
    if (!item?.blockedReason) return
    safeToast(
      this.client,
      `Queue item blocked: ${item.blockedReason.details.substring(0, 120)}`,
      "warning",
    )
  }

  async respondToBlock(item: QueueItem, response: string): Promise<boolean> {
    if (!item.blockedReason || !item.sessionId) return false
    const q = { directory: item.workspace }

    try {
      if (item.blockedReason.type === "permission" && item.blockedReason.permissionId) {
        const normalized = response.toLowerCase()
        const allowAlways = normalized === "always"
        const allowOnce = normalized === "yes" || normalized === "allow" || normalized === "once"
        const reject = normalized === "no" || normalized === "reject"
        await this.client.postSessionIdPermissionsPermissionId({
          path: { id: item.sessionId, permissionID: item.blockedReason.permissionId },
          body: { response: reject ? "reject" : allowAlways ? "always" : allowOnce ? "once" : "once" },
          query: q,
        })
      } else {
        await this.client.session.prompt({
          path: { id: item.sessionId },
          query: q,
          body: {
            parts: [{ type: "text", text: response }],
          },
        })
      }

      return true
    } catch {
      return false
    }
  }
}
