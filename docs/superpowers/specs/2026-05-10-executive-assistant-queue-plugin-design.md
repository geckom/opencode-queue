# Executive Assistant Queue Plugin — Design Spec

## Summary

An OpenCode plugin that maintains a task queue in a JSON file. When opencode has been idle for a configurable period, the plugin processes queued items one by one using the opencode SDK. Items that hit permission prompts or questions are marked as blocked and saved for the user to respond to later. The user interacts with the queue via custom tools registered by the plugin.

## Approach

SDK-based session management (Approach A). The plugin uses the `@opencode-ai/sdk` client to create sessions, send prompts, monitor for completion, and handle permissions/questions programmatically.

---

## Data Model

### Storage Location

`~/.config/opencode/queue.json` — global, shared across all projects.

### Queue Store

```typescript
interface QueueStore {
  config: QueueConfig
  items: QueueItem[]
}

interface QueueConfig {
  idleTimeoutSeconds: number     // default: 3600 (1 hour)
  blockedReminderMinutes: number // default: 30
  maxRetries: number             // default: 3
  retryDelaysMinutes: number[]   // default: [5, 10, 15]
  reminderIntervalMessages: number // default: 30 — show queue summary every N messages
}
```

### Queue Item

```typescript
interface QueueItem {
  id: string                            // UUID
  workspace: string                     // absolute path to project directory
  goal: string                          // the task description
  status: "pending" | "running" | "blocked" | "completed" | "failed"
  sessionId: string | null              // opencode session ID once created
  createdAt: string                     // ISO timestamp
  startedAt: string | null
  completedAt: string | null
  blockedReason: BlockedReason | null
  error: string | null                  // error message if failed
  result: string | null                 // final assistant response summary
  sessionUrl: string | null             // URL for web viewing, e.g. http://localhost:4096/session/{id}
  retryCount: number                    // consecutive error retries, resets on success
  nextRetryAt: string | null            // ISO timestamp for scheduled retry
}

interface BlockedReason {
  type: "permission" | "question"
  permissionId: string | null           // for permission blocks
  details: string                       // the permission request or question text
  options: string[] | null              // for questions with multiple-choice options
  userResponse: string | null           // filled in when user answers
}
```

---

## Plugin Architecture

### File Structure

```
~/.config/opencode/
├── queue.json                        # queue store (config + items)
├── queue.last-activity               # single timestamp (unix ms) — updated by all instances
├── queue.lock                        # processing lock file (one writer at a time)
├── plugins/
│   └── executive-assistant.ts        # single plugin file with all logic
│   └── README.md                     # usage documentation
└── package.json                      # for @opencode-ai/sdk dependency
```

### Components

All components live within the single plugin file `executive-assistant.ts`.

#### QueueManager

Reads and writes `queue.json`. Handles all state transitions for items. Uses atomic writes (write to temp file, then rename) to prevent corruption. On read, if the file is malformed, starts with an empty queue rather than crashing.

State transitions:
- `pending` → `running` (picked up by processor)
- `running` → `completed` (session finished successfully)
- `running` → `blocked` (permission/question detected)
- `running` → `running` (error, retry scheduled, same session)
- `running` → `failed` (max retries exceeded)
- `blocked` → `pending` (user responded, item re-queued)
- `failed` → `pending` (user manually retried via queue-retry tool)

#### IdleDetector (Cross-Instance)

Tracks idle state across **all** running opencode instances, not just the one hosting the plugin. This ensures the queue only processes when the user is truly idle everywhere.

**Coordination mechanism**: A single shared file `~/.config/opencode/queue.last-activity` containing a unix timestamp in milliseconds. Every opencode instance running the plugin writes to this file on activity events. Last-write-wins is the correct behavior — if any instance was recently active, the timestamp is recent.

**Why a separate file instead of queue.json?** The last-activity timestamp is updated on every activity event (high frequency). Storing it in `queue.json` would risk write contention — an activity update from instance A could overwrite a queue item addition from instance B. Keeping them separate isolates high-frequency low-stakes writes from low-frequency high-stakes writes.

**How it works:**
1. On every activity event (`session.updated`, `message.updated`, `tool.execute.before/after`), write `Date.now()` to `queue.last-activity`.
2. A polling interval (every 30 seconds) reads `queue.last-activity` and checks: `now - lastActivity > idleTimeoutSeconds`.
3. When the idle condition is met, the plugin acquires `queue.lock` and triggers the QueueProcessor.
4. If the lock is held by another instance, skip — only one instance processes at a time.

**Edge cases:**
- If `queue.last-activity` doesn't exist, treat as idle immediately (first run).
- Crashed instances stop updating the file, which is correct — their lack of activity naturally contributes to the idle state.
- On plugin initialization, write the current timestamp to prevent immediate false-idle detection.

If opencode is already processing a queue item when the user resumes interaction (on any instance), the current item finishes to completion/block/error, but the processor does **not** chain to the next item. It stops and waits for all instances to be idle again before resuming.

#### QueueProcessor

Picks the next `pending` item (or an item past its `nextRetryAt`). Creates an SDK session targeting the item's workspace. Sends the goal as a prompt via `prompt_async`. Monitors the session for:

- **Completion**: Captures the last assistant message as `result`, sets `completedAt`.
- **Block**: Detected by BlockWatcher, item transitions to `blocked`.
- **Error**: Schedules a retry in the same session with staggered delays.

Only one item processes at a time. Maintains an `isProcessing` flag.

On plugin initialization, scans for any items with `status: "running"` and resets them to `pending` so they get re-picked on the next idle cycle. Previous `sessionId` is preserved for inspection.

**Workspace/session management**: Each queued item may reference a different project directory with its own `opencode.jsonc`, `AGENTS.md`, plugins, and configuration. The opencode server supports multi-project sessions natively — nearly every API endpoint (including `POST /session` and message endpoints) accepts a `?directory=<path>` query parameter that targets a specific project workspace.

The plugin uses the **existing** opencode server (the one the TUI or headless server is already running on) via the SDK client's `createOpencodeClient()`. When creating a session for a queued item:

1. Call `client.session.create({ query: { directory: item.workspace } })` — the server loads that workspace's `opencode.jsonc`, `AGENTS.md`, `.opencode/` directory, and all project-specific configuration automatically.
2. Send prompts via `client.session.prompt({ path: { id: sessionId }, query: { directory: item.workspace }, body: { ... } })`.
3. For retries and user responses, use the same `directory` query parameter to target the correct workspace context.

No separate server instances needed. A single opencode server handles all projects.

**Directory validation**: The only requirement is that the workspace directory exists on disk. No `opencode.jsonc`, `AGENTS.md`, or `.opencode/` setup is needed — opencode works fine with just the global config as fallback.

1. **At `queue-add` time**: validate that the directory exists. If not, reject the add with an error.
2. **At processing time**: re-check that the directory still exists. If it was deleted after being added, mark the item as `failed` with error `"Directory not found: <path>"`.

#### BlockWatcher

Monitors running sessions for `permission.asked` events and `question` tool calls. When detected:

1. Saves block details to the item's `blockedReason` field.
2. Sets item status to `blocked`.
3. Processor moves to the next pending item.

If a blocked item sits unresolved for a configurable timeout (default 30 minutes), the plugin sends a reminder toast via `tui.toast.show`. The item stays blocked until the user responds.

#### Session Greeter & Periodic Reminder

**On every `session.created` event**, the plugin shows a toast notification summarizing the current queue state:

```
📋 Queue: 3 pending, 1 blocked, 5 completed
```

**Periodically**, the plugin also shows the same summary toast every N messages (configurable via `reminderIntervalMessages`, default 30). It tracks the message count per session via `message.updated` events. Every 30 messages, it shows the toast and resets the counter. This keeps the queue visible during long conversations without being intrusive.

Variant rules: `"warning"` if any blocked items exist, `"info"` otherwise. No toast if the queue is empty.

#### Custom Tools

The plugin registers these tools for the AI to call:

| Tool | Parameters | Description |
|------|-----------|-------------|
| `queue-list` | `status?: string` | List queue items, optionally filtered by status |
| `queue-add` | `workspace: string, goal: string` | Add a new item. Validates workspace directory exists before writing. |
| `queue-answer` | `itemId: string, response: string` | Respond to a blocked item's question/permission. Sends response to the correct session and sets item back to `pending`. |
| `queue-status` | `itemId: string` | Show full details for one item including result, session ID, blocked reason. |
| `queue-remove` | `itemId: string` | Remove an item from the queue. Aborts its session if running. |
| `queue-log` | `itemId: string` | Show session URL and last messages for an item. |
| `queue-retry` | `itemId: string` | Reset a failed item back to pending. |

Users interact naturally: "add a task to fix the tests in /my/project", "show my queue", "answer item abc123 with yes".

---

## SDK Reference

All operations use the `@opencode-ai/sdk` package. The plugin connects to the existing opencode server using `createOpencodeClient({ baseUrl })`. No separate server instances needed.

### Client Creation

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk"
const client = createOpencodeClient({ baseUrl: "http://localhost:4096" })
```

The client supports a `directory` option that sets the `x-opencode-directory` header on all requests. Alternatively, every endpoint accepts `query: { directory }` per-request.

### Key SDK Methods Used

| Operation | SDK Method | Notes |
|-----------|-----------|-------|
| Create session | `client.session.create({ query: { directory }, body: { title } })` | Returns `Session` with `id`, `projectID`, `directory` |
| Send prompt (async) | `client.session.promptAsync({ path: { id }, query: { directory }, body: { parts } })` | Returns `204` immediately — non-blocking. Fire and forget. |
| Send prompt (sync) | `client.session.prompt({ path: { id }, query: { directory }, body: { parts } })` | Returns full `AssistantMessage` with parts — blocks until complete. Used for retries. |
| Get session status | `client.session.status({ query: { directory } })` | Returns `{ [sessionId]: SessionStatus }` — `"idle"`, `"busy"`, or `"retry"` |
| Get session messages | `client.session.messages({ path: { id }, query: { directory } })` | Returns `Array<{ info: Message, parts: Part[] }>` — used to extract final result |
| Abort session | `client.session.abort({ path: { id }, query: { directory } })` | Used by `queue-remove` |
| Respond to permission | `client.postSessionIdPermissionsPermissionId({ path: { id, permissionID }, body: { response }, query: { directory } })` | `response` is `"once" \| "always" \| "reject"` |
| Answer question block | `client.session.prompt({ path: { id }, query: { directory }, body: { parts: [{ type: "text", text: answer }] } })` | Send answer as a regular text message to the session |
| Subscribe to events | `client.event.subscribe()` | SSE stream — returns events with `type` and `properties` |
| Subscribe to global events | `client.global.event()` | SSE stream — includes `directory` field per event |
| Show toast | `client.tui.showToast({ body: { message, variant, duration } })` | `variant: "info" \| "success" \| "warning" \| "error"` |
| List sessions | `client.session.list({ query: { directory } })` | Returns `Session[]` |

### Event Types for Monitoring

| Event Type | When Fired | Properties |
|------------|-----------|------------|
| `session.status` | Session status changes | `{ sessionID, status: { type: "idle" \| "busy" \| "retry" } }` |
| `session.idle` | Session goes idle | `{ sessionID }` |
| `session.error` | Session errors | `{ sessionID?, error? }` |
| `permission.updated` | Permission requested | `Permission` object with `id`, `sessionID`, `title`, `metadata` |
| `message.updated` | Message created/updated | `{ info: Message }` |
| `message.part.updated` | Message part updated (tool calls, text) | `{ part: Part, delta?: string }` |

### Permission Response Values

The permission endpoint accepts exactly three values:
- `"once"` — allow this one time
- `"always"` — allow and remember for this session
- `"reject"` — deny the request

### Detecting Question Blocks

The `question` tool is not a server-level event — it appears as a `ToolPart` in message parts where `tool === "question"` and `state.status === "pending"`. The BlockWatcher monitors `message.part.updated` events, checks for `tool === "question"` with `state.status === "pending"`, and extracts the question text from `state.input`.

---

## Event Hooks

| Event | Purpose |
|-------|---------|
| `session.created` | Show queue summary toast to user |
| `session.idle` | Triggers idle timer |
| `session.updated` | Resets idle timer |
| `message.updated` | Resets idle timer |
| `tool.execute.before` | Resets idle timer |
| `tool.execute.after` | Resets idle timer |
| `permission.updated` | Detected during processing to capture permission blocks |
| `message.part.updated` | Detected during processing to capture question tool blocks |

---

## Processing Lifecycle

```
polling interval (30s) → check queue.last-activity →
  all instances idle for idleTimeoutSeconds? →
    acquire queue.lock →
    pick next pending/retry-due item →
      if no items: release lock, done
      create SDK session with ?directory=item.workspace →
      send goal as prompt →
      monitor session →
        if completed: save result, mark completed, check global idle → process next
        if blocked: save details, mark blocked, check global idle → process next
        if error: schedule retry (same session) or mark failed, check global idle → process next
```

"Check global idle" means: if any opencode instance has had activity, stop chaining and release the lock. If all instances are still idle, immediately process next item.

---

## Retry Logic

When a session errors for transient reasons (model API failure, rate limiting, context overflow, network interruption — not permission/question blocks):

1. Increment `retryCount`.
2. Schedule retry using staggered delays from config: 1st retry after 5 min, 2nd after 10 min, 3rd after 15 min.
3. Set `nextRetryAt` to `now + delay`.
4. **Reuse the same session** — send a continuation message so the session retains its full context (files read, work done).
5. After 3 consecutive failures, mark item as `failed` permanently.
6. User can manually reset via `queue-retry` tool.

Permission/question blocks do **not** count as retries.

---

## Error Handling

| Scenario | Handling |
|----------|----------|
| Opencode restarts mid-processing | Running items reset to `pending` on init, re-picked on next idle |
| Queue file corruption | Log error, start with empty queue |
| Workspace directory missing | Rejected at add time. If deleted after add, marked failed at process time |
| Session API error | Retry with staggered delays in same session |
| User resumes interaction (any instance) | Current item finishes, processor stops until all instances idle again |
| Blocked item timeout | Toast reminder, item stays blocked |
| Two instances try to process simultaneously | File lock (`queue.lock`) ensures only one processes at a time |

---

## Configuration

All config lives in `queue.json` under the `config` key with these defaults:

```json
{
  "config": {
    "idleTimeoutSeconds": 3600,
    "blockedReminderMinutes": 30,
    "maxRetries": 3,
    "retryDelaysMinutes": [5, 10, 15],
    "reminderIntervalMessages": 30
  },
  "items": []
}
```

---

## README

A `README.md` alongside the plugin file will document:
- Installation steps (add to `package.json`, place plugin file)
- Configuration options and defaults
- Available tools and example prompts for each
- How the idle/processing/retry flow works
- How to handle blocked items (permissions and questions)
- How to view completed item results and session logs
- Queue status toast shown on new sessions
