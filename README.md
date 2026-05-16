# opencode-queue

[![Buy Me A Coffee](https://img.shields.io/badge/Support-Buy%20Me%20A%20Coffee-yellow?logo=buymeacoffee)](https://buymeacoffee.com/geckom)

An [OpenCode](https://opencode.ai) plugin that maintains a global task queue and processes queued work when OpenCode is idle.

## How it works

The plugin stores a shared queue in `~/.config/opencode/queue.json`. When OpenCode is idle, it picks the next pending item, creates a session for it, and monitors progress. Blocked items (permission requests, questions) stay in the queue until resolved. Completed work enters a review state before final close-out.

### Features

- **Queue management tools** — add, list, confirm, follow up, remove, and retry items
- **Idle processing** — automatically starts the next queued task when OpenCode is idle
- **Permission and question handling** — detects blocked sessions and auto-resumes when you respond through any opencode interface
- **Review gate** — finished work enters `review_pending` state for human sign-off before marking complete
- **Task dependencies** — parent-child relationships with configurable dependency modes
- **Retry with backoff** — failed items retry automatically with increasing delays
- **Blocked reminders** — periodically nudges when a queue item is waiting for a response
- **Scheduled tasks** — one-off (run once at a specific time) or recurring (cron-based) scheduled items that automatically prepend to the front of the queue
- **Schedule management** — pause, resume, and remove scheduled tasks; automatic auto-disable after a configurable number of occurrences
- **Hot-reload config** — change queue settings without restarting OpenCode

## Tools

| Tool | Description |
|------|-------------|
| `queue-add` | Add a task to the queue |
| `queue-list` | List queue items, with optional status filter and view modes |
| `queue-confirm` | Mark a `review_pending` item as complete |
| `queue-followup` | Send a follow-up message on a `review_pending` item |
| `queue-remove` | Remove a queue item |
| `queue-retry` | Retry a failed item |
| `queue-schedule-add` | Schedule a one-off or recurring task |
| `queue-schedule-list` | List, pause, resume, or remove scheduled tasks |

## Installation

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-queue@git+https://github.com/geckom/opencode-queue.git"
  ]
}
```

## Configuration

The queue reads its settings from `~/.config/opencode/queue.json`. Edit the `config` object there — changes apply immediately without restarting OpenCode.

| Setting | Default | Description |
|---------|---------|-------------|
| `idleTimeoutSeconds` | `3600` | Seconds of inactivity before the next item is processed |
| `blockedReminderMinutes` | `30` | Minutes between reminders for blocked items |
| `maxRetries` | `3` | Maximum retry attempts for failed items |
| `retryDelaysMinutes` | `[5, 10, 15]` | Delay in minutes before each retry attempt |
| `reminderIntervalMessages` | `30` | Messages between blocked-item reminders |

## Development

```bash
npm install
npm run build
npm test
```

To deploy into your local OpenCode config:

```bash
npm run build:runtime
```

## License

MIT
