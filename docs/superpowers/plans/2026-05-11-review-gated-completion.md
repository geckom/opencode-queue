# Review-Gated Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Queue items transition to `review_pending` instead of `completed` after a session finishes, requiring explicit human confirmation via a new tool before they are marked complete.

**Architecture:** Add a `review_pending` status to the queue state machine. When a session goes idle, `captureResult()` writes the result but sets status to `review_pending` instead of `completed`. Two new tools are added: `queue-confirm` marks items complete, and `queue-followup` appends a follow-up prompt to the goal and requeues the item. The existing `queue-list` tool gains a `review_pending` filter for discovery.

**Tech Stack:** TypeScript, OpenCode Plugin SDK (`@opencode-ai/plugin`), Zod schemas, Node.js test runner.

---

## File Structure

- **Modify:** `src/opencode-queue.ts` — status enum, `captureResult()`, `BlockWatcher`, new tools
- **Modify:** `test/plugin.test.mjs` — update existing assertions, add new tests
- **No new files** created

---

### Task 1: Add `review_pending` to the status type

**Files:**
- Modify: `src/opencode-queue.ts:34`
- Modify: `src/opencode-queue.ts:753`

- [ ] **Step 1: Update the QueueItem status union**

In `src/opencode-queue.ts`, change line 34 from:

```typescript
status: "pending" | "running" | "blocked" | "completed" | "failed"
```

to:

```typescript
status: "pending" | "running" | "blocked" | "review_pending" | "completed" | "failed"
```

- [ ] **Step 2: Update the queue-list tool status enum**

In the `queue-list` tool definition (around line 753), change the enum array from:

```typescript
tool.schema.enum(["pending", "running", "blocked", "completed", "failed"])
```

to:

```typescript
tool.schema.enum(["pending", "running", "blocked", "review_pending", "completed", "failed"])
```

- [ ] **Step 3: Build and verify compilation**

Run: `npm run build`
Expected: Compiles without errors.

---

### Task 2: Add `reviewPendingBeforeBlock` field to QueueItem

**Files:**
- Modify: `src/opencode-queue.ts:30-45`

- [ ] **Step 1: Add the field to the interface**

In `src/opencode-queue.ts`, add `reviewPendingBeforeBlock` to the `QueueItem` interface (after line 44, before `retryCount`):

```typescript
reviewPendingBeforeBlock: boolean
```

- [ ] **Step 2: Initialize the field in addItem()**

In `QueueManager.addItem()` (around line 118, after `nextRetryAt: null,`), add:

```typescript
reviewPendingBeforeBlock: false,
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

---

### Task 3: Change `captureResult()` to set `review_pending`

**Files:**
- Modify: `src/opencode-queue.ts:556-585`

- [ ] **Step 1: Write the failing test**

In `test/plugin.test.mjs`, add a new test at the end of the file:

```javascript
test("captureResult sets review_pending instead of completed", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const { default: OpencodeQueuePlugin } = await loadPluginModule(configHome)
    const { QueueManager, QueueProcessor, IdleDetector } = OpencodeQueuePlugin.__internals

    const queueManager = new QueueManager()
    const created = queueManager.addItem(workspace, "Run the queued task")
    assert.ok("id" in created)

    const client = createMockClient()
    const idleDetector = new IdleDetector(queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector)

    await processor.processNext()

    const item = queueManager.listItems()[0]
    assert.equal(item.status, "review_pending")
    assert.equal(item.result, "Task finished successfully")
    assert.equal(item.completedAt, null)
  } finally {
    rmSync(configHome, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: The new test FAILS with `AssertionError: expected "completed" to equal "review_pending"`. Existing tests that assert `status === "completed"` after processing will also fail — that is expected at this step.

- [ ] **Step 3: Update captureResult()**

In `src/opencode-queue.ts`, change the `captureResult()` method. Replace the success path in the try block (lines 572-577):

```typescript
      this.queueManager.updateItem(itemId, {
        status: "completed",
        result,
        completedAt: new Date().toISOString(),
        retryCount: 0,
      })
```

with:

```typescript
      this.queueManager.updateItem(itemId, {
        status: "review_pending",
        result,
        retryCount: 0,
      })
```

And replace the catch block (lines 579-583):

```typescript
      this.queueManager.updateItem(itemId, {
        status: "completed",
        result: "Task completed (could not fetch result)",
        completedAt: new Date().toISOString(),
      })
```

with:

```typescript
      this.queueManager.updateItem(itemId, {
        status: "review_pending",
        result: "Task completed (could not fetch result)",
        retryCount: 0,
      })
```

- [ ] **Step 4: Update existing tests that assert "completed"**

In `test/plugin.test.mjs`, update the following tests to expect `"review_pending"` instead of `"completed"`:

In `"processor completes a pending item and stores the result"` (around line 127):
```javascript
assert.equal(item.status, "review_pending")
```

In `"processor treats a missing session.status entry as completed"` (around line 158):
```javascript
assert.equal(item.status, "review_pending")
```

In `"processor does not complete early on a missing status before assistant output"` (around line 214):
```javascript
assert.equal(item.status, "review_pending")
```

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: All tests PASS, including the new one.

- [ ] **Step 6: Commit**

```bash
git add src/opencode-queue.ts test/plugin.test.mjs
git commit -m "feat: set review_pending instead of completed after session idle"
```

---

### Task 4: Update BlockWatcher to track pre-block status

**Files:**
- Modify: `src/opencode-queue.ts:263-342` (handleEvent)
- Modify: `src/opencode-queue.ts:393-429` (respondToBlock)

- [ ] **Step 1: Write the failing test**

In `test/plugin.test.mjs`, add:

```javascript
test("block on review_pending item tracks pre-block state and restores it", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const { default: OpencodeQueuePlugin } = await loadPluginModule(configHome)
    const { QueueManager, BlockWatcher } = OpencodeQueuePlugin.__internals
    const queueManager = new QueueManager()
    const created = queueManager.addItem(workspace, "Needs permission during review")
    assert.ok("id" in created)
    const itemId = created.id

    queueManager.updateItem(itemId, {
      status: "review_pending",
      sessionId: "s1",
      result: "Some result",
      reviewPendingBeforeBlock: false,
    })

    const watcher = new BlockWatcher(queueManager, createMockClient())
    watcher.handleEvent({
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "s1",
        permission: "edit files",
        patterns: ["src/**"],
      },
    })

    const blockedItem = queueManager.getItem(itemId)
    assert.equal(blockedItem?.status, "blocked")
    assert.equal(blockedItem?.reviewPendingBeforeBlock, true)
  } finally {
    rmSync(configHome, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: The new test FAILS because `handleEvent` only finds `running` items, not `review_pending`.

- [ ] **Step 3: Update handleEvent to track reviewPendingBeforeBlock**

In `src/opencode-queue.ts`, update both the `permission.asked` handler (around line 277) and the `question.asked` handler (around line 311). For each, change the `.find()` filter from:

```typescript
.find((candidate) => candidate.sessionId === permission.sessionID)
```

to:

```typescript
.find((candidate) => candidate.sessionId === permission.sessionID && (candidate.status === "running" || candidate.status === "review_pending"))
```

And in the `updateItem` call, add the `reviewPendingBeforeBlock` field. For `permission.asked` (around line 285):

```typescript
      this.queueManager.updateItem(item.id, {
        status: "blocked",
        reviewPendingBeforeBlock: item.status === "review_pending",
        blockedReason: {
          type: "permission",
          permissionId: typeof permission.id === "string" ? permission.id : null,
          requestId: typeof permission.id === "string" ? permission.id : null,
          details: details || "Permission request pending",
          options: ["once", "always", "reject"],
          userResponse: null,
        },
      })
```

For `question.asked` (around line 330):

```typescript
      this.queueManager.updateItem(item.id, {
        status: "blocked",
        reviewPendingBeforeBlock: item.status === "review_pending",
        blockedReason: {
          type: "question",
          permissionId: null,
          requestId: typeof question.id === "string" ? question.id : null,
          details: details || "Question pending",
          options: options.length > 0 ? options : null,
          userResponse: null,
        },
      })
```

Also update `checkForBlocks()` (around line 364) to watch `review_pending` items too. Change the updateItem call to include the flag:

```typescript
            this.queueManager.updateItem(item.id, {
              status: "blocked",
              reviewPendingBeforeBlock: item.status === "review_pending",
              blockedReason: {
```

- [ ] **Step 4: Update respondToBlock to restore correct status**

In `src/opencode-queue.ts`, update `respondToBlock()` (around line 418). Change the status in the updateItem call from:

```typescript
        status: "pending",
```

to:

```typescript
        status: item.reviewPendingBeforeBlock ? "review_pending" : "pending",
```

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/opencode-queue.ts test/plugin.test.mjs
git commit -m "feat: track review_pending state across block/unblock cycles"
```

---

### Task 5: Add `queue-confirm` tool

**Files:**
- Modify: `src/opencode-queue.ts:749-900` (tool definitions)

- [ ] **Step 1: Write the failing test**

In `test/plugin.test.mjs`, add:

```javascript
test("queue-confirm marks review_pending item as completed", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const { default: OpencodeQueuePlugin } = await loadPluginModule(configHome)
    const hooks = await OpencodeQueuePlugin({
      client: createMockClient(),
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    })

    const queueManager = new (OpencodeQueuePlugin.__internals.QueueManager)()
    const item = queueManager.addItem(workspace, "Review me")
    assert.ok("id" in item)
    queueManager.updateItem(item.id, {
      status: "review_pending",
      result: "Did the thing",
    })

    const confirmResult = await hooks.tool["queue-confirm"].execute({
      itemId: item.id,
    })
    assert.match(confirmResult, /confirmed/)

    const updated = queueManager.getItem(item.id)
    assert.equal(updated?.status, "completed")
    assert.ok(updated?.completedAt)
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    rmSync(configHome, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: The new test FAILS because `queue-confirm` tool does not exist.

- [ ] **Step 3: Implement queue-confirm tool**

In `src/opencode-queue.ts`, add the `queue-confirm` tool inside the `tool: { ... }` object (after the `queue-retry` tool, before the closing `}`):

```typescript
      "queue-confirm": tool({
        description: "Mark a review-pending queue item as completed after human review.",
        args: {
          itemId: tool.schema.string().describe("Item ID (full or prefix)"),
          feedback: tool.schema.string().optional().describe("Optional review notes appended to result"),
        },
        async execute(args) {
          const item = queueManager.getItem(args.itemId) || queueManager.listItems().find((i) => i.id.startsWith(args.itemId))
          if (!item) return `Error: Item ${args.itemId} not found.`
          if (item.status !== "review_pending") return `Error: Item ${item.id} is not awaiting review (status: ${item.status}).`
          const feedback = args.feedback ? `\n---\nReview: ${args.feedback}` : ""
          queueManager.updateItem(item.id, {
            status: "completed",
            completedAt: new Date().toISOString(),
            result: item.result + feedback,
          })
          return `Item ${item.id} confirmed complete.`
        },
      }),
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/opencode-queue.ts test/plugin.test.mjs
git commit -m "feat: add queue-confirm tool for review-gated completion"
```

---

### Task 6: Add `queue-followup` tool

**Files:**
- Modify: `src/opencode-queue.ts:749-900` (tool definitions)

- [ ] **Step 1: Write the failing test**

In `test/plugin.test.mjs`, add:

```javascript
test("queue-followup requeues review_pending item with follow-up prompt", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const { default: OpencodeQueuePlugin } = await loadPluginModule(configHome)
    const client = createMockClient()
    const hooks = await OpencodeQueuePlugin({
      client,
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    })

    const queueManager = new (OpencodeQueuePlugin.__internals.QueueManager)()
    const item = queueManager.addItem(workspace, "Do the thing")
    assert.ok("id" in item)
    queueManager.updateItem(item.id, {
      status: "review_pending",
      sessionId: "s1",
      result: "Did the thing",
    })

    const followupResult = await hooks.tool["queue-followup"].execute({
      itemId: item.id,
      prompt: "Also run the tests",
    })
    assert.match(followupResult, /requeued/)

    const updated = queueManager.getItem(item.id)
    assert.equal(updated?.status, "pending")
    assert.equal(updated?.result, null)
    assert.ok(updated?.goal.includes("Also run the tests"))
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    rmSync(configHome, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: The new test FAILS because `queue-followup` tool does not exist.

- [ ] **Step 3: Implement queue-followup tool**

In `src/opencode-queue.ts`, add the `queue-followup` tool inside the `tool: { ... }` object (after `queue-confirm`):

```typescript
      "queue-followup": tool({
        description: "Send a follow-up prompt to a review-pending item's session. Appends to the task goal and requeues the item for processing on the next idle cycle.",
        args: {
          itemId: tool.schema.string().describe("Item ID (full or prefix)"),
          prompt: tool.schema.string().describe("Follow-up instruction to append to the task"),
        },
        async execute(args) {
          const item = queueManager.getItem(args.itemId) || queueManager.listItems().find((i) => i.id.startsWith(args.itemId))
          if (!item) return `Error: Item ${args.itemId} not found.`
          if (item.status !== "review_pending") return `Error: Item ${item.id} is not awaiting review (status: ${item.status}).`
          if (!item.sessionId) return `Error: Item ${item.id} has no session.`
          queueManager.updateItem(item.id, {
            status: "pending",
            goal: `${item.goal}\n\nFollow-up: ${args.prompt}`,
            result: null,
            retryCount: 0,
            nextRetryAt: null,
          })
          return `Item ${item.id} requeued with follow-up: "${args.prompt}". It will be processed on the next idle cycle.`
        },
      }),
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/opencode-queue.ts test/plugin.test.mjs
git commit -m "feat: add queue-followup tool to requeue items with follow-up prompts"
```

---

### Task 7: Update queue-status and queue-list output for review_pending

**Files:**
- Modify: `src/opencode-queue.ts:750-775` (queue-list output)
- Modify: `src/opencode-queue.ts:808-827` (queue-status output)

- [ ] **Step 1: Update queue-list output to show review_pending results**

In the `queue-list` tool's `execute` function (around line 765), add a display block for `review_pending` items. After the `blocked` display block and before the `completed` display block, add:

```typescript
              if (item.status === "review_pending" && item.result) {
                line += `\n  Result: ${item.result.substring(0, 200)}`
              }
```

- [ ] **Step 2: Update queue-status output to show review_pending fields**

In the `queue-status` tool's `execute` function, after the `completedAt` line (around line 818), add:

```typescript
          if (item.status === "review_pending" && item.result) output += `\nResult: ${item.result}`
```

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/opencode-queue.ts
git commit -m "feat: display review_pending items in queue-list and queue-status output"
```

---

### Task 8: Update toast counts for review_pending

**Files:**
- Modify: `src/opencode-queue.ts:671-690` (SessionGreeter.showToast)

- [ ] **Step 1: Add review_pending count to toast**

In `SessionGreeter.showToast()` (around line 672), add a `reviewPending` count extraction:

```typescript
    const reviewPending = counts["review_pending"] || 0
```

And add it to the parts array (after `running` line, before `completed`):

```typescript
    if (reviewPending > 0) parts.push(`${reviewPending} review`)
```

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/opencode-queue.ts
git commit -m "feat: show review_pending count in queue toast notifications"
```

---

### Task 9: Build, deploy, and smoke test

**Files:**
- No file changes — verification only

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 2: Build the plugin**

Run: `npm run build`
Expected: Compiles without errors.

- [ ] **Step 3: Run pack check**

Run: `npm run pack:check`
Expected: No issues reported.

- [ ] **Step 4: Build runtime artifact**

Run: `npm run build:runtime`
Expected: File copied to `~/.config/opencode/plugins/opencode-queue.js`.

- [ ] **Step 5: Smoke test**

Run: `opencode --print-logs debug config`
Expected: Plugin loads without errors, tools visible in the tool list.

---

## Self-Review

### Spec Coverage

| Requirement | Task |
|---|---|
| `review_pending` status type | Task 1 |
| `reviewPendingBeforeBlock` field | Task 2 |
| `captureResult()` sets `review_pending` | Task 3 |
| BlockWatcher tracks pre-block state | Task 4 |
| `queue-confirm` tool | Task 5 |
| `queue-followup` tool (requeues to pending, appends to goal) | Task 6 |
| Output formatting for `review_pending` | Task 7 |
| Toast counts | Task 8 |
| Build/deploy/smoke test | Task 9 |

### Placeholder Scan

No TBDs, TODOs, or "implement later" patterns found. All code blocks contain complete implementations.

### Type Consistency

- `QueueItem.status` union includes `"review_pending"` (Task 1) — used consistently in Tasks 3, 4, 5, 6, 7, 8
- `QueueItem.reviewPendingBeforeBlock: boolean` (Task 2) — initialized in `addItem()`, set in `handleEvent()`, read in `respondToBlock()`
- `queue-confirm` args: `itemId: string`, `feedback?: string` (Task 5)
- `queue-followup` args: `itemId: string`, `prompt: string` (Task 6)
- Tool names `"queue-confirm"` and `"queue-followup"` used consistently across tests and implementation
