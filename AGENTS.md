# AGENTS.md

This file provides context for AI coding agents working on this repository. It should be kept up to date as the codebase evolves — when adding classes, tools, hooks, or changing architecture, update the relevant section below.

## Purpose

This repo is the source of truth for the `opencode-queue` OpenCode plugin. The plugin maintains a global task queue and processes queued work when OpenCode is idle.

Do not treat `~/.config/opencode` as the primary development location. Runtime artifacts are deployed there, but source changes must be made here first.

## Project Layout

- `src/` — modular TypeScript source; `src/opencode-queue.ts` is the compatibility entrypoint and `src/plugin.ts` contains hook/tool wiring
- `src/testing.ts` — dedicated test-only export surface for compiled-output tests
- `test/*.test.mjs` — tests running against compiled output, with shared helpers in `test/helpers.mjs`
- `opencode.jsonc` — local project config for developing this repo inside opencode
- `.github/workflows/ci.yml` — CI: build, test, pack check
- `dist/` — compiled output (gitignored, rebuilt by `npm run build`)

## Architecture

The plugin is intentionally modular in source, but still deployed as a single bundled runtime file for OpenCode. The main classes are:

- **QueueManager** — reads/writes `~/.config/opencode/queue.json`, handles locking, CRUD operations on queue items and scheduled tasks
- **IdleDetector** — watches `~/.config/opencode/queue.last-activity`, triggers processing when OpenCode goes idle
- **FileLock** — file-based locking for the processing lock and store lock
- **BlockWatcher** — detects blocked sessions (permission requests, questions) and auto-resumes via `permission.replied` / `message.updated` event hooks
- **QueueProcessor** — picks the next pending item, starts a session, monitors progress, handles retry/failure
- **SessionGreeter** — sends an initial prompt to new queue sessions
- **ScheduleManager** — manages CronJob instances for one-off and recurring scheduled tasks; creates queue items when schedules fire

### Plugin entry point

`OpencodeQueuePlugin()` is the default export. `src/opencode-queue.ts` is the package/runtime entry shim that re-exports the plugin. The plugin registers:

- **8 tools**: `queue-list`, `queue-add`, `queue-confirm`, `queue-followup`, `queue-remove`, `queue-retry`, `queue-schedule-add`, `queue-schedule-list`
- **Activity hooks**: `chat.message`, `tool.execute.before`, `tool.execute.after` — refresh idle timer
- **Event hooks**: `session.created`, `session.updated`, `command.executed`, `tui.command.execute`, `question.replied`, `question.rejected` — activity signals; `permission.replied` — auto-unblocks permission-blocked items; `message.updated` — auto-unblocks question-blocked items; `session.idle` — no-op

### State machine

Queue items follow this lifecycle:

```
pending → running → review_pending → completed
                  → blocked → running (via event hooks)
                  → failed → pending (retry)
```

Scheduled tasks (`ScheduledTask`) are templates that generate queue items. They are stored in `queue.json` alongside items but are separate objects. When a schedule fires, it creates a `pending` queue item at the front of the queue with `sourceScheduleId` linking back to the schedule. One-off tasks auto-disable after firing; recurring tasks fire on a cron expression until paused or `maxOccurrences` is reached.

### Coordinator pattern

Only one opencode process acts as coordinator at a time, claimed via a file-based processing lock. Non-coordinator processes still register activity hooks so the shared idle timer stays fresh.

### Config

Queue config lives in `~/.config/opencode/queue.json` under the `config` key. The file also contains `items` (queue items) and `schedules` (scheduled tasks). Changes are hot-reloaded without restarting opencode. Defaults:

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

- `queue.json` — queue items, scheduled tasks, and config
- `queue.last-activity` — timestamp of last activity
- `queue.lock` — processing lock (stale after 120s)
- `queue.store.lock` — store lock for concurrent reads/writes (stale after 15s)

### Scheduled tasks

Scheduled tasks use the `cron` library (`cron@4.x`). Only the coordinator process runs CronJob instances. On startup, `ScheduleManager.start()` restores all enabled schedules. One-off tasks with past `scheduledFor` dates fire immediately. Scheduled items are prepended to the queue (front of array) so they are processed before manually-added items.

## Required Workflow

When changing the plugin:

1. Edit files in this repo
2. Run `npm test`
3. Run `npm run build:runtime`
4. Smoke test with `opencode --print-logs debug config`

Do not hand-edit deployed files in `~/.config/opencode/plugins/` unless you are repairing a broken deploy — and then sync the same change back into this repo immediately.

## Guardrails

- Keep the runtime plugin module export shape minimal. OpenCode treats function exports as plugin entrypoints, so the deployed bundle should expose only the default plugin export. Use `src/testing.ts` for test-only exports instead of hanging internals off the runtime export.
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
