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

test("processor completes a pending item and stores the result", async () => {
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
    assert.equal(item.status, "completed")
    assert.match(item.result, /Task finished successfully/)
    assert.equal(item.sessionId, "s1")
  } finally {
    try {
      const pluginModule = await loadPluginModule(configHome)
      resetPluginState(pluginModule)
    } catch {}
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("processor treats a missing session.status entry as completed", async () => {
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
    assert.equal(item.status, "completed")
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
    assert.equal(item.status, "completed")
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
    assert.equal(item.status, "completed")
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
