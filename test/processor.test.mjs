import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  createMockClient,
  loadBuiltModules,
  withTempRepo,
} from "./helpers.mjs"

test("processor moves a finished pending item into review and stores the result", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, QueueProcessor, IdleDetector } = testingModule

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
    const { QueueManager, QueueProcessor, IdleDetector } = testingModule

    const queueManager = new QueueManager()
    const created = await queueManager.addItem(workspace, "Take over stale lock")
    assert.ok("id" in created)
    const lockPath = join(configHome, "opencode", "queue.lock")
    mkdirSync(join(configHome, "opencode"), { recursive: true })
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
