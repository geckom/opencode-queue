import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const pluginModuleUrl = pathToFileURL(new URL("../dist/opencode-queue.js", import.meta.url).pathname).href
const testingModuleUrl = pathToFileURL(new URL("../dist/testing.js", import.meta.url).pathname).href

export function createTempConfigHome() {
  return mkdtempSync(join(tmpdir(), "opencode-queue-"))
}

export async function loadBuiltModules(configHome) {
  process.env.XDG_CONFIG_HOME = configHome
  const suffix = `?t=${Date.now()}-${Math.random()}`
  const [pluginModule, testingModule] = await Promise.all([
    import(`${pluginModuleUrl}${suffix}`),
    import(`${testingModuleUrl}${suffix}`),
  ])
  return { pluginModule, testingModule }
}

export async function resetBuiltState(configHome) {
  try {
    const { testingModule } = await loadBuiltModules(configHome)
    testingModule.resetSharedState()
  } catch {}
}

export async function withTempRepo(run) {
  const configHome = createTempConfigHome()
  const workspace = join(configHome, "workspace")
  mkdirSync(workspace, { recursive: true })
  try {
    await run({ configHome, workspace })
  } finally {
    await resetBuiltState(configHome)
    rmSync(configHome, { recursive: true, force: true })
  }
}

export function stubIntervals() {
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  return () => {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
}

export function createMockClient() {
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

export function createMultiSessionMockClient() {
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
        for (const sessionId of sessions) {
          map[sessionId] = { type: "idle" }
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

export async function createPluginHooks({ workspace, configHome, client = createMockClient(), stubTimers = false }) {
  const restoreTimers = stubTimers ? stubIntervals() : null
  try {
    const { pluginModule, testingModule } = await loadBuiltModules(configHome)
    const hooks = await pluginModule.default({
      client,
      project: { id: "p1", name: "test", root: workspace, path: workspace },
      directory: workspace,
      worktree: workspace,
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register() {} },
      $: async () => ({ stdout: "", stderr: "" }),
    })
    return { hooks, pluginModule, testingModule, restoreTimers }
  } catch (error) {
    restoreTimers?.()
    throw error
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
