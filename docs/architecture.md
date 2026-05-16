# Architecture

`opencode-queue` is authored as a modular TypeScript codebase and deployed as a single bundled OpenCode plugin file.

## Source Layout

- `src/plugin.ts`: OpenCode hook registration and tool definitions
- `src/queue-manager.ts`: queue store normalization, persistence, locking-backed mutations
- `src/queue-processor.ts`: queue processing state machine and session lifecycle
- `src/schedule-manager.ts`: cron lifecycle and schedule restoration
- `src/shared-state.ts`: coordinator singleton and process cleanup
- `src/testing.ts`: dedicated non-runtime test surface

## Runtime Build Flow

1. `npm run build`
   - Runs `tsc`
   - Emits ESM modules into `dist/`
   - Produces both runtime modules and the `dist/testing.js` test surface
2. `npm test`
   - Runs Node tests against the compiled `dist/` output
3. `npm run bundle`
   - Bundles `src/opencode-queue.ts` into `dist/opencode-queue.bundled.js`
   - Keeps the runtime plugin export surface minimal for OpenCode
4. `npm run build:runtime`
   - Builds and bundles
   - Copies the bundled plugin to `~/.config/opencode/plugins/opencode-queue.js`

## Design Notes

- Queue state mutations must flow through `QueueManager` and `FileLock`.
- `ScheduleManager` should not reach into private persistence internals; it should call explicit `QueueManager` APIs.
- Tests should import `dist/testing.js` instead of runtime plugin internals so the deployed bundle stays minimal.
