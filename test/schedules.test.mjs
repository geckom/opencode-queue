import test from "node:test"
import assert from "node:assert/strict"
import { createPluginHooks, createMultiSessionMockClient, loadBuiltModules, sleep, withTempRepo } from "./helpers.mjs"

test("one-off schedule fires and creates a pending queue item at the front", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, ScheduleManager } = testingModule

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)
    await queueManager.addItem(workspace, "Manual task")

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

    await sleep(50)

    const items = queueManager.listItems()
    assert.equal(items.length, 2)
    assert.equal(items[0].goal, "One-off past task")
    assert.equal(items[0].sourceScheduleId, task.id)
    assert.equal(items[1].goal, "Manual task")

    const updatedSchedule = queueManager.getSchedule(task.id)
    assert.equal(updatedSchedule.enabled, false)
    assert.equal(updatedSchedule.occurrenceCount, 1)

    scheduleManager.stop()
  })
})

test("recurring schedule generates items and updates occurrence count", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, ScheduleManager } = testingModule

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "Every second task",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: 2,
      parentItemId: null,
      dependencyMode: "review_pending",
    })
    assert.equal(scheduleManager.jobs.get(task.id).unrefTimeout, true)

    await sleep(2500)

    const items = queueManager.listItems().filter((item) => item.sourceScheduleId === task.id)
    assert.equal(items.length, 2)
    assert.equal(queueManager.getSchedule(task.id).occurrenceCount, 2)
    assert.equal(queueManager.getSchedule(task.id).enabled, false)

    scheduleManager.stop()
  })
})

test("duplicate recurring triggers only enqueue one item for the same occurrence", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager } = testingModule

    const queueManager = new QueueManager()
    const task = await queueManager.addSchedule({
      workspace,
      goal: "Single occurrence",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: null,
      parentItemId: null,
      dependencyMode: "review_pending",
    })
    await queueManager.updateSchedule(task.id, { nextTriggerAt: new Date(Date.now() - 1000).toISOString() })

    await Promise.all([queueManager.triggerSchedule(task.id), queueManager.triggerSchedule(task.id)])

    const items = queueManager.listItems().filter((item) => item.sourceScheduleId === task.id)
    const updatedSchedule = queueManager.getSchedule(task.id)
    assert.equal(items.length, 1)
    assert.equal(updatedSchedule.occurrenceCount, 1)
    assert.ok(new Date(updatedSchedule.nextTriggerAt).getTime() > Date.now())
  })
})

test("max-occurrence disable clears nextTriggerAt", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, ScheduleManager } = testingModule

    const queueManager = new QueueManager()
    const scheduleManager = new ScheduleManager(queueManager)

    const task = await scheduleManager.addAndStart({
      workspace,
      goal: "Disable cleanly",
      scheduledFor: null,
      cronExpression: "* * * * * *",
      timezone: "UTC",
      enabled: true,
      maxOccurrences: 1,
      parentItemId: null,
      dependencyMode: "review_pending",
    })

    await sleep(1500)

    const updated = queueManager.getSchedule(task.id)
    assert.equal(updated.enabled, false)
    assert.equal(updated.occurrenceCount, 1)
    assert.equal(updated.nextTriggerAt, null)

    scheduleManager.stop()
  })
})

test("startup recovery restores enabled schedules", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, ScheduleManager } = testingModule

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

    const queueManager2 = new QueueManager()
    const scheduleManager2 = new ScheduleManager(queueManager2)
    scheduleManager2.start()
    await sleep(1500)

    const items = queueManager2.listItems().filter((item) => item.sourceScheduleId === task.id)
    assert.ok(items.length >= 1)

    scheduleManager2.stop()
  })
})

test("scheduled items are processed before manual items", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { testingModule } = await loadBuiltModules(configHome)
    const { QueueManager, ScheduleManager, QueueProcessor, IdleDetector } = testingModule

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

    const next = await queueManager.getNextPending()
    assert.equal(next.goal, "Scheduled task")

    const client = createMultiSessionMockClient()
    const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {})
    const processor = new QueueProcessor(queueManager, client, idleDetector, new URL("http://127.0.0.1:4096"))
    await processor.processNext()

    const scheduledItem = queueManager.listItems().find((item) => item.sourceScheduleId)
    assert.equal(scheduledItem.status, "review_pending")

    scheduleManager.stop()
  })
})

test("queue-schedule tools validate and manage schedules end-to-end", async () => {
  await withTempRepo(async ({ configHome, workspace }) => {
    const { hooks, restoreTimers } = await createPluginHooks({ configHome, workspace, stubTimers: true })
    try {
      const invalid = await hooks.tool["queue-schedule-add"].execute({ workspace, goal: "No schedule info" })
      assert.match(invalid, /Error/)

      const futureDate = new Date(Date.now() + 3600_000).toISOString()
      const addResult = await hooks.tool["queue-schedule-add"].execute({
        workspace,
        goal: "Future one-off task",
        scheduledFor: futureDate,
      })
      assert.match(addResult, /Future one-off task/)

      const listResult = await hooks.tool["queue-schedule-list"].execute({ action: "list" })
      assert.match(listResult, /Future one-off task/)

      const { testingModule } = await loadBuiltModules(configHome)
      const queueManager = new testingModule.QueueManager()
      const scheduleId = queueManager.listSchedules()[0].id

      const pauseResult = await hooks.tool["queue-schedule-list"].execute({ action: "pause", scheduleId })
      assert.match(pauseResult, /Paused/)

      const resumeResult = await hooks.tool["queue-schedule-list"].execute({ action: "resume", scheduleId })
      assert.match(resumeResult, /Resumed/)

      const removeResult = await hooks.tool["queue-schedule-list"].execute({ action: "remove", scheduleId })
      assert.match(removeResult, /Removed schedule/)
    } finally {
      restoreTimers?.()
    }
  })
})
