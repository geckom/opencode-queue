import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createPluginHooks, createMockClient, loadBuiltModules, sleep, withTempRepo } from "./helpers.mjs"

test("queue tools work from the built plugin", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { hooks, restoreTimers } = await createPluginHooks({ configHome, workspace, stubTimers: true })
    try {
      const addResult = await hooks.tool["queue-add"].execute({ workspace, goal: "Fix the plugin" })
      assert.match(addResult, /Added /)

      const listResult = await hooks.tool["queue-list"].execute({})
      assert.match(listResult, /Fix the plugin/)

      const queuePath = join(configHome, "opencode", "queue.json")
      const store = JSON.parse(readFileSync(queuePath, "utf8"))
      const itemId = store.items[0].id

      const fullResult = await hooks.tool["queue-list"].execute({ itemId, view: "full" })
      assert.match(fullResult, new RegExp(itemId))

      const removeResult = await hooks.tool["queue-remove"].execute({ itemId })
      assert.equal(removeResult, `Removed item ${itemId}.`)
    } finally {
      restoreTimers?.()
    }
  })
})

test("queue-add stores parent dependency settings", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { hooks, testingModule, restoreTimers } = await createPluginHooks({ configHome, workspace, stubTimers: true })
    const { QueueManager } = testingModule
    try {
      await hooks.tool["queue-add"].execute({ workspace, goal: "Parent task" })
      const queueManager = new QueueManager()
      const parentId = queueManager.listItems()[0].id

      const childResult = await hooks.tool["queue-add"].execute({
        workspace,
        goal: "Child task",
        parentItemId: parentId,
        dependencyMode: "completed",
      })

      assert.match(childResult, /Depends:/)

      const child = queueManager.listItems().find((item) => item.goal === "Child task")
      assert.equal(child.parentItemId, parentId)
      assert.equal(child.dependencyMode, "completed")
    } finally {
      restoreTimers?.()
    }
  })
})

test("queue-confirm marks a review item completed", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { hooks, testingModule, restoreTimers } = await createPluginHooks({ configHome, workspace, stubTimers: true })
    const { QueueManager } = testingModule
    try {
      const queueManager = new QueueManager()
      const created = await queueManager.addItem(workspace, "Review this task")
      assert.ok("id" in created)
      await queueManager.updateItem(created.id, {
        status: "review_pending",
        result: "Looks done",
        sessionId: "s1",
      })

      const confirmResult = await hooks.tool["queue-confirm"].execute({ itemId: created.id })
      assert.equal(confirmResult, `Item ${created.id} marked completed.`)

      const item = queueManager.getItem(created.id)
      assert.equal(item?.status, "completed")
      assert.equal(typeof item?.completedAt, "string")
      assert.equal(typeof item?.reviewedAt, "string")
    } finally {
      restoreTimers?.()
    }
  })
})

test("queue-followup continues a review item and marks descendants stale", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const prompts = []
    const client = createMockClient()
    client.session.promptAsync = async (payload) => {
      prompts.push(payload)
      return { data: undefined }
    }

    const { hooks, testingModule, restoreTimers } = await createPluginHooks({
      configHome,
      workspace,
      client,
      stubTimers: true,
    })
    const { QueueManager } = testingModule
    try {
      const queueManager = new QueueManager()
      for (const existing of queueManager.listItems()) {
        await queueManager.removeItem(existing.id)
      }
      const unrelated = await queueManager.addItem(workspace, "Unrelated pending task")
      assert.ok("id" in unrelated)
      const parent = await queueManager.addItem(workspace, "Parent task")
      assert.ok("id" in parent)
      const child = await queueManager.addItem(workspace, "Child task", { parentItemId: parent.id })
      assert.ok("id" in child)

      await queueManager.updateItem(parent.id, {
        status: "review_pending",
        result: "Parent output",
        sessionId: "s1",
      })
      await queueManager.updateItem(child.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        dependencySatisfiedAt: new Date().toISOString(),
        dependencySourceStatus: "review_pending",
      })

      const followupResult = await hooks.tool["queue-followup"].execute({
        itemId: parent.id,
        message: "Please revise the parent output.",
      })

      assert.equal(followupResult, `Follow-up queued for ${parent.id}.`)
      assert.equal(prompts.length, 0)

      const updatedParent = queueManager.getItem(parent.id)
      const updatedChild = queueManager.getItem(child.id)
      assert.equal(updatedParent?.status, "pending")
      assert.equal(updatedParent?.followupMessage, "Please revise the parent output.")
      assert.equal(updatedChild?.staleDependency, true)
    } finally {
      restoreTimers?.()
    }
  })
})

test("processNext handles followupMessage items by reusing session", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const prompts = []
    const client = createMockClient()
    client.session.promptAsync = async (payload) => {
      prompts.push(payload)
      return { data: undefined }
    }

    const { testingModule, restoreTimers } = await createPluginHooks({
      configHome,
      workspace,
      client,
      stubTimers: true,
    })
    const { QueueManager, QueueProcessor } = testingModule
    try {
      const queueManager = new QueueManager()
      for (const existing of queueManager.listItems()) {
        await queueManager.removeItem(existing.id)
      }

      const item = await queueManager.addItem(workspace, "Original task")
      assert.ok("id" in item)

      await queueManager.updateItem(item.id, {
        status: "pending",
        sessionId: "existing-session",
        followupMessage: "Please revise the output.",
      })

      const processor = new QueueProcessor(queueManager, client, { getConfig: () => queueManager.getConfig() }, new URL("http://127.0.0.1:4096"))
      const processed = await processor.processNext()

      assert.equal(processed, true)
      assert.equal(prompts.length, 1)
      assert.equal(prompts[0].body.parts[0].text, "Please revise the output.")

      const updated = queueManager.getItem(item.id)
      assert.equal(updated?.status, "review_pending")
      assert.equal(updated?.followupMessage, null)
    } finally {
      restoreTimers?.()
    }
  })
})

test("repeated plugin loads share a single coordinator timer and only one event hook", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    let timerStarts = 0
    globalThis.setInterval = () => {
      timerStarts += 1
      return 1
    }
    globalThis.clearInterval = () => {}

    try {
      const { pluginModule } = await loadBuiltModules(configHome)
      const context = {
        client: createMockClient(),
        project: { id: "p1", name: "test", root: workspace, path: workspace },
        directory: workspace,
        worktree: workspace,
        serverUrl: new URL("http://127.0.0.1:4096"),
        experimental_workspace: { register() {} },
        $: async () => ({ stdout: "", stderr: "" }),
      }

      const firstHooks = await pluginModule.default(context)
      const secondHooks = await pluginModule.default(context)

      assert.equal(timerStarts, 2)
      assert.equal(typeof firstHooks.event, "function")
      assert.equal(secondHooks.event, undefined)
      assert.equal(typeof firstHooks["tool.execute.before"], "function")
      assert.equal(typeof secondHooks["tool.execute.before"], "function")
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    }
  })
})

test("blocked reminder setting produces warning toasts for blocked items", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const toasts = []
    const client = createMockClient()
    client.tui.showToast = async ({ body }) => {
      toasts.push(body)
      return { data: true }
    }

    const { testingModule, restoreTimers } = await createPluginHooks({
      configHome,
      workspace,
      client,
      stubTimers: true,
    })
    const { QueueManager, SessionGreeter } = testingModule

    try {
      const queueManager = new QueueManager()
      await queueManager.updateConfig({ blockedReminderMinutes: 0 })
      const created = await queueManager.addItem(workspace, "Needs answer")
      assert.ok("id" in created)
      await queueManager.updateItem(created.id, {
        status: "blocked",
        blockedReason: {
          type: "question",
          permissionId: null,
          requestId: null,
          details: "What framework?",
          options: null,
          userResponse: null,
        },
      })

      const greeter = new SessionGreeter(() => queueManager.getConfig(), queueManager, client)
      await greeter.checkBlockedReminder()
      await sleep(1)

      assert.ok(
        toasts.some((toast) => typeof toast.message === "string" && toast.message.includes("Queue blocked: 1 item")),
      )
      greeter.stop()
    } finally {
      restoreTimers?.()
    }
  })
})
