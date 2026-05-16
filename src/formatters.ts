import type { OpencodeClient } from "@opencode-ai/sdk"
import type { QueueItem, ScheduledTask } from "./types.js"

export function formatScheduledTask(schedule: ScheduledTask): string {
  const kind = schedule.scheduledFor ? "one-off" : "recurring"
  const status = schedule.enabled ? "enabled" : "disabled"
  let line = `[${status.toUpperCase()}] ${schedule.id.substring(0, 8)} (${kind}) ${schedule.goal.substring(0, 80)}`
  if (schedule.scheduledFor) line += `\nScheduled: ${schedule.scheduledFor}`
  if (schedule.cronExpression) line += `\nCron: ${schedule.cronExpression}`
  line += `\nTimezone: ${schedule.timezone}`
  if (schedule.nextTriggerAt) line += `\nNext: ${schedule.nextTriggerAt}`
  if (schedule.lastTriggeredAt) line += `\nLast: ${schedule.lastTriggeredAt}`
  line += `\nOccurrences: ${schedule.occurrenceCount}`
  if (schedule.maxOccurrences !== null) line += ` / ${schedule.maxOccurrences}`
  if (schedule.parentItemId) line += `\nDepends: ${schedule.parentItemId.substring(0, 8)} @ ${schedule.dependencyMode}`
  return line
}

export function formatQueueItemSummary(item: QueueItem): string {
  let line = `[${item.status.toUpperCase()}] ${item.id.substring(0, 8)} ${item.goal.substring(0, 80)}`
  if (item.parentItemId) line += `\nDepends: ${item.parentItemId.substring(0, 8)} @ ${item.dependencyMode}`
  if (item.dependencyBlockedReason && item.status === "pending") {
    line += `\nWaiting: ${item.dependencyBlockedReason.substring(0, 160)}`
  }
  if (item.staleDependency) line += `\nStale: Parent changed after this item became eligible`
  if (item.status === "blocked" && item.blockedReason) {
    line += `\nBlocked: ${item.blockedReason.details.substring(0, 160)}`
  }
  if (item.status === "review_pending" && item.result) {
    line += `\nReview: ${item.result.substring(0, 160)}`
  }
  if (item.status === "completed" && item.result) {
    line += `\nResult: ${item.result.substring(0, 160)}`
  }
  if (item.status === "failed" && item.error) {
    line += `\nError: ${item.error.substring(0, 160)}`
  }
  return line
}

export function formatQueueItemFull(item: QueueItem): string {
  let output = `ID: ${item.id}\nStatus: ${item.status}\nGoal: ${item.goal}\nWorkspace: ${item.workspace}`
  if (item.parentItemId) output += `\nParent: ${item.parentItemId}`
  output += `\nDependency Mode: ${item.dependencyMode}`
  if (item.dependencySatisfiedAt) output += `\nDependency Satisfied: ${item.dependencySatisfiedAt}`
  if (item.dependencySourceStatus) output += `\nDependency Source: ${item.dependencySourceStatus}`
  if (item.dependencyBlockedReason) output += `\nDependency Waiting: ${item.dependencyBlockedReason}`
  if (item.staleDependency) output += `\nStale Dependency: true`
  output += `\nCreated: ${item.createdAt}`
  if (item.startedAt) output += `\nStarted: ${item.startedAt}`
  if (item.completedAt) output += `\nCompleted: ${item.completedAt}`
  if (item.reviewedAt) output += `\nReviewed: ${item.reviewedAt}`
  if (item.sessionId) output += `\nSession: ${item.sessionId}`
  if (item.sessionUrl) output += `\nURL: ${item.sessionUrl}`
  if (item.retryCount > 0) output += `\nRetries: ${item.retryCount}`
  if (item.nextRetryAt) output += `\nNext Retry: ${item.nextRetryAt}`
  if (item.blockedReason) output += `\nBlocked (${item.blockedReason.type}): ${item.blockedReason.details}`
  if (item.status === "review_pending" && item.result) output += `\nReview Result: ${item.result}`
  else if (item.result) output += `\nResult: ${item.result}`
  if (item.error) output += `\nError: ${item.error}`
  return output
}

export async function formatQueueItemLog(client: OpencodeClient, item: QueueItem): Promise<string> {
  if (!item.sessionId) return `No session for item ${item.id}.`

  const output = `Session: ${item.sessionId}\nURL: ${item.sessionUrl || "N/A"}`
  try {
    const { data: messages } = await client.session.messages({
      path: { id: item.sessionId },
      query: { directory: item.workspace },
    })
    if (!messages || messages.length === 0) {
      return `${output}\n\n(No messages)`
    }

    const lines: string[] = []
    for (const msg of messages.slice(-4)) {
      const role = msg.info.role
      const textParts = msg.parts.filter((part) => part.type === "text")
      for (const part of textParts) {
        const text = (part as { type: "text"; text: string }).text
        lines.push(`[${role}] ${text.substring(0, 300)}`)
      }
    }
    return lines.length > 0 ? `${output}\n\n${lines.join("\n\n")}` : `${output}\n\n(No text messages)`
  } catch {
    return `${output}\n\n(Could not fetch messages)`
  }
}
