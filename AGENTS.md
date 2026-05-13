# AGENTS.md

This file provides context for AI coding agents working on this repository. It should be kept up to date as the codebase evolves — when adding classes, tools, hooks, or changing architecture, update the relevant section below.

## Purpose

This repo is the source of truth for the `opencode-queue` OpenCode plugin. The plugin maintains a global task queue and processes queued work when OpenCode is idle.

Do not treat `~/.config/opencode` as the primary development location. Runtime artifacts are deployed there, but source changes must be made here first.

## Project Layout

- `src/opencode-queue.ts` — single source file containing the entire plugin
- `test/plugin.test.mjs` — tests running against compiled output
- `opencode.jsonc` — local project config for developing this repo inside opencode
- `.github/workflows/ci.yml` — CI: build, test, pack check
- `dist/` — compiled output (gitignored, rebuilt by `npm run build`)

## Architecture

Everything lives in `src/opencode-queue.ts`. The main classes are:

- **QueueManager** — reads/writes `~/.config/opencode/queue.json`, handles locking, CRUD operations on queue items
- **IdleDetector** — watches `~/.config/opencode/queue.last-activity`, triggers processing when OpenCode goes idle
- **FileLock** — file-based locking for the processing lock and store lock
- **BlockWatcher** — detects blocked sessions (permission requests, questions) and auto-resumes via `permission.replied` / `message.updated` event hooks
- **QueueProcessor** — picks the next pending item, starts a session, monitors progress, handles retry/failure
- **SessionGreeter** — sends an initial prompt to new queue sessions

### Plugin entry point

`OpencodeQueuePlugin()` is the default export. It registers:

- **6 tools**: `queue-list`, `queue-add`, `queue-confirm`, `queue-followup`, `queue-remove`, `queue-retry`
- **Activity hooks**: `chat.message`, `tool.execute.before`, `tool.execute.after` — refresh idle timer
- **Event hooks**: `session.created`, `session.updated`, `command.executed`, `tui.command.execute`, `question.replied`, `question.rejected` — activity signals; `permission.replied` — auto-unblocks permission-blocked items; `message.updated` — auto-unblocks question-blocked items; `session.idle` — no-op

### State machine

Queue items follow this lifecycle:

```
pending → running → review_pending → completed
                  → blocked → running (via event hooks)
                  → failed → pending (retry)
```

### Coordinator pattern

Only one opencode process acts as coordinator at a time, claimed via a file-based processing lock. Non-coordinator processes still register activity hooks so the shared idle timer stays fresh.

### Config

Queue config lives in `~/.config/opencode/queue.json` under the `config` key. Changes are hot-reloaded without restarting opencode. Defaults:

| Setting | Default | Description |
|---------|---------|-------------|
| `idleTimeoutSeconds` | `3600` | Inactivity before processing next item |
| `blockedReminderMinutes` | `30` | Minutes between blocked-item reminders |
| `maxRetries` | `3` | Max retry attempts for failed items |
| `retryDelaysMinutes` | `[5, 10, 15]` | Delay before each retry |
| `reminderIntervalMessages` | `30` | Messages between reminders |

## Runtime Layout

The live global plugin is deployed to:

- `~/.config/opencode/plugins/opencode-queue.js`

Runtime state files (all in `~/.config/opencode/`):

- `queue.json` — queue items and config
- `queue.last-activity` — timestamp of last activity
- `queue.lock` — processing lock (stale after 120s)
- `queue.store.lock` — store lock for concurrent reads/writes (stale after 15s)

## Required Workflow

When changing the plugin:

1. Edit files in this repo
2. Run `npm test`
3. Run `npm run build:runtime`
4. Smoke test with `opencode --print-logs debug config`

Do not hand-edit deployed files in `~/.config/opencode/plugins/` unless you are repairing a broken deploy — and then sync the same change back into this repo immediately.

## Guardrails

- Keep the runtime plugin module export shape minimal. OpenCode treats function exports as plugin entrypoints, so the deployed module should expose only the default plugin export.
- Prefer non-blocking startup behavior. Timers must not keep short-lived OpenCode commands alive.
- Toasts are best-effort only. They must not block plugin startup.
- Tests run against compiled output (`dist/`), not TypeScript source. Always `npm run build` before `npm test`.
- Use `FileLock` for any concurrent access to queue state files.

## Commands

- `npm run build` — compile TypeScript to `dist/`
- `npm test` — run tests against compiled output
- `npm run build:runtime` — build + deploy to `~/.config/opencode/plugins/`
- `npm run pack:check` — preview what `npm pack` would include

## Definition Of Done

A plugin change is not done until:

- tests pass
- runtime artifact is rebuilt and copied into `~/.config/opencode`
- `opencode --print-logs debug config` shows the plugin loading without errors

## Keeping This File Updated

When making changes that affect any of the following, update the corresponding section in this file:

- Adding or renaming classes → update **Architecture**
- Adding or removing tools → update **Plugin entry point** and tools list
- Adding or changing event hooks → update **Plugin entry point**
- Changing the item lifecycle → update **State machine**
- Adding new runtime files or config keys → update **Runtime Layout** or **Config**
- Adding or renaming npm scripts → update **Commands**
