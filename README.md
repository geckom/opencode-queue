# opencode-queue

`opencode-queue` is an OpenCode plugin that keeps a global task queue in `~/.config/opencode/queue.json` and processes queued work when OpenCode is idle.

This repo is the source of truth for the plugin formerly developed under the working name `ExecutiveAssistant`.

## What It Does

- adds queue management tools such as `queue-add`, `queue-list`, `queue-status`, `queue-answer`, `queue-remove`, `queue-log`, and `queue-retry`
- stores queue state in a shared JSON file
- watches global activity through `queue.last-activity`
- processes one queued item at a time when OpenCode becomes idle
- keeps blocked and failed work in the queue for later action

## Repo Layout

- `src/opencode-queue.ts`: plugin implementation
- `src/opencode-plugin.ts`: thin published entrypoint
- `test/plugin.test.mjs`: plugin tests against compiled output

## Local Development

```bash
npm install
npm run build
npm test
```

To deploy the local build into your OpenCode config:

```bash
npm run build:runtime
```

That writes:

- `~/.config/opencode/plugins/opencode-queue.js`
- `~/.config/opencode/plugin/opencode-queue/index.js`

## Publish Checklist

Before publishing:

1. Run `npm test`
2. Run `npm run build`
3. Run `npm run pack:check`
4. Run `npm run build:runtime`
5. Smoke test with `opencode --print-logs debug config`
6. Create the public GitHub repo named `opencode-queue`
7. Update `package.json` `repository`, `bugs`, and `homepage` fields to point at that repo
8. Push the repo and verify GitHub Actions passes

## Install From GitHub

Once this repo is public, OpenCode can load it from a Git dependency:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-queue@git+https://github.com/<owner>/opencode-queue.git"
  ]
}
```

Replace `<owner>` with the GitHub owner or org.

## GitHub Readiness

The repo is set up to be published publicly:

- package name is `opencode-queue`
- license is MIT
- CI should run on pushes and pull requests
- the package tarball is limited to `dist/`, `README.md`, and `LICENSE`
- `npm run build:runtime` deploys the live OpenCode runtime under `opencode-queue` paths and removes the legacy `executive-assistant` runtime

One manual step remains before first public release: replace placeholder GitHub URLs in `package.json` after you create the real repository.

## License

MIT
