import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createPluginHooks, createMockClient, loadBuiltModules, withTempRepo } from "./helpers.mjs"

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
    client.session.prompt = async (payload) => {
      prompts.push(payload)
      return { data: { id: "m1" } }
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

      assert.equal(followupResult, `Follow-up sent for ${parent.id}.`)
      assert.equal(prompts.length, 1)
      assert.equal(prompts[0].body.parts[0].text, "Please revise the parent output.")

      const updatedParent = queueManager.getItem(parent.id)
      const updatedChild = queueManager.getItem(child.id)
      assert.equal(updatedParent?.status, "review_pending")
      assert.match(updatedParent?.result || "", /Task finished successfully/)
      assert.equal(updatedChild?.staleDependency, true)
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

      assert.equal(timerStarts, 1)
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
