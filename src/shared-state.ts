import type { OpencodeClient } from "@opencode-ai/sdk"
import { LOCK_FILE, SIGNAL_EXIT_CODE } from "./constants.js"
import { FileLock } from "./file-lock.js"
import { IdleDetector } from "./idle-detector.js"
import { QueueProcessor } from "./queue-processor.js"
import { QueueManager } from "./queue-manager.js"
import { ScheduleManager } from "./schedule-manager.js"

const SHARED_STATE_KEY = Symbol.for("opencode.queue.shared-state")

export interface SharedState {
  queueManager: QueueManager
  idleDetector: IdleDetector
  scheduleManager: ScheduleManager
  coordinatorClaimed: boolean
  initialized: Promise<void>
  cleanupHandlers: Array<{
    event: "exit" | "beforeExit" | NodeJS.Signals
    handler: () => void
  }>
  cleanedUp: boolean
}

export function createSharedState(client: OpencodeClient, serverUrl: URL): SharedState {
  const queueManager = new QueueManager()
  const idleDetector = new IdleDetector(() => queueManager.getConfig(), async () => {
    const processor = new QueueProcessor(queueManager, client, idleDetector, serverUrl)
    await processor.processQueue()
  })
  const scheduleManager = new ScheduleManager(queueManager)

  return {
    queueManager,
    idleDetector,
    scheduleManager,
    coordinatorClaimed: false,
    initialized: queueManager.resetRunningToPending(),
    cleanupHandlers: [],
    cleanedUp: false,
  }
}

export function cleanupSharedState(shared: SharedState): void {
  if (shared.cleanedUp) return
  shared.cleanedUp = true
  shared.scheduleManager.stop()
  shared.idleDetector.stop()
  FileLock.release(LOCK_FILE)
}

export function registerProcessCleanup(shared: SharedState): void {
  if (shared.cleanupHandlers.length > 0) return

  const onExit = () => {
    cleanupSharedState(shared)
  }
  const onBeforeExit = () => {
    cleanupSharedState(shared)
  }
  const registerSignalHandler = (signal: "SIGINT" | "SIGTERM") => {
    const handler = () => {
      cleanupSharedState(shared)
      process.exit(SIGNAL_EXIT_CODE[signal] ?? 0)
    }
    process.once(signal, handler)
    shared.cleanupHandlers.push({ event: signal, handler })
  }

  process.once("exit", onExit)
  shared.cleanupHandlers.push({ event: "exit", handler: onExit })
  process.once("beforeExit", onBeforeExit)
  shared.cleanupHandlers.push({ event: "beforeExit", handler: onBeforeExit })
  registerSignalHandler("SIGINT")
  registerSignalHandler("SIGTERM")
}

export function unregisterProcessCleanup(shared: SharedState): void {
  for (const { event, handler } of shared.cleanupHandlers) {
    process.removeListener(event, handler)
  }
  shared.cleanupHandlers = []
}

export function getSharedState(client: OpencodeClient, serverUrl: URL): SharedState {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_STATE_KEY]?: SharedState
  }
  if (!globalState[SHARED_STATE_KEY]) {
    globalState[SHARED_STATE_KEY] = createSharedState(client, serverUrl)
  }
  return globalState[SHARED_STATE_KEY]
}

export function resetSharedState(): void {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_STATE_KEY]?: SharedState
  }
  if (globalState[SHARED_STATE_KEY]) {
    unregisterProcessCleanup(globalState[SHARED_STATE_KEY]!)
    cleanupSharedState(globalState[SHARED_STATE_KEY]!)
  }
  delete globalState[SHARED_STATE_KEY]
}
