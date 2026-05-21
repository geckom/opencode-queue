import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  createMockClient,
  loadBuiltModules,
  withTempRepo,
} from "./helpers.mjs"

test("processor moves a finished pending item into review and stores the result", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, QueueProcessor, IdleDetector, QUEUE_FILE } = testingModule
    try {
      unlinkSync(QUEUE_FILE)
    } catch {}

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
  })
})

test("processor treats a missing session.status entry as review-ready after assistant output", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, QueueProcessor, IdleDetector } = testingModule

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
          data: [{ info: { role: "user" }, parts: [{ type: "text", text: "Run the queued task" }] }],
        }
      }
      return {
        data: [
          { info: { role: "user" }, parts: [{ type: "text", text: "Run the queued task" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "Task finished successfully" }] },
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
  })
})

test("permission events move running items into blocked state", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, BlockWatcher } = testingModule

    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Needs permission")
    assert.ok("id" in created)
    await queueManager.updateItem(created.id, { status: "running", sessionId: "s1" })

    const watcher = new BlockWatcher(queueManager, createMockClient())
    await watcher.handleEvent({
      type: "permission.asked",
      properties: { id: "perm-1", sessionID: "s1", permission: "edit files", patterns: ["src/**"] },
    })

    let item = queueManager.getItem(created.id)
    assert.equal(item?.status, "blocked")
    assert.equal(item?.blockedReason?.type, "permission")
  })
})

test("question events move running items into blocked state", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, BlockWatcher } = testingModule

    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Needs answer")
    assert.ok("id" in created)
    await queueManager.updateItem(created.id, { status: "running", sessionId: "s1" })

    const watcher = new BlockWatcher(queueManager, createMockClient())
    await watcher.handleEvent({
      type: "question.asked",
      properties: {
        id: "q-1",
        sessionID: "s1",
        questions: [{ question: "What framework?", options: [{ label: "React" }, { label: "Vue" }] }],
      },
    })

    const item = queueManager.getItem(created.id)
    assert.equal(item?.status, "blocked")
    assert.equal(item?.blockedReason?.type, "question")
    assert.deepEqual(item?.blockedReason?.options, ["React", "Vue"])
  })
})

test("stale processing lock can be taken over by a new processor", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, QueueProcessor, IdleDetector, QUEUE_FILE } = testingModule

    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Take over stale lock")
    assert.ok("id" in created)
    const lockPath = join(dirname(QUEUE_FILE), "queue.lock")
    mkdirSync(dirname(QUEUE_FILE), { recursive: true })
    writeFileSync(lockPath, "999\n0", "utf8")
    const stale = new Date(Date.now() - 5 * 60 * 1000)
    utimesSync(lockPath, stale, stale)

    const client = createMockClient()
    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))

    await processor.processQueue()

    const item = queueManager.listItems()[0]
    assert.equal(item.status, "review_pending")
  })
})

test("fresh processing lock prevents startup from resetting running items", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, QUEUE_FILE } = testingModule

    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Already running")
    assert.ok("id" in created)
    await queueManager.updateItem(created.id, { status: "running", sessionId: "s1" })

    const lockPath = join(dirname(QUEUE_FILE), "queue.lock")
    mkdirSync(dirname(QUEUE_FILE), { recursive: true })
    writeFileSync(lockPath, "123:owner\n0", "utf8")

    try {
      await queueManager.resetRunningToPending()

      const item = queueManager.getItem(created.id)
      assert.equal(item.status, "running")
    } finally {
      try {
        unlinkSync(lockPath)
      } catch {}
    }
  })
})

test("processNext uses the processing lock across processor instances", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, QueueProcessor, IdleDetector } = testingModule

    const queueManager = new QueueManager()
    const firstItem = await queueManager.addItem(workspace, "First task")
    const secondItem = await queueManager.addItem(workspace, "Second task")
    assert.ok("id" in firstItem)
    assert.ok("id" in secondItem)

    let releaseMessages
    let messagesStarted
    const messagesStartedPromise = new Promise((resolve) => {
      messagesStarted = resolve
    })
    const releaseMessagesPromise = new Promise((resolve) => {
      releaseMessages = resolve
    })
    const client = createMockClient()
    client.session.messages = async () => {
      messagesStarted()
      await releaseMessagesPromise
      return {
        data: [
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "Task finished successfully" }],
          },
        ],
      }
    }
    client.session.status = async () => ({ data: { s1: { type: "idle" } } })

    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {})
    const processor1 = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))
    const processor2 = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))

    const first = processor1.processNext()
    await messagesStartedPromise
    const second = await processor2.processNext()
    releaseMessages()
    const firstResult = await first

    assert.equal(firstResult, true)
    assert.equal(second, false)
    assert.equal(queueManager.getItem(firstItem.id).status, "review_pending")
    assert.equal(queueManager.getItem(secondItem.id).status, "pending")
  })
})

test("processQueue stops after a task becomes blocked", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, QueueProcessor, IdleDetector, QUEUE_FILE } = testingModule
    try {
      unlinkSync(QUEUE_FILE)
    } catch {}

    const queueManager = new QueueManager()
    const firstItem = await queueManager.addItem(workspace, "Needs answer")
    const secondItem = await queueManager.addItem(workspace, "Must wait")
    assert.ok("id" in firstItem)
    assert.ok("id" in secondItem)

    const client = createMockClient()
    client.session.messages = async () => ({
      data: [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              tool: "question",
              state: { status: "pending", input: { question: "Pick one", options: ["A", "B"] } },
            },
          ],
        },
      ],
    })

    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))
    await processor.processQueue()

    assert.equal(queueManager.getItem(firstItem.id).status, "blocked")
    assert.equal(queueManager.getItem(secondItem.id).status, "pending")
  })
})

test("continueSession holds the processing lock while resumed session runs", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, QueueProcessor, IdleDetector, QUEUE_FILE } = testingModule
    try {
      unlinkSync(QUEUE_FILE)
    } catch {}

    const queueManager = new QueueManager()
    const blockedItem = await queueManager.addItem(workspace, "Resume me")
    const pendingItem = await queueManager.addItem(workspace, "Must still wait")
    assert.ok("id" in blockedItem)
    assert.ok("id" in pendingItem)
    await queueManager.updateItem(blockedItem.id, { status: "running", sessionId: "s1" })

    let releaseMessages
    let messagesStarted
    let messageReads = 0
    const messagesStartedPromise = new Promise((resolve) => {
      messagesStarted = resolve
    })
    const releaseMessagesPromise = new Promise((resolve) => {
      releaseMessages = resolve
    })
    const client = createMockClient()
    client.session.status = async () => ({ data: { s1: { type: "idle" } } })
    client.session.messages = async () => {
      messageReads += 1
      if (messageReads === 1) {
        messagesStarted()
        await releaseMessagesPromise
      }
      return {
        data: [
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "Resumed task finished" }],
          },
        ],
      }
    }

    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {})
    const processor1 = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))
    const processor2 = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))

    const resumed = processor1.continueSession(blockedItem.id, "s1", workspace)
    await messagesStartedPromise
    const processed = await processor2.processNext()
    releaseMessages()
    await resumed

    assert.equal(processed, false)
    assert.equal(queueManager.getItem(blockedItem.id).status, "review_pending")
    assert.equal(queueManager.getItem(pendingItem.id).status, "pending")
  })
})

test("pending retry items wait until nextRetryAt before processing", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, QUEUE_FILE } = testingModule
    try {
      unlinkSync(QUEUE_FILE)
    } catch {}

    const queueManager = new QueueManager()
    const delayed = await queueManager.addItem(workspace, "Delayed retry")
    assert.ok("id" in delayed)
    await queueManager.updateItem(delayed.id, {
      status: "pending",
      retryCount: 1,
      nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
    })

    assert.equal(await queueManager.getNextPending(), undefined)

    await queueManager.updateItem(delayed.id, {
      nextRetryAt: new Date(Date.now() - 1000).toISOString(),
    })

    const next = await queueManager.getNextPending()
    assert.equal(next.id, delayed.id)
  })
})

test("corrupted queue store is preserved and mutation is refused", async () => {
  await withTempRepo(async ({ configHome }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, QUEUE_CORRUPTION_MARKER_FILE, QUEUE_FILE } = testingModule

    const opencodeDir = join(configHome, "opencode")
    mkdirSync(opencodeDir, { recursive: true })
    const queuePath = QUEUE_FILE
    const queueManager = new QueueManager()
    await queueManager.updateConfig({ idleTimeoutSeconds: 3600 })
    assert.equal(existsSync(queuePath), true)
    writeFileSync(queuePath, "{not json", "utf8")

    await assert.rejects(
      queueManager.updateConfig({ idleTimeoutSeconds: 42 }),
      /Queue store is corrupted/,
    )

    const markerPath = QUEUE_CORRUPTION_MARKER_FILE
    assert.equal(existsSync(markerPath), true)
    const marker = JSON.parse(readFileSync(markerPath, "utf8"))
    assert.equal(typeof marker.backupPath, "string")
    assert.equal(existsSync(marker.backupPath), true)
    assert.equal(readFileSync(queuePath, "utf8"), "{not json")
  })
})
