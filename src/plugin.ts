import type { OpencodeClient } from "@opencode-ai/sdk"
import { tool, type Plugin } from "@opencode-ai/plugin"
import { existsSync, statSync } from "fs"
import { resolve } from "path"
import { BlockWatcher } from "./block-watcher.js"
import { formatQueueItemFull, formatQueueItemLog, formatQueueItemSummary, formatScheduledTask } from "./formatters.js"
import { IdleDetector } from "./idle-detector.js"
import { QueueProcessor } from "./queue-processor.js"
import { QueueManager } from "./queue-manager.js"
import { SessionGreeter } from "./session-greeter.js"
import { getSharedState } from "./shared-state.js"
import { safeToast } from "./toast.js"
import type { QueueItem } from "./types.js"

function findQueueItem(queueManager: QueueManager, itemId: string): QueueItem | undefined {
  return queueManager.getItem(itemId) || queueManager.listItems().find((item) => item.id.startsWith(itemId))
}

function findItemBySession(queueManager: QueueManager, sessionId: string): QueueItem | undefined {
  return queueManager.listItems().find((item) => item.sessionId === sessionId)
}

/**
 * OpenCode loads exported plugin functions from the module, so the runtime
 * entrypoint must remain minimal even though the source is internally modular.
 */
export const OpencodeQueuePlugin: Plugin = async (ctx) => {
  const client = ctx.client
  const shared = getSharedState(client, ctx.serverUrl)
  await shared.initialized
  shared.cleanedUp = false
  const { queueManager, idleDetector } = shared
  const isCoordinator = !shared.coordinatorClaimed
  if (isCoordinator) {
    shared.coordinatorClaimed = true
    const { registerProcessCleanup } = await import("./shared-state.js")
    registerProcessCleanup(shared)
    idleDetector.start()
    shared.scheduleManager.start()
  }

  const greeter = new SessionGreeter(() => queueManager.getConfig(), queueManager, client)
  const blockWatcher = new BlockWatcher(queueManager, client)

  if (isCoordinator) {
    safeToast(client, "opencode-queue loaded", "info", 3000)
  }

  const hooks: Awaited<ReturnType<Plugin>> = {
    "chat.message": async () => {
      idleDetector.writeActivity()
    },
    "tool.execute.before": async () => {
      idleDetector.writeActivity()
    },
    "tool.execute.after": async () => {
      idleDetector.writeActivity()
    },
    tool: {
      "queue-list": tool({
        description: "Show queue items or one item in summary, full, or log view.",
        args: {
          itemId: tool.schema.string().optional().describe("Item ID or prefix"),
          status: tool.schema.enum(["pending", "running", "blocked", "review_pending", "completed", "failed"]).optional().describe("Status filter"),
          view: tool.schema.enum(["summary", "full", "log"]).optional().describe("Output style"),
        },
        async execute(args) {
          if (args.itemId) {
            const item = findQueueItem(queueManager, args.itemId)
            if (!item) return `Error: Item ${args.itemId} not found.`
            switch (args.view) {
              case "log":
                return formatQueueItemLog(client, item)
              case "full":
                return formatQueueItemFull(item)
              default:
                return formatQueueItemSummary(item)
            }
          }

          const items = queueManager.listItems(args.status as string | undefined)
          if (items.length === 0) return "Queue is empty."
          return items.map((item) => formatQueueItemSummary(item)).join("\n\n")
        },
      }),

      "queue-add": tool({
        description: "Add a queue item.",
        args: {
          workspace: tool.schema.string().describe("Absolute workspace path"),
          goal: tool.schema.string().describe("Task goal"),
          parentItemId: tool.schema.string().optional().describe("Parent item ID or prefix"),
          dependencyMode: tool.schema.enum(["review_pending", "completed"]).optional().describe("When parent unlocks this item"),
        },
        async execute(args) {
          let parentId: string | null = null
          if (args.parentItemId) {
            const parent = findQueueItem(queueManager, args.parentItemId)
            if (!parent) return `Error: Parent item ${args.parentItemId} not found.`
            parentId = parent.id
          }
          const result = await queueManager.addItem(args.workspace, args.goal, {
            parentItemId: parentId,
            dependencyMode: args.dependencyMode as "review_pending" | "completed" | undefined,
          })
          if (!("id" in result)) return `Error: ${result.error}`
          let output = `Added ${result.id}.\nStatus: ${result.status}\nGoal: ${result.goal}`
          if (result.parentItemId) output += `\nDepends: ${result.parentItemId} @ ${result.dependencyMode}`
          return output
        },
      }),

      "queue-confirm": tool({
        description: "Mark a review item complete.",
        args: {
          itemId: tool.schema.string().describe("Item ID or prefix"),
        },
        async execute(args) {
          const item = findQueueItem(queueManager, args.itemId)
          if (!item) return `Error: Item ${args.itemId} not found.`
          if (item.status !== "review_pending") {
            return `Error: Item ${item.id} is not awaiting review (status: ${item.status}).`
          }
          const now = new Date().toISOString()
          await queueManager.updateItem(item.id, {
            status: "completed",
            completedAt: now,
            reviewedAt: now,
            staleDependency: false,
          })
          return `Item ${item.id} marked completed.`
        },
      }),

      "queue-followup": tool({
        description: "Send follow-up on a review item.",
        args: {
          itemId: tool.schema.string().describe("Item ID or prefix"),
          message: tool.schema.string().describe("Follow-up message"),
        },
        async execute(args) {
          const item = findQueueItem(queueManager, args.itemId)
          if (!item) return `Error: Item ${args.itemId} not found.`
          if (item.status !== "review_pending") {
            return `Error: Item ${item.id} is not awaiting review (status: ${item.status}).`
          }
          if (!item.sessionId) return `Error: Item ${item.id} has no session.`

          try {
            await client.session.prompt({
              path: { id: item.sessionId },
              query: { directory: item.workspace },
              body: {
                parts: [{ type: "text", text: args.message }],
              },
            })
          } catch {
            return `Error: Failed to send follow-up for item ${item.id}.`
          }

          await queueManager.updateItem(item.id, {
            status: "running",
            completedAt: null,
            reviewedAt: null,
            result: null,
          })
          await queueManager.markDescendantsStale(item.id)
          const processor = new QueueProcessor(queueManager, client, idleDetector, ctx.serverUrl)
          await processor.continueSession(item.id, item.sessionId, item.workspace)
          return `Follow-up sent for ${item.id}.`
        },
      }),

      "queue-remove": tool({
        description: "Remove a queue item.",
        args: {
          itemId: tool.schema.string().describe("Item ID or prefix"),
        },
        async execute(args) {
          const item = findQueueItem(queueManager, args.itemId)
          if (!item) return `Error: Item ${args.itemId} not found.`
          const dependents = queueManager.listItems().filter((candidate) => candidate.parentItemId === item.id)
          if (dependents.length > 0) {
            return `Error: Item ${item.id} has dependent tasks and cannot be removed.`
          }
          if (item.sessionId) {
            try {
              await client.session.abort({
                path: { id: item.sessionId },
                query: { directory: item.workspace },
              })
            } catch {}
          }
          const removed = await queueManager.removeItem(item.id)
          return removed ? `Removed item ${item.id}.` : `Error: Could not remove item ${item.id}.`
        },
      }),

      "queue-retry": tool({
        description: "Retry a failed item.",
        args: {
          itemId: tool.schema.string().describe("Item ID or prefix"),
        },
        async execute(args) {
          const item = findQueueItem(queueManager, args.itemId)
          if (!item) return `Error: Item ${args.itemId} not found.`
          if (item.status !== "failed") return `Error: Item ${item.id} is not failed (status: ${item.status}).`
          await queueManager.updateItem(item.id, {
            status: "pending",
            retryCount: 0,
            nextRetryAt: null,
            error: null,
            staleDependency: false,
          })
          return `Item ${item.id} reset to pending.`
        },
      }),

      "queue-schedule-add": tool({
        description: "Schedule a one-off or recurring task.",
        args: {
          workspace: tool.schema.string().describe("Absolute workspace path"),
          goal: tool.schema.string().describe("Task goal"),
          scheduledFor: tool.schema.string().optional().describe("ISO datetime for one-off task"),
          cronExpression: tool.schema.string().optional().describe("Cron expression for recurring task"),
          timezone: tool.schema.string().optional().describe('IANA timezone (default "UTC")'),
          parentItemId: tool.schema.string().optional().describe("Parent item ID or prefix for dependency"),
          dependencyMode: tool.schema.enum(["review_pending", "completed"]).optional().describe("When parent unlocks this item"),
          maxOccurrences: tool.schema.number().optional().describe("Auto-disable after N firings (recurring only)"),
        },
        async execute(args) {
          if (!args.scheduledFor && !args.cronExpression) {
            return "Error: Provide either scheduledFor (one-off) or cronExpression (recurring)."
          }
          if (args.scheduledFor && args.cronExpression) {
            return "Error: Provide only one of scheduledFor or cronExpression, not both."
          }

          const absWorkspace = resolve(args.workspace)
          if (!existsSync(absWorkspace)) {
            return `Error: Directory not found: ${absWorkspace}`
          }
          if (!statSync(absWorkspace).isDirectory()) {
            return `Error: Path is not a directory: ${absWorkspace}`
          }

          if (args.scheduledFor) {
            const fireDate = new Date(args.scheduledFor)
            if (Number.isNaN(fireDate.getTime())) return `Error: Invalid ISO datetime: ${args.scheduledFor}`
            if (fireDate.getTime() <= Date.now()) return "Error: scheduledFor must be in the future."
          }

          if (args.cronExpression) {
            const { validateCronExpression } = await import("cron")
            if (!validateCronExpression(args.cronExpression).valid) {
              return `Error: Invalid cron expression: ${args.cronExpression}`
            }
          }

          let parentId: string | null = null
          if (args.parentItemId) {
            const parent = findQueueItem(queueManager, args.parentItemId)
            if (!parent) return `Error: Parent item ${args.parentItemId} not found.`
            parentId = parent.id
          }

          const schedule = await shared.scheduleManager.addAndStart({
            workspace: absWorkspace,
            goal: args.goal,
            scheduledFor: args.scheduledFor ?? null,
            cronExpression: args.cronExpression ?? null,
            timezone: args.timezone || "UTC",
            enabled: true,
            maxOccurrences: args.maxOccurrences ?? null,
            parentItemId: parentId,
            dependencyMode: args.dependencyMode === "completed" ? "completed" : "review_pending",
          })

          return formatScheduledTask(schedule)
        },
      }),

      "queue-schedule-list": tool({
        description: "List, remove, pause, or resume scheduled tasks.",
        args: {
          action: tool.schema.enum(["list", "remove", "pause", "resume"]).optional().describe("Action (default: list)"),
          scheduleId: tool.schema.string().optional().describe("Target schedule ID"),
        },
        async execute(args) {
          const action = args.action || "list"

          if (action === "list") {
            const schedules = queueManager.listSchedules()
            if (schedules.length === 0) return "No scheduled tasks."
            return schedules.map((schedule) => formatScheduledTask(schedule)).join("\n\n")
          }

          if (!args.scheduleId) return `Error: scheduleId is required for ${action} action.`
          let scheduleId = args.scheduleId

          const schedule = queueManager.getSchedule(scheduleId)
          if (!schedule) {
            const match = queueManager.listSchedules().find((candidate) => candidate.id.startsWith(scheduleId))
            if (!match) return `Error: Schedule ${scheduleId} not found.`
            scheduleId = match.id
          }

          if (action === "remove") {
            const removed = await shared.scheduleManager.removeAndStop(scheduleId)
            return removed ? `Removed schedule ${scheduleId}.` : `Error: Could not remove schedule ${scheduleId}.`
          }

          if (action === "pause") {
            const updated = await shared.scheduleManager.pause(scheduleId)
            if (!updated) return `Error: Schedule ${scheduleId} not found.`
            return `Paused schedule ${updated.id}.\n${formatScheduledTask(updated)}`
          }

          if (action === "resume") {
            const updated = await shared.scheduleManager.resume(scheduleId)
            if (!updated) return `Error: Schedule ${scheduleId} not found.`
            return `Resumed schedule ${updated.id}.\n${formatScheduledTask(updated)}`
          }

          return `Error: Unknown action: ${action}`
        },
      }),
    },
  }

  if (isCoordinator) {
    hooks.event = async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      try {
        await blockWatcher.handleEvent(event)
        switch (event.type) {
          case "session.created":
            await greeter.onSessionCreated()
            break
          case "session.updated":
          case "command.executed":
          case "tui.command.execute":
          case "question.replied":
          case "question.rejected":
            idleDetector.writeActivity()
            break
          case "permission.replied": {
            idleDetector.writeActivity()
            const props = event.properties as { sessionID?: string; response?: string } | undefined
            if (props?.sessionID) {
              const item = findItemBySession(queueManager, props.sessionID)
              if (item?.status === "blocked" && item.blockedReason?.type === "permission") {
                await queueManager.updateItem(item.id, {
                  status: "running",
                  blockedReason: { ...item.blockedReason, userResponse: props.response || "approved" },
                })
                const processor = new QueueProcessor(queueManager, client, idleDetector, ctx.serverUrl)
                void processor.continueSession(item.id, props.sessionID, item.workspace)
              }
            }
            break
          }
          case "message.updated": {
            idleDetector.writeActivity()
            const info = event.properties?.info as { sessionID?: string; role?: string } | undefined
            if (info?.sessionID) {
              await greeter.onMessageUpdated(info.sessionID)
              if (info.role === "user") {
                const item = findItemBySession(queueManager, info.sessionID)
                if (item?.status === "blocked" && item.blockedReason?.type === "question") {
                  await queueManager.updateItem(item.id, {
                    status: "running",
                    blockedReason: { ...item.blockedReason, userResponse: "answered via session" },
                  })
                  const processor = new QueueProcessor(queueManager, client, idleDetector, ctx.serverUrl)
                  void processor.continueSession(item.id, info.sessionID, item.workspace)
                }
              }
            }
            break
          }
          case "session.idle":
            break
        }
      } catch {}
    }
  }

  return hooks
}
