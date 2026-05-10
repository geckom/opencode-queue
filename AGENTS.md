# AGENTS.md

## Purpose

This repo is the source of truth for the `opencode-queue` OpenCode plugin.

Do not treat `~/.config/opencode` as the primary development location. Runtime artifacts are deployed there, but source changes should be made here first.

## Project Layout

- `src/opencode-queue.ts`: main plugin implementation
- `test/plugin.test.mjs`: smoke tests for queue tools and processor behavior
- `.github/workflows/ci.yml`: public GitHub CI for build, test, and package checks
- `dist/`: compiled output from `npm run build`
- `opencode.jsonc`: local project config used while developing this repo

## Runtime Layout

The live global plugin is deployed to:

- `~/.config/opencode/plugins/opencode-queue.js`: the single auto-loaded compiled plugin file

## Required Workflow

When changing the plugin:

1. Edit files in this repo.
2. Run `npm test`.
3. Run `npm run build:runtime`.
4. Smoke check with `opencode --print-logs debug config`.

Do not hand-edit deployed files in `~/.config/opencode/plugins/` unless you are repairing a broken deploy and then syncing the same change back into this repo immediately.

## Guardrails

- Keep the runtime plugin module export shape minimal. OpenCode treats function exports as plugin entrypoints, so the deployed module should expose only the default plugin export.
- Prefer non-blocking startup behavior. Timers should not keep short-lived OpenCode commands alive.
- Toasts are best-effort only. They must not block plugin startup.
- If you add new tests, keep them runnable against compiled output, not just TypeScript source.

## Commands

- `npm test`
- `npm run build`
- `npm run build:runtime`
- `npm run pack:check`

## Definition Of Done

A plugin change is not done until:

- tests pass
- runtime artifact is rebuilt and copied into `~/.config/opencode`
- `opencode --print-logs debug config` shows the plugin loading without errors
