# AGENTS.md

Repo-specific guidance for AI coding agents working on `opencode-queue`.

## Purpose

This repo is the source of truth for the `opencode-queue` OpenCode plugin. Do not treat `~/.config/opencode` as the primary development location. Source changes must be made here first.

## Project Layout

- `src/plugin.ts` — plugin entrypoint, hooks, and tools
- `src/queue-manager.ts` — persisted queue/schedule state and mutation APIs
- `src/queue-processor.ts` — processing state machine and session lifecycle
- `src/schedule-manager.ts` — CronJob lifecycle and schedule restoration
- `src/shared-state.ts` — singleton coordinator/shared process state
- `src/session-greeter.ts` — queue toasts and blocked reminders
- `src/opencode-queue.ts` — runtime/package entry shim
- `src/testing.ts` — local test-only surface
- `test/*.test.mjs` — tests against compiled output
- `dist/` — compiled output, rebuilt by `npm run build`

## Runtime Layout

Live runtime plugin:

- `~/.config/opencode/plugins/opencode-queue.js`

Runtime state files:

- `~/.config/opencode/queue.json`
- `~/.config/opencode/queue.last-activity`
- `~/.config/opencode/queue.lock`
- `~/.config/opencode/queue.store.lock`

## Tools

Registered tools:

- `queue-list`
- `queue-add`
- `queue-confirm`
- `queue-followup`
- `queue-remove`
- `queue-retry`
- `queue-schedule-add`
- `queue-schedule-list`

## Core Rules

- All persisted `queue.json` mutations must go through `QueueManager`.
- `ScheduleManager` must use explicit `QueueManager` APIs, not private store access.
- Keep the deployed runtime bundle export shape minimal: default plugin export only.
- `src/testing.ts` / `dist/testing.js` is for repo tests only, not the published package contract.
- Timers must be `unref()`'d.
- Toasts/reminders are best-effort only and must not block startup or processing.
- Never silently reset corrupted `queue.json`. Preserve it and fail safely.
- Tests depend on compiled `dist/`; do not run build and test in parallel.

## Behavior Notes

- Queue item lifecycle:

```text
pending -> running -> review_pending -> completed
        -> blocked -> running
        -> failed -> pending
```

- Scheduled items are prepended to the queue.
- One-off schedules disable after firing.
- Recurring schedules run until paused or `maxOccurrences` is reached.
- Corrupted `queue.json` is a hard error; the plugin preserves a backup and refuses further mutation until repaired.
- Blocked reminders are time-based toasts controlled by `blockedReminderMinutes`.

## Commands

- `npm run build`
- `npm test`
- `npm run pack:check`
- `npm run build:runtime`
- `opencode --print-logs debug config`

## Definition Of Done

A change is not done until:

- tests pass
- runtime artifact is rebuilt into `~/.config/opencode/plugins/`
- `opencode --print-logs debug config` loads the plugin without errors

## Keep Updated

Update this file when changing:

- source layout or key modules
- tool list
- event/hook behavior
- queue lifecycle
- runtime files or config keys
- npm scripts
