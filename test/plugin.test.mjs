import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const moduleUrl = pathToFileURL(new URL("../dist/opencode-queue.js", import.meta.url).pathname).href

function createTempConfigHome() {
  return mkdtempSync(join(tmpdir(), "ea-plugin-"))
}

async function loadPluginModule(configHome) {
  process.env.XDG_CONFIG_HOME = configHome
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`)
}

function resetPluginState(pluginModule) {
  pluginModule.default.__internals.resetSharedState()
}

function createMockClient() {
  const statusResponses = [{ s1: { type: "busy" } }, { s1: { type: "idle" } }]
  return {
    tui: {
      async showToast() {
        return { data: true }
      },
    },
    session: {
      async create() {
        return { data: { id: "s1" } }
      },
      async promptAsync() {
        return { data: undefined }
      },
      async prompt() {
        return { data: { id: "m1" } }
      },
      async abort() {
        return { data: true }
      },
      async status() {
        return { data: statusResponses.shift() ?? { s1: { type: "idle" } } }
      },
      async messages() {
        return {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Task finished successfully" }],
            },
          ],
        }
      },
    },
    async postSessionIdPermissionsPermissionId() {
      return { data: true }
    },
  }
}

test("queue tools work from the built plugin", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const hooks = await OpencodeQueuePlugin({
      client: createMockClient(),
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    })

    const addResult = await hooks.tool["queue-add"].execute({
      workspace,
      goal: "Fix the plugin",
    })
    assert.match(addResult, /Added /)

    const listResult = await hooks.tool["queue-list"].execute({})
    assert.match(listResult, /Fix the plugin/)

    const queuePath = join(configHome, "opencode", "queue.json")
    const store = JSON.parse(readFileSync(queuePath, "utf8"))
    const itemId = store.items[0].id

    const statusResult = await hooks.tool["queue-list"].execute({ itemId, view: "full" })
    assert.match(statusResult, new RegExp(itemId))

    const removeResult = await hooks.tool["queue-remove"].execute({ itemId })
    assert.equal(removeResult, `Removed item ${itemId}.`)
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("queue-add stores parent dependency settings", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const hooks = await OpencodeQueuePlugin({
      client: createMockClient(),
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    })

    const parentResult = await hooks.tool["queue-add"].execute({
      workspace,
      goal: "Parent task",
    })
    assert.match(parentResult, /Added /)

    const queuePath = join(configHome, "opencode", "queue.json")
    const store = JSON.parse(readFileSync(queuePath, "utf8"))
    const parentId = store.items[0].id

    const childResult = await hooks.tool["queue-add"].execute({
      workspace,
      goal: "Child task",
      parentItemId: parentId,
      dependencyMode: "completed",
    })
    assert.match(childResult, /Depends:/)

    const updatedStore = JSON.parse(readFileSync(queuePath, "utf8"))
    const child = updatedStore.items.find((item) => item.goal === "Child task")
    assert.equal(child.parentItemId, parentId)
    assert.equal(child.dependencyMode, "completed")
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("processor moves a finished pending item into review and stores the result", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const { QueueManager, QueueProcessor, IdleDetector } = OpencodeQueuePlugin.__internals

    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Run the queued task")
    assert.ok("id" in created)

    const client = createMockClient()
    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))

    const processed = await processor.processNext()
    assert.equal(processed, true)

    const item = queueManager.listItems()[0]
    assert.equal(item.status, "review_pending")
    assert.match(item.result, /Task finished successfully/)
    assert.equal(item.sessionId, "s1")
    assert.equal(item.completedAt, null)
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("processor treats a missing session.status entry as review-ready", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const { QueueManager, QueueProcessor, IdleDetector } = OpencodeQueuePlugin.__internals

    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Run the queued task")
    assert.ok("id" in created)

    const client = createMockClient()
    client.session.status = async () => ({ data: {} })

    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))

    const processed = await processor.processNext()
    assert.equal(processed, true)

    const item = queueManager.listItems()[0]
    assert.equal(item.status, "review_pending")
    assert.match(item.result, /Task finished successfully/)
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("processor does not complete early on a missing status before assistant output", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const { QueueManager, QueueProcessor, IdleDetector } = OpencodeQueuePlugin.__internals

    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Run the queued task")
    assert.ok("id" in created)

    let messageReads = 0
    const client = createMockClient()
    client.session.status = async () => ({ data: {} })
    client.session.messages = async () => {
      messageReads += 1
      if (messageReads === 1) {
        return {
          data: [
            {
              info: { role: "user" },
              parts: [{ type: "text", text: "Run the queued task" }],
            },
          ],
        }
      }
      return {
        data: [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "Run the queued task" }],
          },
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "Task finished successfully" }],
          },
        ],
      }
    }

    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))

    const processed = await processor.processNext()
    assert.equal(processed, true)

    const item = queueManager.listItems()[0]
    assert.equal(item.status, "review_pending")
    assert.ok(messageReads >= 2)
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("permission events move running items into blocked state", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const { QueueManager, BlockWatcher } = OpencodeQueuePlugin.__internals
    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Needs permission")
    assert.ok("id" in created)
    const itemId = created.id

    await queueManager.updateItem(itemId, {
      status: "running",
      sessionId: "s1",
    })

    const watcher = new BlockWatcher(queueManager, createMockClient())
    await watcher.handleEvent({
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "s1",
        permission: "edit files",
        patterns: ["src/**"],
      },
    })

    const item = queueManager.getItem(itemId)
    assert.equal(item?.status, "blocked")
    assert.equal(item?.blockedReason?.type, "permission")
    assert.equal(item?.blockedReason?.permissionId, "perm-1")
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("idle detector uses updated config from queue.json without plugin reload", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const { QueueManager, IdleDetector } = OpencodeQueuePlugin.__internals

    const queueManager = new QueueManager()
    let idleCalls = 0
    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {
      idleCalls += 1
    })

    idleDetector.writeActivity()
    await sleep(5)
    await queueManager.updateConfig({ idleTimeoutSeconds: 0 })
    await idleDetector.checkIdle()

    assert.equal(idleCalls, 1)
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("dependent items wait until the parent reaches review_pending by default", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const { QueueManager } = OpencodeQueuePlugin.__internals

    const queueManager = new QueueManager()
    const parent = await queueManager.addItem(workspace, "Parent task")
    assert.ok("id" in parent)
    const child = await queueManager.addItem(workspace, "Child task", { parentItemId: parent.id })
    assert.ok("id" in child)

    const first = await queueManager.getNextPending()
    assert.equal(first?.id, parent.id)

    await queueManager.updateItem(parent.id, { status: "review_pending", result: "Parent output" })
    const second = await queueManager.getNextPending()
    assert.equal(second?.id, child.id)

    const updatedChild = queueManager.getItem(child.id)
    assert.equal(updatedChild?.dependencySourceStatus, "review_pending")
    assert.equal(typeof updatedChild?.dependencySatisfiedAt, "string")
    assert.equal(updatedChild?.dependencyBlockedReason, null)
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("completed dependency mode waits for explicit completion", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const { QueueManager } = OpencodeQueuePlugin.__internals

    const queueManager = new QueueManager()
    const parent = await queueManager.addItem(workspace, "Parent task")
    assert.ok("id" in parent)
    const child = await queueManager.addItem(workspace, "Strict child", {
      parentItemId: parent.id,
      dependencyMode: "completed",
    })
    assert.ok("id" in child)

    await queueManager.updateItem(parent.id, { status: "review_pending", result: "Parent output" })
    const nextBeforeComplete = await queueManager.getNextPending()
    assert.equal(nextBeforeComplete, undefined)

    await queueManager.updateItem(parent.id, { status: "completed", completedAt: new Date().toISOString() })
    const nextAfterComplete = await queueManager.getNextPending()
    assert.equal(nextAfterComplete?.id, child.id)
    assert.equal(queueManager.getItem(child.id)?.dependencySourceStatus, "completed")
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("queue-confirm marks a review item completed", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const hooks = await OpencodeQueuePlugin({
      client: createMockClient(),
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    })

    const { QueueManager } = OpencodeQueuePlugin.__internals
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
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("queue-followup continues a review item and returns it to review", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const prompts = []
    const client = createMockClient()
    client.session.prompt = async (payload) => {
      prompts.push(payload)
      return { data: { id: "m1" } }
    }

    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const hooks = await OpencodeQueuePlugin({
      client,
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    })

    const { QueueManager } = OpencodeQueuePlugin.__internals
    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Needs changes")
    assert.ok("id" in created)
    await queueManager.updateItem(created.id, {
      status: "review_pending",
      result: "Initial result",
      sessionId: "s1",
    })

    const followupResult = await hooks.tool["queue-followup"].execute({
      itemId: created.id,
      message: "Please tighten the final output.",
    })
    assert.equal(followupResult, `Follow-up sent for ${created.id}.`)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].body.parts[0].text, "Please tighten the final output.")

    const item = queueManager.getItem(created.id)
    assert.equal(item?.status, "review_pending")
    assert.match(item?.result || "", /Task finished successfully/)
    assert.equal(item?.completedAt, null)
    assert.equal(item?.reviewedAt, null)
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("queue-followup marks descendants stale when reopening a parent", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const client = createMockClient()
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const hooks = await OpencodeQueuePlugin({
      client,
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    })

    const { QueueManager } = OpencodeQueuePlugin.__internals
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

    const updatedChild = queueManager.getItem(child.id)
    assert.equal(updatedChild?.staleDependency, true)
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("queue-remove refuses to delete a parent with dependents", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const hooks = await OpencodeQueuePlugin({
      client: createMockClient(),
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    })

    const { QueueManager } = OpencodeQueuePlugin.__internals
    const queueManager = new QueueManager()
    const parent = await queueManager.addItem(workspace, "Parent task")
    assert.ok("id" in parent)
    const child = await queueManager.addItem(workspace, "Child task", { parentItemId: parent.id })
    assert.ok("id" in child)

    const result = await hooks.tool["queue-remove"].execute({ itemId: parent.id })
    assert.equal(result, `Error: Item ${parent.id} has dependent tasks and cannot be removed.`)
    assert.equal(queueManager.getItem(parent.id)?.id, parent.id)
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("repeated plugin loads share a single coordinator timer and event hook", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  let timerStarts = 0
  globalThis.setInterval = () => {
    timerStarts += 1
    return 1
  }
  globalThis.clearInterval = () => {}

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const context = {
      client: createMockClient(),
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    }

    const firstHooks = await OpencodeQueuePlugin(context)
    const secondHooks = await OpencodeQueuePlugin(context)

    assert.equal(timerStarts, 1)
    assert.equal(typeof firstHooks.event, "function")
    assert.equal(secondHooks.event, undefined)
    assert.equal(typeof firstHooks["tool.execute.before"], "function")
    assert.equal(typeof secondHooks["tool.execute.before"], "function")
    assert.equal(typeof firstHooks["chat.message"], "function")
    assert.equal(typeof secondHooks["chat.message"], "function")
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("non-coordinator activity hooks still refresh shared idle activity", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const context = {
      client: createMockClient(),
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    }

    await OpencodeQueuePlugin(context)
    const secondHooks = await OpencodeQueuePlugin(context)
    const activityPath = join(configHome, "opencode", "queue.last-activity")
    const before = readFileSync(activityPath, "utf8")
    await sleep(5)
    await secondHooks["chat.message"](
      {
        sessionID: "s1",
        model: { providerID: "test", modelID: "test" },
      },
      {
        message: { id: "m1" },
        parts: [],
      },
    )
    const after = readFileSync(activityPath, "utf8")
    assert.notEqual(after, before)
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("processor uses serverUrl when storing session links", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const { QueueManager, QueueProcessor, IdleDetector } = OpencodeQueuePlugin.__internals

    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Store session URL")
    assert.ok("id" in created)

    const client = createMockClient()
    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector, new URL("http://0.0.0.0:4096/base/"))

    const processed = await processor.processNext()
    assert.equal(processed, true)

    const item = queueManager.listItems()[0]
    assert.equal(item.sessionUrl, "http://0.0.0.0:4096/session/s1")
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("resetSharedState releases the processing lock for takeover", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const context = {
      client: createMockClient(),
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    }

    await OpencodeQueuePlugin(context)
    const lockPath = join(configHome, "opencode", "queue.lock")
    writeFileSync(lockPath, "123\n0", "utf8")
    assert.equal(existsSync(lockPath), true)
    resetPluginState(pluginModule)
    assert.equal(existsSync(lockPath), false)
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("stale processing lock can be taken over by a new processor", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const { QueueManager, QueueProcessor, IdleDetector } = OpencodeQueuePlugin.__internals

    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Take over stale lock")
    assert.ok("id" in created)
    const lockPath = join(configHome, "opencode", "queue.lock")
    writeFileSync(lockPath, "999\n0", "utf8")
    const stale = new Date(Date.now() - 5 * 60 * 1000)
    utimesSync(lockPath, stale, stale)

    const client = createMockClient()
    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))

    await processor.processQueue()

    const item = queueManager.listItems()[0]
    assert.equal(item.status, "review_pending")
    assert.equal(existsSync(lockPath), false)
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("permission.replied auto-unblocks a blocked permission item", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const hooks = await OpencodeQueuePlugin({
      client: createMockClient(),
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    })

    const { QueueManager } = OpencodeQueuePlugin.__internals
    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Needs permission")
    assert.ok("id" in created)
    await queueManager.updateItem(created.id, {
      status: "running",
      sessionId: "s1",
    })
    const watcher = new (OpencodeQueuePlugin.__internals.BlockWatcher)(queueManager, createMockClient())
    await watcher.handleEvent({
      type: "permission.asked",
      properties: { id: "perm-1", sessionID: "s1", permission: "edit files", patterns: ["src/**"] },
    })

    let item = queueManager.getItem(created.id)
    assert.equal(item?.status, "blocked")
    assert.equal(item?.blockedReason?.type, "permission")

    await hooks.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "s1", permissionID: "perm-1", response: "yes" },
      },
    })

    await sleep(10)

    item = queueManager.getItem(created.id)
    assert.equal(item?.status, "review_pending")
    assert.equal(item?.blockedReason?.userResponse, "yes")
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("user message auto-unblocks a blocked question item", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const hooks = await OpencodeQueuePlugin({
      client: createMockClient(),
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    })

    const { QueueManager } = OpencodeQueuePlugin.__internals
    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Needs answer")
    assert.ok("id" in created)
    await queueManager.updateItem(created.id, {
      status: "blocked",
      sessionId: "s1",
      blockedReason: {
        type: "question",
        permissionId: null,
        requestId: null,
        details: "What framework?",
        options: null,
        userResponse: null,
      },
    })

    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: { sessionID: "s1", role: "user", id: "m1" } },
      },
    })

    await sleep(10)

    const item = queueManager.getItem(created.id)
    assert.equal(item?.status, "review_pending")
    assert.equal(item?.blockedReason?.userResponse, "answered via session")
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("events on non-queue sessions are ignored", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const hooks = await OpencodeQueuePlugin({
      client: createMockClient(),
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    })

    await hooks.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "unknown-session", permissionID: "p1", response: "yes" },
      },
    })

    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: { sessionID: "unknown-session", role: "user", id: "m1" } },
      },
    })

    const { QueueManager } = OpencodeQueuePlugin.__internals
    const queueManager = new QueueManager()
    assert.equal(queueManager.listItems().length, 0)
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("events on already-running items are ignored", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const hooks = await OpencodeQueuePlugin({
      client: createMockClient(),
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    })

    const { QueueManager } = OpencodeQueuePlugin.__internals
    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Running task")
    assert.ok("id" in created)
    await queueManager.updateItem(created.id, {
      status: "running",
      sessionId: "s1",
    })

    await hooks.event({
      event: {
        type: "message.updated",
        properties: { info: { sessionID: "s1", role: "user", id: "m1" } },
      },
    })

    const item = queueManager.getItem(created.id)
    assert.equal(item?.status, "running")
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("permission.replied on review_pending item is ignored", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { default: OpencodeQueuePlugin } = pluginModule
    const hooks = await OpencodeQueuePlugin({
      client: createMockClient(),
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    })

    const { QueueManager } = OpencodeQueuePlugin.__internals
    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Review task")
    assert.ok("id" in created)
    await queueManager.updateItem(created.id, {
      status: "review_pending",
      sessionId: "s1",
      result: "Done",
    })

    await hooks.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "s1", permissionID: "perm-1", response: "yes" },
      },
    })

    const item = queueManager.getItem(created.id)
    assert.equal(item?.status, "review_pending")
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})
