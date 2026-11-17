# Trajan

A persistent Pi Durable agent on Cloudflare Workers, with a React chat UI, SQLite-backed conversations and workspace, and sandboxed JavaScript execution.

## Development

Use Node 26.13.1 (see `.node-version`) or another version supported by `package.json`.

```sh
npm ci
npm run dev
```

Authenticate with `cf auth login`, or supply `CLOUDFLARE_API_TOKEN` in your environment. The local Workers AI binding is remote and uses your Cloudflare account; no model API key is needed. Never commit credentials.

```sh
npm run check
npm run build
npm run deploy
npm run smoke -- https://YOUR-WORKER.workers.dev
```

Worker configuration lives in `cloudflare.config.ts`; the Worker is named `trajan`. `GET /api/health` checks HTTP availability. The default model is Workers AI `@cf/zai-org/glm-5.3-flash`.

## Architecture

- `src/server.ts` composes `PiHarness`, `Lifecycle`, WebSockets, and the durable workspace in a `Trajan` Durable Object. Each browser chat uses its own object and Pi's root conversation.
- Pi Durable owns the model loop, inbox, transcript, retries, compaction, and recovery. The SDK stores Pi's state in SQLite and schedules a wake job for running and sleeping tasks.
- `src/sockets.ts` sends session snapshots and patches; `src/mirror.ts` keeps the client transcript and loads older entries. `src/outbox.ts` deduplicates submissions resent after socket reconnects; this outbox is in memory, not persisted across page reloads.
- `src/workspace.ts` adapts file tools. `exec` runs JavaScript ES modules in fresh Dynamic Workers, with workspace filesystem access and a host Git module. It is not a shell and cannot install npm packages. Reads, whole-file writes, and deletes are replay-safe; edits and arbitrary execution are not automatically replayed.
- `src/tests` retains the upstream runtime tests for WebSocket recovery, transcript paging, reconnect deduplication, and workspace tool declarations.

The starting UI is a playground without application authentication. Possession of a chat's object ID provides access to that chat; add authentication before sharing it with other users. Pi Durable currently has no built-in approval step for tools.

## Upstream

Adapted from [Cloudflare's Pi harness example](https://github.com/cloudflare/agents/tree/c31b57e11e19ad532915fcf15dec5f1be916d5b7/examples/next/harnesses/pi), under the MIT license retained in `LICENSE`. Pi's license is retained in `licenses/`. See the [Pi harness guide](https://developers.cloudflare.com/agents/harnesses/pi/).
