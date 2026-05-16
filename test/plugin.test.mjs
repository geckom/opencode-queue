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

test("schedule CRUD — add, list, remove via QueueManager", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "Scheduled task",
      scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
      cronExpression: null,
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    assert.ok(task.id)
    assert.equal(task.goal, "Scheduled task")
    assert.equal(task.enabled, true)
    assert.equal(task.occurrenceCount, 0)

    const listed = queueManager.listSchedules()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, task.id)

    const removed = await scheduleManager.removeAndStop(task.id)
    assert.equal(removed, true)
    assert.equal(queueManager.listSchedules().length, 0)

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("one-off schedule fires and creates a pending queue item at front", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    // Add a manual item first
    await queueManager.addItem(workspace, "Manual task")

    // Create a one-off schedule in the past so it fires immediately on start
    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "One-off past task",
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
      cronExpression: null,
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    // The schedule should have triggered on start (past date)
    // Need to give the cron job a moment to fire
    await sleep(50)

    const items = queueManager.listItems()
    assert.equal(items.length, 2)

    // The scheduled item should be at the front (index 0)
    assert.equal(items[0].goal, "One-off past task")
    assert.equal(items[0].sourceScheduleId, task.id)
    assert.equal(items[1].goal, "Manual task")
    assert.equal(items[1].sourceScheduleId, null)

    // The schedule should now be disabled
    const updatedSchedule = queueManager.getSchedule(task.id)
    assert.equal(updatedSchedule.enabled, false)
    assert.equal(updatedSchedule.occurrenceCount, 1)

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("recurring schedule generates queue items on each trigger", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    // Create a recurring schedule that fires every second
    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "Every second task",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    assert.ok(task.cronExpression)
    assert.ok(task.nextTriggerAt)

    // Wait for at least one trigger
    await sleep(1500)

    const items = queueManager.listItems()
    assert.ok(items.length >= 1, "Expected at least one item from recurring schedule")
    assert.equal(items[0].sourceScheduleId, task.id)
    assert.equal(items[0].goal, "Every second task")

    const updatedSchedule = queueManager.getSchedule(task.id)
    assert.ok(updatedSchedule.occurrenceCount >= 1)

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("maxOccurrences auto-disables a recurring schedule", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    // Create a recurring schedule that fires every second with max 2 occurrences
    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "Limited task",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: 2,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    // Wait for enough triggers to hit max
    await sleep(3500)

    const updatedSchedule = queueManager.getSchedule(task.id)
    assert.equal(updatedSchedule.enabled, false)
    assert.equal(updatedSchedule.occurrenceCount, 2)

    const items = queueManager.listItems().filter((i) => i.sourceScheduleId === task.id)
    assert.equal(items.length, 2)

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("pause and resume stop and restart schedule firing", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "Pausable task",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    // Wait for one trigger
    await sleep(1500)
    const countBefore = queueManager.listItems().filter((i) => i.sourceScheduleId === task.id).length
    assert.ok(countBefore >= 1, "Should have fired at least once")

    // Pause
    await scheduleManager.pause(task.id)
    const paused = queueManager.getSchedule(task.id)
    assert.equal(paused.enabled, false)

    // Wait and check no new items
    await sleep(1500)
    const countAfterPause = queueManager.listItems().filter((i) => i.sourceScheduleId === task.id).length
    assert.equal(countAfterPause, countBefore, "No new items while paused")

    // Resume
    await scheduleManager.resume(task.id)
    const resumed = queueManager.getSchedule(task.id)
    assert.equal(resumed.enabled, true)

    // Wait for another trigger
    await sleep(1500)
    const countAfterResume = queueManager.listItems().filter((i) => i.sourceScheduleId === task.id).length
    assert.ok(countAfterResume > countAfterPause, "New items after resume")

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("startup recovery restores enabled schedules", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    // First: create a schedule
    const queueManager1 = new QueueManager()
    const scheduleManager1 = new ScheduleManager(queueManager1)
    const task = await scheduleManager1.addAndStart({
      workspace,
      goal: "Survives restart",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })
    scheduleManager1.stop()

    // Second: simulate restart by creating a new ScheduleManager
    const queueManager2 = new QueueManager()
    const scheduleManager2 = new ScheduleManager(queueManager2)
    scheduleManager2.start()

    // Wait for the restored schedule to fire
    await sleep(1500)

    const items = queueManager2.listItems().filter((i) => i.sourceScheduleId === task.id)
    assert.ok(items.length >= 1, "Restored schedule should fire")

    scheduleManager2.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("queue-schedule-add and queue-schedule-list tools work end-to-end", async () => {
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

    // Add a one-off schedule in the future
    const futureDate = new Date(Date.now() + 3600_000).toISOString()
    const addResult = await hooks.tool["queue-schedule-add"].execute({
      workspace,
      goal: "Future one-off task",
      scheduledFor: futureDate,
    })
    assert.match(addResult, /one-off/)
    assert.match(addResult, /ENABLED/)
    assert.match(addResult, /Future one-off task/)

    // List schedules
    const listResult = await hooks.tool["queue-schedule-list"].execute({ action: "list" })
    assert.match(listResult, /Future one-off task/)

    // Extract the schedule ID from the queue file
    const queuePath = join(configHome, "opencode", "queue.json")
    const store = JSON.parse(readFileSync(queuePath, "utf8"))
    const scheduleId = store.schedules[0].id

    // Pause
    const pauseResult = await hooks.tool["queue-schedule-list"].execute({
      action: "pause",
      scheduleId,
    })
    assert.match(pauseResult, /Paused/)

    // Verify it's disabled
    const listAfterPause = await hooks.tool["queue-schedule-list"].execute({ action: "list" })
    assert.match(listAfterPause, /DISABLED/)

    // Resume
    const resumeResult = await hooks.tool["queue-schedule-list"].execute({
      action: "resume",
      scheduleId,
    })
    assert.match(resumeResult, /Resumed/)

    // Remove
    const removeResult = await hooks.tool["queue-schedule-list"].execute({
      action: "remove",
      scheduleId,
    })
    assert.match(removeResult, /Removed schedule/)

    // Verify empty
    const emptyList = await hooks.tool["queue-schedule-list"].execute({ action: "list" })
    assert.equal(emptyList, "No scheduled tasks.")
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

test("queue-schedule-add validates inputs", async () => {
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

    // Neither scheduledFor nor cronExpression
    const neither = await hooks.tool["queue-schedule-add"].execute({
      workspace,
      goal: "No schedule info",
    })
    assert.match(neither, /Error/)

    // Both scheduledFor and cronExpression
    const both = await hooks.tool["queue-schedule-add"].execute({
      workspace,
      goal: "Both fields",
      scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
      cronExpression: "* * * * *",
    })
    assert.match(both, /Error/)

    // scheduledFor in the past
    const past = await hooks.tool["queue-schedule-add"].execute({
      workspace,
      goal: "Past task",
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
    })
    assert.match(past, /Error.*future/)

    // Invalid cron expression
    const invalidCron = await hooks.tool["queue-schedule-add"].execute({
      workspace,
      goal: "Bad cron",
      cronExpression: "not a cron",
    })
    assert.match(invalidCron, /Error.*cron/i)

    // Non-existent workspace
    const badWorkspace = await hooks.tool["queue-schedule-add"].execute({
      workspace: "/nonexistent/path",
      goal: "Bad workspace",
      cronExpression: "* * * * *",
    })
    assert.match(badWorkspace, /Error/)
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

// ── Multi-session mock client ────────────────────────────────────────────────
// Returns unique session IDs for each session.create() call. Required for tests
// that process multiple items sequentially via processNext / processQueue.

function createMultiSessionMockClient() {
  const sessions = []
  return {
    tui: {
      async showToast() {
        return { data: true }
      },
    },
    session: {
      async create() {
        const id = `s${sessions.length + 1}`
        sessions.push(id)
        return { data: { id } }
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
        const map = {}
        for (const sid of sessions) {
          map[sid] = { type: "idle" }
        }
        return { data: map }
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

// ── A. Queue Processing With Schedules ───────────────────────────────────────

test("A1: scheduled item is picked up by processNext after one-off trigger", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager, QueueProcessor, IdleDetector } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    await queueManager.addItem(workspace, "Manual task")

    await scheduleManager.addAndStart({
      workspace,
      goal: "Scheduled task",
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
      cronExpression: null,
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await sleep(100)

    const items = queueManager.listItems()
    assert.equal(items.length, 2)
    assert.ok(items[0].sourceScheduleId, "index 0 should be scheduled")
    assert.equal(items[1].sourceScheduleId, null, "index 1 should be manual")

    const client = createMultiSessionMockClient()
    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))

    const first = await processor.processNext()
    assert.equal(first, true)
    assert.equal(queueManager.listItems().find((i) => i.sourceScheduleId).status, "review_pending")

    const second = await processor.processNext()
    assert.equal(second, true)
    assert.equal(queueManager.listItems().find((i) => !i.sourceScheduleId).status, "review_pending")

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("A2: idle timeout processes scheduled items", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager, QueueProcessor, IdleDetector } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const client = createMockClient()
    let processCalls = 0
    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {
      processCalls += 1
      const processor = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))
      await processor.processNext()
    })
    const scheduleManager = new ScheduleManager(queueManager)

    await scheduleManager.addAndStart({
      workspace,
      goal: "Idle scheduled task",
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
      cronExpression: null,
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await sleep(100)

    idleDetector.writeActivity()
    await queueManager.updateConfig({ idleTimeoutSeconds: 0 })
    await idleDetector.checkIdle()

    assert.equal(processCalls, 1)
    assert.equal(queueManager.listItems().find((i) => i.sourceScheduleId).status, "review_pending")

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("A3: processQueue processes scheduled items before manual items", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager, QueueProcessor, IdleDetector } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    await queueManager.addItem(workspace, "Manual 1")
    await queueManager.addItem(workspace, "Manual 2")

    await scheduleManager.addAndStart({
      workspace,
      goal: "Scheduled task",
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
      cronExpression: null,
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await sleep(100)
    await queueManager.updateConfig({ idleTimeoutSeconds: 0 })

    const client = createMultiSessionMockClient()
    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))

    await processor.processQueue()

    const items = queueManager.listItems()
    assert.equal(items.length, 3)
    for (const item of items) {
      assert.equal(item.status, "review_pending")
    }
    assert.ok(items.find((i) => i.sourceScheduleId), "scheduled item should exist")

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("A4: queue processing does not interfere with active cron jobs", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager, QueueProcessor, IdleDetector } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "Recurring task",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await sleep(1500)
    const firstItems = queueManager.listItems().filter((i) => i.sourceScheduleId === task.id)
    assert.ok(firstItems.length >= 1, "at least one item from first trigger")

    const client = createMockClient()
    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))
    await processor.processNext()

    assert.equal(queueManager.listItems().find((i) => i.sourceScheduleId === task.id).status, "review_pending")

    await sleep(1500)
    const secondItems = queueManager.listItems().filter((i) => i.sourceScheduleId === task.id)
    assert.ok(secondItems.length >= 2, "at least two items after second trigger")

    assert.equal(queueManager.getSchedule(task.id).enabled, true)

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

// ── B. One-Off Schedule Pipeline ─────────────────────────────────────────────

test("B1: one-off schedule fires at approximately the right time", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    await scheduleManager.addAndStart({
      workspace,
      goal: "Timed task",
      scheduledFor: new Date(Date.now() + 2000).toISOString(),
      cronExpression: null,
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    assert.equal(queueManager.listItems().length, 0)

    await sleep(3000)
    assert.equal(queueManager.listItems().length, 1)
    assert.equal(queueManager.listItems()[0].goal, "Timed task")

    await sleep(1500)
    assert.equal(queueManager.listItems().length, 1, "no double-fire")

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("B2: disabled one-off schedule does not fire", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    await scheduleManager.addAndStart({
      workspace,
      goal: "Disabled task",
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
      cronExpression: null,
      timezone: "UTC",
      enabled: false,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    scheduleManager.start()
    await sleep(1500)

    assert.equal(queueManager.listItems().length, 0)

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("B3: removing a schedule preserves items already created", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager, QueueProcessor, IdleDetector } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "Preserved task",
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
      cronExpression: null,
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await sleep(100)

    const itemId = queueManager.listItems()[0].id

    await scheduleManager.removeAndStop(task.id)

    const item = queueManager.getItem(itemId)
    assert.ok(item, "item should survive schedule removal")
    assert.equal(item.sourceScheduleId, task.id)
    assert.equal(item.status, "pending")

    const client = createMockClient()
    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))
    const processed = await processor.processNext()
    assert.equal(processed, true)
    assert.equal(queueManager.getItem(itemId).status, "review_pending")
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

// ── C. Recurring Cron Sequential Firing ──────────────────────────────────────

test("C1: recurring schedule fires 5 sequential times with correct occurrenceCount", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "Five times",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await sleep(6500)

    const items = queueManager.listItems().filter((i) => i.sourceScheduleId === task.id)
    assert.ok(items.length >= 5, `expected >= 5 items, got ${items.length}`)

    const schedule = queueManager.getSchedule(task.id)
    assert.ok(schedule.occurrenceCount >= 5, `expected occurrenceCount >= 5, got ${schedule.occurrenceCount}`)
    assert.equal(schedule.enabled, true)

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("C2: each recurring firing prepends to front — items in reverse chronological order", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    await scheduleManager.addAndStart({
      workspace,
      goal: "Chronological",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await sleep(3500)

    const items = queueManager.listItems().filter((i) => i.sourceScheduleId)
    assert.ok(items.length >= 2, "need >= 2 items to check ordering")

    const t0 = new Date(items[0].createdAt).getTime()
    const t1 = new Date(items[1].createdAt).getTime()
    assert.ok(t0 >= t1, `first item (${t0}) should be >= second (${t1})`)

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("C3: occurrenceCount is exact with maxOccurrences", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "Limited",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: 4,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await sleep(5500)

    const schedule = queueManager.getSchedule(task.id)
    assert.equal(schedule.occurrenceCount, 4)
    assert.equal(schedule.enabled, false)

    const items = queueManager.listItems().filter((i) => i.sourceScheduleId === task.id)
    assert.equal(items.length, 4)

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("C4: nextTriggerAt updates to future time after each firing", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "Next trigger",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await sleep(2500)

    const s1 = queueManager.getSchedule(task.id)
    assert.ok(s1.nextTriggerAt, "nextTriggerAt should be set after firing")
    const next1 = new Date(s1.nextTriggerAt).getTime()

    await sleep(1500)

    const s2 = queueManager.getSchedule(task.id)
    const next2 = new Date(s2.nextTriggerAt).getTime()
    assert.notEqual(next2, next1, "nextTriggerAt should change after next firing")

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("C5: all items from sequential firings are processable", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager, QueueProcessor, IdleDetector } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "Processable",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: 3,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await sleep(4500)

    const items = queueManager.listItems().filter((i) => i.sourceScheduleId === task.id)
    assert.equal(items.length, 3)

    const client = createMultiSessionMockClient()
    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))

    for (let i = 0; i < 3; i++) {
      const processed = await processor.processNext()
      assert.equal(processed, true, `iteration ${i + 1} should succeed`)
    }

    for (const item of queueManager.listItems().filter((i) => i.sourceScheduleId === task.id)) {
      assert.equal(item.status, "review_pending")
    }

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

// ── D. Priority and Ordering ─────────────────────────────────────────────────

test("D1: multiple one-off schedules firing simultaneously all go to front", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    await queueManager.addItem(workspace, "Manual 1")
    await queueManager.addItem(workspace, "Manual 2")

    await scheduleManager.addAndStart({
      workspace,
      goal: "Scheduled 1",
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
      cronExpression: null,
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })
    await scheduleManager.addAndStart({
      workspace,
      goal: "Scheduled 2",
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
      cronExpression: null,
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await sleep(100)

    const items = queueManager.listItems()
    assert.equal(items.length, 4)
    assert.ok(items[0].sourceScheduleId, "item 0 from schedule")
    assert.ok(items[1].sourceScheduleId, "item 1 from schedule")
    assert.equal(items[2].sourceScheduleId, null, "item 2 is manual")
    assert.equal(items[3].sourceScheduleId, null, "item 3 is manual")

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("D2: getNextPending returns scheduled items before manual pending items", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    await queueManager.addItem(workspace, "Manual 1")
    await queueManager.addItem(workspace, "Manual 2")
    await queueManager.addItem(workspace, "Manual 3")

    await scheduleManager.addAndStart({
      workspace,
      goal: "Priority task",
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
      cronExpression: null,
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await sleep(100)

    const next = await queueManager.getNextPending()
    assert.ok(next, "should return a pending item")
    assert.ok(next.sourceScheduleId, "should be the scheduled item")
    assert.equal(next.goal, "Priority task")

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("D3: schedule fires while existing items are in various states", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    const pending = await queueManager.addItem(workspace, "Pending task")
    const running = await queueManager.addItem(workspace, "Running task")
    const blocked = await queueManager.addItem(workspace, "Blocked task")
    const review = await queueManager.addItem(workspace, "Review task")

    await queueManager.updateItem(running.id, { status: "running", sessionId: "s-existing" })
    await queueManager.updateItem(blocked.id, {
      status: "blocked",
      blockedReason: { type: "permission", permissionId: "p1", requestId: null, details: "test", options: null, userResponse: null },
    })
    await queueManager.updateItem(review.id, { status: "review_pending", result: "Done" })

    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "New scheduled task",
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
      cronExpression: null,
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await sleep(100)

    const items = queueManager.listItems()
    assert.equal(items[0].goal, "New scheduled task")
    assert.equal(items[0].sourceScheduleId, task.id)

    assert.equal(queueManager.getItem(pending.id).status, "pending")
    assert.equal(queueManager.getItem(running.id).status, "running")
    assert.equal(queueManager.getItem(blocked.id).status, "blocked")
    assert.equal(queueManager.getItem(review.id).status, "review_pending")

    const next = await queueManager.getNextPending()
    assert.equal(next.goal, "New scheduled task")

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

// ── E. Dependencies and Edge Cases ───────────────────────────────────────────

test("E1: scheduled item with parentItemId waits for parent (review_pending mode)", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    const parent = await queueManager.addItem(workspace, "Parent task")
    assert.ok("id" in parent)

    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "Dependent scheduled",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: parent.id,
      dependencyMode: "review_pending",
    })

    await sleep(1500)

    const children = queueManager.listItems().filter((i) => i.sourceScheduleId === task.id)
    assert.ok(children.length >= 1, "at least one child from schedule")
    const child = children[0]
    assert.equal(child.parentItemId, parent.id)
    assert.equal(child.dependencyMode, "review_pending")

    const next = await queueManager.getNextPending()
    assert.equal(next.id, parent.id, "parent should be next")

    await queueManager.updateItem(parent.id, { status: "review_pending", result: "Parent done" })
    const childNext = await queueManager.getNextPending()
    assert.equal(childNext.id, child.id, "child eligible after parent review_pending")

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("E2: scheduled item with dependencyMode completed waits for completion", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    const parent = await queueManager.addItem(workspace, "Parent task")
    assert.ok("id" in parent)

    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "Strict dependent",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: parent.id,
      dependencyMode: "completed",
    })

    await sleep(1500)

    const children = queueManager.listItems().filter((i) => i.sourceScheduleId === task.id)
    assert.ok(children.length >= 1)
    const child = children[0]
    assert.equal(child.dependencyMode, "completed")

    await queueManager.updateItem(parent.id, { status: "review_pending", result: "Review" })
    const before = await queueManager.getNextPending()
    if (before) {
      assert.notEqual(before.id, child.id, "child blocked while parent is review_pending")
    }

    await queueManager.updateItem(parent.id, { status: "completed", completedAt: new Date().toISOString() })
    const after = await queueManager.getNextPending()
    assert.equal(after.id, child.id, "child eligible after parent completed")

    scheduleManager.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("E3: disabled recurring schedule does not fire after restart", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager1 = new QueueManager()
    const scheduleManager1 = new ScheduleManager(queueManager1)

    const task = await scheduleManager1.addAndStart({
      workspace,
      goal: "Disabled recurring",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await scheduleManager1.pause(task.id)
    scheduleManager1.stop()

    assert.equal(queueManager1.getSchedule(task.id).enabled, false)

    const queueManager2 = new QueueManager()
    const scheduleManager2 = new ScheduleManager(queueManager2)
    scheduleManager2.start()

    await sleep(2000)
    assert.equal(queueManager2.listItems().length, 0, "disabled schedule should not fire after restart")

    scheduleManager2.stop()
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("E4: store persistence — schedules survive across QueueManager instances", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager } = pluginModule.default.__internals

    const qm1 = new QueueManager()
    const schedule = await qm1.addSchedule({
      workspace,
      goal: "Persistent task",
      scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
      cronExpression: null,
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    const qm2 = new QueueManager()
    const schedules = qm2.listSchedules()
    assert.equal(schedules.length, 1)
    assert.equal(schedules[0].id, schedule.id)
    assert.equal(schedules[0].goal, "Persistent task")
    assert.equal(schedules[0].enabled, true)
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("E5: cron job stops completely when schedule is removed", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const pluginModule = await loadPluginModule(configHome)
    const { QueueManager, ScheduleManager } = pluginModule.default.__internals

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "Removable task",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await sleep(1500)
    const countBefore = queueManager.listItems().filter((i) => i.sourceScheduleId === task.id).length
    assert.ok(countBefore >= 1, "should have fired at least once")

    await scheduleManager.removeAndStop(task.id)

    await sleep(2000)
    const countAfter = queueManager.listItems().filter((i) => i.sourceScheduleId === task.id).length
    assert.equal(countAfter, countBefore, "no additional items after removal")
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})
