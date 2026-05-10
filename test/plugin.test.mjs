import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs"
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

    const addResult = await hooks.tool["queue-add"].execute({
      workspace,
      goal: "Fix the plugin",
    })
    assert.match(addResult, /Added item/)

    const listResult = await hooks.tool["queue-list"].execute({})
    assert.match(listResult, /Fix the plugin/)

    const queuePath = join(configHome, "opencode", "queue.json")
    const store = JSON.parse(readFileSync(queuePath, "utf8"))
    const itemId = store.items[0].id

    const statusResult = await hooks.tool["queue-status"].execute({ itemId })
    assert.match(statusResult, new RegExp(itemId))

    const removeResult = await hooks.tool["queue-remove"].execute({ itemId })
    assert.equal(removeResult, `Removed item ${itemId}.`)
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("processor completes a pending item and stores the result", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const { internals } = await loadPluginModule(configHome)
    const { QueueManager, QueueProcessor, IdleDetector } = internals

    const queueManager = new QueueManager()
    const created = queueManager.addItem(workspace, "Run the queued task")
    assert.ok("id" in created)

    const client = createMockClient()
    const idleDetector = new IdleDetector(queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector)

    const processed = await processor.processNext()
    assert.equal(processed, true)

    const item = queueManager.listItems()[0]
    assert.equal(item.status, "completed")
    assert.match(item.result, /Task finished successfully/)
    assert.equal(item.sessionId, "s1")
  } finally {
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("processor treats a missing session.status entry as completed", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const { internals } = await loadPluginModule(configHome)
    const { QueueManager, QueueProcessor, IdleDetector } = internals

    const queueManager = new QueueManager()
    const created = queueManager.addItem(workspace, "Run the queued task")
    assert.ok("id" in created)

    const client = createMockClient()
    client.session.status = async () => ({ data: {} })

    const idleDetector = new IdleDetector(queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector)

    const processed = await processor.processNext()
    assert.equal(processed, true)

    const item = queueManager.listItems()[0]
    assert.equal(item.status, "completed")
    assert.match(item.result, /Task finished successfully/)
  } finally {
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("processor does not complete early on a missing status before assistant output", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const { internals } = await loadPluginModule(configHome)
    const { QueueManager, QueueProcessor, IdleDetector } = internals

    const queueManager = new QueueManager()
    const created = queueManager.addItem(workspace, "Run the queued task")
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

    const idleDetector = new IdleDetector(queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector)

    const processed = await processor.processNext()
    assert.equal(processed, true)

    const item = queueManager.listItems()[0]
    assert.equal(item.status, "completed")
    assert.ok(messageReads >= 2)
  } finally {
    rmSync(configHome, { recursive: true, force: true })
  }
})

test("permission events move running items into blocked state", async () => {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })

  try {
    const { internals } = await loadPluginModule(configHome)
    const { QueueManager, BlockWatcher } = internals
    const queueManager = new QueueManager()
    const created = queueManager.addItem(workspace, "Needs permission")
    assert.ok("id" in created)
    const itemId = created.id

    queueManager.updateItem(itemId, {
      status: "running",
      sessionId: "s1",
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

    const item = queueManager.getItem(itemId)
    assert.equal(item?.status, "blocked")
    assert.equal(item?.blockedReason?.type, "permission")
    assert.equal(item?.blockedReason?.permissionId, "perm-1")
  } finally {
    rmSync(configHome, { recursive: true, force: true })
  }
})
