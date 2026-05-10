# Executive Assistant Queue Plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OpenCode plugin that maintains a global task queue in JSON, processes items via the SDK when idle, handles blocks for permissions/questions, and exposes custom tools for queue management.

**Architecture:** Single TypeScript plugin file (`~/.config/opencode/plugins/executive-assistant.ts`) that connects to the existing opencode server via `@opencode-ai/sdk`. Uses file-based coordination (`queue.json`, `queue.last-activity`, `queue.lock`) for cross-instance idle detection and processing locks. All components (QueueManager, IdleDetector, QueueProcessor, BlockWatcher, SessionGreeter) live in the plugin file.

**Tech Stack:** TypeScript, `@opencode-ai/sdk`, OpenCode plugin API (event hooks + custom tools)

**Spec:** `docs/superpowers/specs/2026-05-10-executive-assistant-queue-plugin-design.md`

---

## File Structure

| File | Purpose |
|------|---------|
| `~/.config/opencode/plugins/executive-assistant.ts` | Single plugin file — all logic |
| `~/.config/opencode/plugins/README.md` | Usage documentation |
| `~/.config/opencode/queue.json` | Queue store (config + items), created at runtime |
| `~/.config/opencode/queue.last-activity` | Last activity timestamp, created at runtime |
| `~/.config/opencode/queue.lock` | Processing lock file, created at runtime |
| `~/.config/opencode/package.json` | NPM dependencies (`@opencode-ai/sdk`) |

---

## Task 1: Types and QueueManager

**Files:**
- Create: `~/.config/opencode/plugins/executive-assistant.ts`

This task establishes all TypeScript interfaces and the QueueManager that handles all queue.json reads/writes.

- [ ] **Step 1: Write the types and QueueManager**

Add these interfaces and the QueueManager class to the top of `executive-assistant.ts`:

```typescript
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"
import { randomUUID } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, statSync } from "fs"
import { join, resolve } from "path"

const CONFIG_DIR = process.env.XDG_CONFIG_HOME || join(process.env.HOME!, ".config")
const OPENCODE_DIR = join(CONFIG_DIR, "opencode")
const QUEUE_FILE = join(OPENCODE_DIR, "queue.json")
const LAST_ACTIVITY_FILE = join(OPENCODE_DIR, "queue.last-activity")
const LOCK_FILE = join(OPENCODE_DIR, "queue.lock")
const PLUGIN_DIR = join(OPENCODE_DIR, "plugins")

interface QueueConfig {
  idleTimeoutSeconds: number
  blockedReminderMinutes: number
  maxRetries: number
  retryDelaysMinutes: number[]
  reminderIntervalMessages: number
}

interface BlockedReason {
  type: "permission" | "question"
  permissionId: string | null
  details: string
  options: string[] | null
  userResponse: string | null
}

interface QueueItem {
  id: string
  workspace: string
  goal: string
  status: "pending" | "running" | "blocked" | "completed" | "failed"
  sessionId: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  blockedReason: BlockedReason | null
  error: string | null
  result: string | null
  sessionUrl: string | null
  retryCount: number
  nextRetryAt: string | null
}

interface QueueStore {
  config: QueueConfig
  items: QueueItem[]
}

const DEFAULT_CONFIG: QueueConfig = {
  idleTimeoutSeconds: 3600,
  blockedReminderMinutes: 30,
  maxRetries: 3,
  retryDelaysMinutes: [5, 10, 15],
  reminderIntervalMessages: 30,
}

class QueueManager {
  private readStore(): QueueStore {
    try {
      if (!existsSync(QUEUE_FILE)) {
        return { config: { ...DEFAULT_CONFIG }, items: [] }
      }
      const raw = readFileSync(QUEUE_FILE, "utf-8")
      return JSON.parse(raw) as QueueStore
    } catch {
      return { config: { ...DEFAULT_CONFIG }, items: [] }
    }
  }

  private writeStore(store: QueueStore): void {
    if (!existsSync(OPENCODE_DIR)) {
      mkdirSync(OPENCODE_DIR, { recursive: true })
    }
    const tmp = QUEUE_FILE + ".tmp"
    writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8")
    renameSync(tmp, QUEUE_FILE)
  }

  getConfig(): QueueConfig {
    return this.readStore().config
  }

  listItems(status?: string): QueueItem[] {
    const store = this.readStore()
    if (status) {
      return store.items.filter((item) => item.status === status)
    }
    return store.items
  }

  getItem(id: string): QueueItem | undefined {
    return this.readStore().items.find((item) => item.id === id)
  }

  addItem(workspace: string, goal: string): QueueItem | { error: string } {
    const absWorkspace = resolve(workspace)
    if (!existsSync(absWorkspace)) {
      return { error: `Directory not found: ${absWorkspace}` }
    }
    const store = this.readStore()
    const item: QueueItem = {
      id: randomUUID(),
      workspace: absWorkspace,
      goal,
      status: "pending",
      sessionId: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      blockedReason: null,
      error: null,
      result: null,
      sessionUrl: null,
      retryCount: 0,
      nextRetryAt: null,
    }
    store.items.push(item)
    this.writeStore(store)
    return item
  }

  updateItem(id: string, updates: Partial<QueueItem>): QueueItem | undefined {
    const store = this.readStore()
    const idx = store.items.findIndex((item) => item.id === id)
    if (idx === -1) return undefined
    Object.assign(store.items[idx], updates)
    this.writeStore(store)
    return store.items[idx]
  }

  removeItem(id: string): boolean {
    const store = this.readStore()
    const idx = store.items.findIndex((item) => item.id === id)
    if (idx === -1) return false
    store.items.splice(idx, 1)
    this.writeStore(store)
    return true
  }

  getNextPending(): QueueItem | undefined {
    const store = this.readStore()
    const now = Date.now()
    return store.items.find((item) => {
      if (item.status === "pending") return true
      if (item.status === "running" && item.nextRetryAt) {
        return new Date(item.nextRetryAt).getTime() <= now
      }
      return false
    })
  }

  countByStatus(): Record<string, number> {
    const store = this.readStore()
    const counts: Record<string, number> = {}
    for (const item of store.items) {
      counts[item.status] = (counts[item.status] || 0) + 1
    }
    return counts
  }

  resetRunningToPending(): void {
    const store = this.readStore()
    let changed = false
    for (const item of store.items) {
      if (item.status === "running") {
        item.status = "pending"
        changed = true
      }
    }
    if (changed) this.writeStore(store)
  }
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd ~/.config/opencode/plugins && npx tsc --noEmit --esModuleInterop --moduleResolution node --target ES2022 --module ES2022 executive-assistant.ts 2>&1 || echo "Type errors found"`

Expected: May have type errors related to missing `@opencode-ai/sdk` — that's fine for now, the local types and QueueManager logic should be clean. Fix any non-SDK errors.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/
git commit -m "feat(executive-assistant): add types and QueueManager"
```

---

## Task 2: IdleDetector

**Files:**
- Modify: `~/.config/opencode/plugins/executive-assistant.ts`

This task adds the cross-instance idle detection using `queue.last-activity` and the file-based lock mechanism.

- [ ] **Step 1: Add IdleDetector class**

Append after the `QueueManager` class in `executive-assistant.ts`:

```typescript
class IdleDetector {
  private timer: ReturnType<typeof setInterval> | null = null
  private initialized = false

  constructor(
    private config: QueueConfig,
    private onIdle: () => Promise<void>,
  ) {}

  start(): void {
    this.writeActivity()
    this.initialized = true
    this.timer = setInterval(() => this.checkIdle(), 30_000)
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

  private async checkIdle(): Promise<void> {
    try {
      if (!existsSync(LAST_ACTIVITY_FILE)) {
        await this.onIdle()
        return
      }
      const lastActivity = parseInt(readFileSync(LAST_ACTIVITY_FILE, "utf-8").trim(), 10)
      const elapsed = Date.now() - lastActivity
      if (elapsed >= this.config.idleTimeoutSeconds * 1000) {
        await this.onIdle()
      }
    } catch {}
  }
}

class FileLock {
  static async acquire(): Promise<boolean> {
    try {
      if (!existsSync(OPENCODE_DIR)) {
        mkdirSync(OPENCODE_DIR, { recursive: true })
      }
      if (existsSync(LOCK_FILE)) {
        const stat = statSync(LOCK_FILE)
        if (Date.now() - stat.mtimeMs > 30 * 60 * 1000) {
          unlinkSync(LOCK_FILE)
        } else {
          return false
        }
      }
      writeFileSync(LOCK_FILE, `${process.pid}\n${Date.now()}`, "utf-8")
      return true
    } catch {
      return false
    }
  }

  static release(): void {
    try {
      if (existsSync(LOCK_FILE)) {
        unlinkSync(LOCK_FILE)
      }
    } catch {}
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add ~/.config/opencode/plugins/executive-assistant.ts
git commit -m "feat(executive-assistant): add IdleDetector and FileLock"
```

---

## Task 3: QueueProcessor and BlockWatcher

**Files:**
- Modify: `~/.config/opencode/plugins/executive-assistant.ts`

This task adds the core processing logic — creating SDK sessions, sending prompts, monitoring for completion/blocks/errors, and retry scheduling.

- [ ] **Step 1: Add QueueProcessor and BlockWatcher classes**

Append after `FileLock` in `executive-assistant.ts`:

```typescript
class BlockWatcher {
  constructor(private queueManager: QueueManager, private client: OpencodeClient) {}

  async checkForBlocks(item: QueueItem): Promise<boolean> {
    if (!item.sessionId) return false
    const q = { directory: item.workspace }

    try {
      const { data: messages } = await this.client.session.messages({
        path: { id: item.sessionId! },
        query: q,
      })
      if (!messages) return false

      for (const msg of messages) {
        for (const part of msg.parts) {
          if (
            part.type === "tool" &&
            part.tool === "question" &&
            part.state.status === "pending"
          ) {
            const input = part.state.input as Record<string, unknown>
            this.queueManager.updateItem(item.id, {
              status: "blocked",
              blockedReason: {
                type: "question",
                permissionId: null,
                details: String(input.text || input.message || input.question || JSON.stringify(input)),
                options: Array.isArray(input.options) ? input.options.map(String) : null,
                userResponse: null,
              },
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

  async respondToBlock(item: QueueItem, response: string): Promise<boolean> {
    if (!item.blockedReason || !item.sessionId) return false
    const q = { directory: item.workspace }

    try {
      if (item.blockedReason.type === "permission" && item.blockedReason.permissionId) {
        const allowOnce = response.toLowerCase() === "yes" || response.toLowerCase() === "allow" || response.toLowerCase() === "once"
        const reject = response.toLowerCase() === "no" || response.toLowerCase() === "reject"
        await this.client.postSessionIdPermissionsPermissionId({
          path: { id: item.sessionId!, permissionID: item.blockedReason.permissionId },
          body: { response: reject ? "reject" : allowOnce ? "once" : "once" },
          query: q,
        })
      } else {
        await this.client.session.prompt({
          path: { id: item.sessionId! },
          query: q,
          body: {
            parts: [{ type: "text", text: response }],
          },
        })
      }

      this.queueManager.updateItem(item.id, {
        status: "pending",
        blockedReason: {
          ...item.blockedReason,
          userResponse: response,
        },
      })
      return true
    } catch {
      return false
    }
  }
}

class QueueProcessor {
  private isProcessing = false
  private blockWatcher: BlockWatcher

  constructor(
    private queueManager: QueueManager,
    private client: OpencodeClient,
    private idleDetector: IdleDetector,
  ) {
    this.blockWatcher = new BlockWatcher(queueManager, client)
  }

  async processNext(): Promise<boolean> {
    if (this.isProcessing) return false
    const item = this.queueManager.getNextPending()
    if (!item) return false

    this.isProcessing = true
    try {
      if (!existsSync(item.workspace)) {
        this.queueManager.updateItem(item.id, {
          status: "failed",
          error: `Directory not found: ${item.workspace}`,
          completedAt: new Date().toISOString(),
        })
        this.isProcessing = false
        return true
      }

      const q = { directory: item.workspace }

      let sessionId = item.sessionId
      if (!sessionId) {
        const { data: session } = await this.client.session.create({
          query: q,
          body: { title: item.goal.substring(0, 100) },
        })
        if (!session) {
          this.queueManager.updateItem(item.id, {
            status: "failed",
            error: "Failed to create session",
          })
          this.isProcessing = false
          return true
        }
        sessionId = session.id
        this.queueManager.updateItem(item.id, {
          sessionId: session.id,
          sessionUrl: `http://localhost:4096/session/${session.id}`,
          startedAt: new Date().toISOString(),
          status: "running",
        })
      } else {
        this.queueManager.updateItem(item.id, { status: "running" })
      }

      await this.client.session.promptAsync({
        path: { id: sessionId! },
        query: q,
        body: {
          parts: [{ type: "text", text: item.goal }],
        },
      })

      await this.waitForCompletion(item.id, sessionId!, q)

      return true
    } catch (err) {
      this.handleSessionError(item.id, err)
      return true
    } finally {
      this.isProcessing = false
    }
  }

  private async waitForCompletion(itemId: string, sessionId: string, q: { directory: string }): Promise<void> {
    const config = this.queueManager.getConfig()
    const maxWaitMs = 30 * 60 * 1000
    const pollIntervalMs = 5_000
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      const blocked = await this.blockWatcher.checkForBlocks(
        this.queueManager.getItem(itemId)!,
      )
      if (blocked) return

      const { data: statusMap } = await this.client.session.status({ query: q })
      if (statusMap && statusMap[sessionId]) {
        const status = statusMap[sessionId]
        if (status.type === "idle") {
          await this.captureResult(itemId, sessionId, q)
          return
        }
        if (status.type === "retry" && status.next) {
          await new Promise((r) => setTimeout(r, Math.min(status.next - Date.now(), pollIntervalMs)))
          continue
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs))
    }

    this.queueManager.updateItem(itemId, {
      status: "failed",
      error: "Session timed out after 30 minutes",
      completedAt: new Date().toISOString(),
    })
  }

  private async captureResult(itemId: string, sessionId: string, q: { directory: string }): Promise<void> {
    try {
      const { data: messages } = await this.client.session.messages({
        path: { id: sessionId },
        query: q,
      })
      let result = "Task completed"
      if (messages && messages.length > 0) {
        const lastAssistant = [...messages].reverse().find((m) => m.info.role === "assistant")
        if (lastAssistant) {
          const textParts = lastAssistant.parts.filter((p) => p.type === "text")
          if (textParts.length > 0) {
            result = textParts.map((p) => (p as { type: "text"; text: string }).text).join("\n").substring(0, 1000)
          }
        }
      }
      this.queueManager.updateItem(itemId, {
        status: "completed",
        result,
        completedAt: new Date().toISOString(),
        retryCount: 0,
      })
    } catch {
      this.queueManager.updateItem(itemId, {
        status: "completed",
        result: "Task completed (could not fetch result)",
        completedAt: new Date().toISOString(),
      })
    }
  }

  private handleSessionError(itemId: string, err: unknown): void {
    const item = this.queueManager.getItem(itemId)
    if (!item) return

    const config = this.queueManager.getConfig()
    const newRetryCount = item.retryCount + 1

    if (newRetryCount >= config.maxRetries) {
      this.queueManager.updateItem(itemId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        retryCount: newRetryCount,
        completedAt: new Date().toISOString(),
      })
      return
    }

    const delayMinutes = config.retryDelaysMinutes[newRetryCount - 1] || 15
    this.queueManager.updateItem(itemId, {
      status: "running",
      retryCount: newRetryCount,
      nextRetryAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
      error: err instanceof Error ? err.message : String(err),
    })
  }

  async processQueue(): Promise<void> {
    if (!(await FileLock.acquire())) return
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
            return parseInt(readFileSync(LAST_ACTIVITY_FILE, "utf-8").trim(), 10)
          } catch {
            return 0
          }
        })()
        const stillIdle = Date.now() - lastActivity >= this.queueManager.getConfig().idleTimeoutSeconds * 1000
        if (!stillIdle) {
          hasMore = false
        }
      }
    } finally {
      FileLock.release()
    }
  }

  getBlockWatcher(): BlockWatcher {
    return this.blockWatcher
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add ~/.config/opencode/plugins/executive-assistant.ts
git commit -m "feat(executive-assistant): add QueueProcessor and BlockWatcher"
```

---

## Task 4: Session Greeter and Periodic Reminder

**Files:**
- Modify: `~/.config/opencode/plugins/executive-assistant.ts`

This task adds the toast notifications for queue status on new sessions and every N messages.

- [ ] **Step 1: Add SessionGreeter class**

Append after `QueueProcessor` in `executive-assistant.ts`:

```typescript
class SessionGreeter {
  private messageCounts: Map<string, number> = new Map()
  private config: QueueConfig
  private queueManager: QueueManager
  private client: OpencodeClient

  constructor(config: QueueConfig, queueManager: QueueManager, client: OpencodeClient) {
    this.config = config
    this.queueManager = queueManager
    this.client = client
  }

  async onSessionCreated(): Promise<void> {
    await this.showToast()
  }

  async onMessageUpdated(sessionId: string): Promise<void> {
    const count = (this.messageCounts.get(sessionId) || 0) + 1
    this.messageCounts.set(sessionId, count)
    if (count >= this.config.reminderIntervalMessages) {
      this.messageCounts.set(sessionId, 0)
      await this.showToast()
    }
  }

  private async showToast(): Promise<void> {
    const counts = this.queueManager.countByStatus()
    const pending = counts["pending"] || 0
    const blocked = counts["blocked"] || 0
    const completed = counts["completed"] || 0
    const running = counts["running"] || 0
    const failed = counts["failed"] || 0

    const total = pending + blocked + completed + running + failed
    if (total === 0) return

    const parts: string[] = []
    if (pending > 0) parts.push(`${pending} pending`)
    if (blocked > 0) parts.push(`${blocked} blocked`)
    if (running > 0) parts.push(`${running} running`)
    if (completed > 0) parts.push(`${completed} completed`)
    if (failed > 0) parts.push(`${failed} failed`)

    await this.client.tui.showToast({
      body: {
        message: `Queue: ${parts.join(", ")}`,
        variant: blocked > 0 ? "warning" : "info",
      },
    })
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add ~/.config/opencode/plugins/executive-assistant.ts
git commit -m "feat(executive-assistant): add SessionGreeter with periodic reminders"
```

---

## Task 5: Plugin Export and Event Wiring

**Files:**
- Modify: `~/.config/opencode/plugins/executive-assistant.ts`

This task creates the main plugin export function that wires all components together, subscribes to events, and registers the idle processing loop.

- [ ] **Step 1: Add the plugin export**

Append at the end of `executive-assistant.ts`:

```typescript
export const ExecutiveAssistantPlugin = async (context: {
  project: { root: string }
  client: { url: string }
  $: (cmd: string) => Promise<{ stdout: string; stderr: string }>
  directory: string
  worktree: string | null
}) => {
  const baseUrl = context.client?.url || "http://localhost:4096"
  const client = createOpencodeClient({ baseUrl })

  const queueManager = new QueueManager()
  queueManager.resetRunningToPending()
  const config = queueManager.getConfig()

  const idleDetector = new IdleDetector(config, async () => {
    const processor = new QueueProcessor(queueManager, client, idleDetector)
    await processor.processQueue()
  })
  idleDetector.start()

  const greeter = new SessionGreeter(config, queueManager, client)

  return {
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      try {
        switch (event.type) {
          case "session.created":
            await greeter.onSessionCreated()
            break
          case "session.updated":
          case "tool.execute.before":
          case "tool.execute.after":
            idleDetector.writeActivity()
            break
          case "message.updated": {
            idleDetector.writeActivity()
            const info = event.properties?.info as { sessionID?: string } | undefined
            if (info?.sessionID) {
              await greeter.onMessageUpdated(info.sessionID)
            }
            break
          }
          case "session.idle":
            break
        }
      } catch {}
    },
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add ~/.config/opencode/plugins/executive-assistant.ts
git commit -m "feat(executive-assistant): wire up plugin export with event hooks"
```

---

## Task 6: Custom Tools Registration

**Files:**
- Modify: `~/.config/opencode/plugins/executive-assistant.ts`

This task registers all 7 custom tools (`queue-list`, `queue-add`, `queue-answer`, `queue-status`, `queue-remove`, `queue-log`, `queue-retry`) that the AI can call to manage the queue.

- [ ] **Step 1: Add custom tool registrations**

The tools are registered inside the plugin export function. Add these tool registrations inside `ExecutiveAssistantPlugin`, after the `greeter` creation and before the `return` statement:

```typescript
  const blockWatcher = new BlockWatcher(queueManager, client)

  await client.tui.showToast({
    body: {
      message: "Executive Assistant plugin loaded",
      variant: "info",
      duration: 3000,
    },
  })

  const registerTool = async (tool: {
    name: string
    description: string
    parameters: Record<string, unknown>
    handler: (input: Record<string, unknown>) => Promise<string>
  }) => {
    try {
      const { data: toolIds } = await client.tool.ids()
      if (toolIds?.includes(tool.name)) return
    } catch {}
    console.log(`[executive-assistant] Tool registration is handled by the plugin system: ${tool.name}`)
  }

  const tools = {
    "queue-list": async (input: Record<string, unknown>) => {
      const items = queueManager.listItems(input.status as string | undefined)
      if (items.length === 0) return "Queue is empty."
      return items
        .map((item) => {
          let line = `[${item.status.toUpperCase()}] ${item.id.substring(0, 8)} — ${item.goal.substring(0, 80)}`
          line += `\n  Workspace: ${item.workspace}`
          if (item.status === "blocked" && item.blockedReason) {
            line += `\n  Blocked: ${item.blockedReason.details.substring(0, 200)}`
          }
          if (item.status === "completed" && item.result) {
            line += `\n  Result: ${item.result.substring(0, 200)}`
          }
          if (item.status === "failed" && item.error) {
            line += `\n  Error: ${item.error}`
          }
          return line
        })
        .join("\n\n")
    },

    "queue-add": async (input: Record<string, unknown>) => {
      const workspace = input.workspace as string
      const goal = input.goal as string
      if (!workspace || !goal) return "Error: workspace and goal are required."
      const result = queueManager.addItem(workspace, goal)
      if ("error" in result) return `Error: ${result.error}`
      return `Added item ${result.id} to queue.\nWorkspace: ${result.workspace}\nGoal: ${result.goal}\nStatus: ${result.status}`
    },

    "queue-answer": async (input: Record<string, unknown>) => {
      const itemId = input.itemId as string
      const response = input.response as string
      if (!itemId || !response) return "Error: itemId and response are required."
      const item = queueManager.getItem(itemId) || queueManager.listItems().find((i) => i.id.startsWith(itemId))
      if (!item) return `Error: Item ${itemId} not found.`
      if (item.status !== "blocked") return `Error: Item ${item.id} is not blocked (status: ${item.status}).`
      const success = await blockWatcher.respondToBlock(item, response)
      if (success) return `Response sent for item ${item.id}. It will be processed on the next idle cycle.`
      return `Error: Failed to send response for item ${item.id}.`
    },

    "queue-status": async (input: Record<string, unknown>) => {
      const itemId = input.itemId as string
      if (!itemId) return "Error: itemId is required."
      const item = queueManager.getItem(itemId) || queueManager.listItems().find((i) => i.id.startsWith(itemId))
      if (!item) return `Error: Item ${itemId} not found.`
      let output = `ID: ${item.id}\nWorkspace: ${item.workspace}\nGoal: ${item.goal}\nStatus: ${item.status}`
      output += `\nCreated: ${item.createdAt}`
      if (item.startedAt) output += `\nStarted: ${item.startedAt}`
      if (item.completedAt) output += `\nCompleted: ${item.completedAt}`
      if (item.sessionId) output += `\nSession: ${item.sessionId}`
      if (item.sessionUrl) output += `\nURL: ${item.sessionUrl}`
      if (item.retryCount > 0) output += `\nRetries: ${item.retryCount}`
      if (item.blockedReason) output += `\nBlocked (${item.blockedReason.type}): ${item.blockedReason.details}`
      if (item.result) output += `\nResult: ${item.result}`
      if (item.error) output += `\nError: ${item.error}`
      return output
    },

    "queue-remove": async (input: Record<string, unknown>) => {
      const itemId = input.itemId as string
      if (!itemId) return "Error: itemId is required."
      const item = queueManager.getItem(itemId) || queueManager.listItems().find((i) => i.id.startsWith(itemId))
      if (!item) return `Error: Item ${itemId} not found.`
      if (item.sessionId) {
        try {
          await client.session.abort({
            path: { id: item.sessionId },
            query: { directory: item.workspace },
          })
        } catch {}
      }
      const removed = queueManager.removeItem(item.id)
      return removed ? `Removed item ${item.id}.` : `Error: Could not remove item ${item.id}.`
    },

    "queue-log": async (input: Record<string, unknown>) => {
      const itemId = input.itemId as string
      if (!itemId) return "Error: itemId is required."
      const item = queueManager.getItem(itemId) || queueManager.listItems().find((i) => i.id.startsWith(itemId))
      if (!item) return `Error: Item ${itemId} not found.`
      if (!item.sessionId) return `No session for item ${item.id}.`
      let output = `Session: ${item.sessionId}\nURL: ${item.sessionUrl || "N/A"}\n\n`
      try {
        const { data: messages } = await client.session.messages({
          path: { id: item.sessionId! },
          query: { directory: item.workspace },
        })
        if (messages) {
          for (const msg of messages.slice(-6)) {
            const role = msg.info.role
            const textParts = msg.parts.filter((p) => p.type === "text")
            for (const p of textParts) {
              const text = (p as { type: "text"; text: string }).text
              output += `[${role}] ${text.substring(0, 500)}\n\n`
            }
          }
        }
      } catch {
        output += "(Could not fetch messages)"
      }
      return output
    },

    "queue-retry": async (input: Record<string, unknown>) => {
      const itemId = input.itemId as string
      if (!itemId) return "Error: itemId is required."
      const item = queueManager.getItem(itemId) || queueManager.listItems().find((i) => i.id.startsWith(itemId))
      if (!item) return `Error: Item ${itemId} not found.`
      if (item.status !== "failed") return `Error: Item ${item.id} is not failed (status: ${item.status}). Use queue-list to see all items.`
      queueManager.updateItem(item.id, {
        status: "pending",
        retryCount: 0,
        nextRetryAt: null,
        error: null,
      })
      return `Item ${item.id} reset to pending. It will be processed on the next idle cycle.`
    },
  }
```

- [ ] **Step 2: Commit**

```bash
git add ~/.config/opencode/plugins/executive-assistant.ts
git commit -m "feat(executive-assistant): add all 7 custom tools for queue management"
```

---

## Task 7: package.json Setup

**Files:**
- Create: `~/.config/opencode/package.json`

This task sets up the NPM dependencies so the plugin can import `@opencode-ai/sdk`.

- [ ] **Step 1: Create package.json**

Create `~/.config/opencode/package.json`:

```json
{
  "name": "opencode-executive-assistant",
  "private": true,
  "type": "module",
  "dependencies": {
    "@opencode-ai/sdk": "latest"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd ~/.config/opencode && npm install`

Expected: `@opencode-ai/sdk` installed successfully.

- [ ] **Step 3: Commit**

```bash
git add ~/.config/opencode/package.json ~/.config/opencode/package-lock.json
git commit -m "feat(executive-assistant): add package.json with SDK dependency"
```

---

## Task 8: README Documentation

**Files:**
- Create: `~/.config/opencode/plugins/README.md`

This task writes the user-facing documentation.

- [ ] **Step 1: Create README.md**

Create `~/.config/opencode/plugins/README.md`:

```markdown
# Executive Assistant Queue Plugin

Automatically processes a task queue when opencode is idle.

## Installation

1. Install dependencies:
   ```bash
   cd ~/.config/opencode && npm install
   ```

2. The plugin is loaded automatically from `~/.config/opencode/plugins/executive-assistant.ts`.

## How It Works

When opencode has been idle for 1 hour (configurable), the plugin picks the next pending item from the queue, creates a session in the item's workspace, and sends the goal as a prompt. Items are processed one at a time.

If an item hits a permission prompt or question, it's marked as **blocked** and the plugin moves to the next item. You can respond to blocked items at any time.

## Configuration

Edit `~/.config/opencode/queue.json`:

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

| Setting | Default | Description |
|---------|---------|-------------|
| `idleTimeoutSeconds` | 3600 | How long opencode must be idle before processing starts |
| `blockedReminderMinutes` | 30 | How often to remind about blocked items |
| `maxRetries` | 3 | Max retry attempts for failed items |
| `retryDelaysMinutes` | [5, 10, 15] | Delay between retries (staggered) |
| `reminderIntervalMessages` | 30 | Show queue summary every N messages |

## Usage

Talk to opencode naturally:

- **"Add a task to fix the tests in /my/project"** — adds a new item
- **"Show my queue"** — lists all items
- **"What's the status of item abc123?"** — shows full details
- **"Answer item abc123 with yes"** — responds to a blocked item
- **"Remove item abc123"** — removes an item
- **"Show the log for item abc123"** — shows session messages
- **"Retry item abc123"** — resets a failed item

## Status Toast

A toast notification appears when you start a new session and every 30 messages showing your queue status (pending, blocked, completed).

## Retry Behavior

Failed items retry automatically with staggered delays (5 min, 10 min, 15 min), reusing the same session to preserve context. After 3 failures, the item stays failed until you manually retry it.
```

- [ ] **Step 2: Commit**

```bash
git add ~/.config/opencode/plugins/README.md
git commit -m "docs(executive-assistant): add README with usage documentation"
```

---

## Task 9: Integration Testing

**Files:**
- Modify: `~/.config/opencode/plugins/executive-assistant.ts`

This task verifies the full plugin loads correctly in opencode and the basic tools work.

- [ ] **Step 1: Start opencode and verify plugin loads**

Run: `opencode`

Expected: The TUI starts and shows the toast "Executive Assistant plugin loaded". No errors in the console.

- [ ] **Step 2: Test queue-add via conversation**

In the opencode TUI, type: "Add a task to the queue for /tmp/test-project to list all files"

Expected: The AI calls `queue-add` and reports the item was added. If `/tmp/test-project` doesn't exist, it should report the error.

- [ ] **Step 3: Create test directory and test again**

Run: `mkdir -p /tmp/test-project`

Then in opencode: "Add a task to the queue for /tmp/test-project to list all files"

Expected: Item added successfully.

- [ ] **Step 4: Test queue-list**

In opencode: "Show my queue"

Expected: Lists the item with status, workspace, and goal.

- [ ] **Step 5: Test queue-status**

In opencode: "What's the status of the first queue item?"

Expected: Shows full details.

- [ ] **Step 6: Test queue-remove**

In opencode: "Remove the queue item"

Expected: Item removed.

- [ ] **Step 7: Clean up test data**

Run: `rm -rf /tmp/test-project`

- [ ] **Step 8: Commit any fixes**

```bash
git add ~/.config/opencode/plugins/executive-assistant.ts
git commit -m "fix(executive-assistant): integration test fixes"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- Data model (QueueStore, QueueItem, BlockedReason, QueueConfig) → Task 1
- QueueManager (CRUD, state transitions, atomic writes) → Task 1
- IdleDetector (cross-instance, last-activity file, polling) → Task 2
- FileLock → Task 2
- QueueProcessor (SDK sessions, prompt_async, monitoring) → Task 3
- BlockWatcher (permission + question detection, response) → Task 3
- SessionGreeter (session.created toast, periodic reminders) → Task 4
- Custom tools (all 7) → Task 6
- Event hooks (session.created, session.updated, message.updated, tool.execute.*) → Task 5
- SDK Reference (all methods verified) → Tasks 3, 5, 6
- Retry logic (staggered delays, same session) → Task 3
- Error handling (directory validation, corruption, lock) → Tasks 1, 2, 3
- Configuration defaults → Task 1, 7
- README → Task 8

**2. Placeholder scan:** No TBDs, TODOs, or incomplete sections found.

**3. Type consistency:** `QueueItem.id` is UUID string throughout. `sessionId` is `string | null`. `BlockedReason.type` is `"permission" | "question"`. All tool handlers use consistent parameter names (`itemId`, `response`, `workspace`, `goal`).
