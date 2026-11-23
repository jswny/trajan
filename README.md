# Trajan

A persistent Pi Durable agent on Cloudflare Workers, with a React chat UI, SQLite-backed conversations and workspace, and sandboxed JavaScript execution.

## Deployment

- Live app: https://trajan.j1.io
- GitHub: https://github.com/jswny/trajan (private)
- Local checkout: `/Users/joe/source/trajan`

Pushes to `main` trigger Cloudflare Workers Builds. The build command runs `npm run check`, then `npm run deploy` builds and deploys the Worker. The linked build uses the account's existing Workers Builds token; no deployment credential is stored in GitHub or this repository.

Both `trajan.j1.io` and the legacy `trajan.j1d.workers.dev` address are protected by the **Trajan** Cloudflare Access application, which uses the reusable **Only me** policy shared with Concierge. Sign-in sessions last 24 hours. Chat IDs are saved in browser storage per hostname, so use the legacy address to reopen chats started there. Preview URLs are disabled in `cloudflare.config.ts`. Access configuration is managed in Cloudflare.

`npm run smoke -- "$LOCAL_DEV_URL"` (using the URL printed by `npm run dev`) exercises real Workers AI, workspace write/read, conversation restoration after reconnect, and Dynamic Worker execution in a fresh isolated chat. It incurs normal Workers AI usage. The smoke script does not authenticate to Access; it cannot run directly against the protected production hostname. Use the signed-in browser UI to verify production chat.

## Development

Use Node 26.13.1 (see `.node-version`) or another version supported by `package.json`.

```sh
npm ci
npm run dev
```

If Cloudflare needs a login, run `npx cf auth login` and restart the dev server. You can also supply `CLOUDFLARE_API_TOKEN` in your environment. Never commit credentials.

Open the local URL printed by Vite (usually `http://localhost:5173`) to use the chat UI. The dev server runs the Worker, Durable Objects, workspace, and WebSockets locally. Model calls go through your Cloudflare Workers AI binding and incur normal usage. The dev proxy uses the `trajan-local` Worker name to keep it separate from the production Access hostname.

`npm run check` generates Worker types, runs Vite+ format, lint, and type checks, and runs the Worker tests. Use `npm run format` to apply formatting.

Use `npm run build` to verify the production bundle separately. `npm run deploy` builds the Worker itself.

```sh
npm run check
npm run deploy
npm run smoke -- "$LOCAL_DEV_URL"
```

Run the browser recovery test with Playwright's headless Chromium.

```sh
npx playwright install chromium --only-shell
npm run test:browser
```

The tests start a local Worker fixture with temporary storage and a faux model. They check recovery from reconnects, missing submit receipts, and missing transcript snapshots. They verify that recovery preserves drafts and transcripts and that Pi runs each prompt once. The fixture log is in `.cloudflare/browser-smoke.log`.

Worker configuration lives in `cloudflare.config.ts`; the Worker is named `trajan`. `GET /api/health` checks HTTP availability. The default model is Workers AI `@cf/deepseek-ai/deepseek-v4.1-flash-1017`. Existing chats that used the retired GLM model switch when Pi opens them.

After a conversation runs on Pi 1.6, roll forward to fix production issues. Pi 1.5 cannot run the newer model and tool tasks written by Pi 1.6. [Pi harness upgrade guidance](https://developers.cloudflare.com/agents/harnesses/pi/#install)

## Architecture

- `src/server.ts` composes `PiHarness`, `Lifecycle`, WebSockets, and the durable workspace in a `Trajan` Durable Object. Each browser chat uses its own object and Pi's root conversation.
- Pi Durable owns the model loop, inbox, transcript, retries, compaction, and recovery. The SDK stores Pi's state in SQLite and schedules a wake job for running and sleeping tasks.
- `src/sockets.ts` sends session snapshots and patches. `src/mirror.ts` keeps the client transcript and loads older entries. The in-memory outbox in `src/outbox.ts` preserves operation IDs for reconnect and receipt recovery. Pi deduplicates the replays.
- `src/workspace.ts` adapts file tools. `exec` runs JavaScript ES modules in fresh Dynamic Workers, with workspace filesystem access and a host Git module. It is not a shell and cannot install npm packages. Reads, whole-file writes, and deletes are replay-safe; edits and arbitrary execution are not automatically replayed.
- `src/tests` retains the upstream runtime tests for WebSocket recovery, transcript paging, reconnect deduplication, and workspace tool declarations.

Cloudflare Access authenticates requests at the production hostname. The app does not enforce per-user chat ownership: anyone allowed by the Access policy who knows a chat's object ID can access that chat. Review that boundary before expanding the policy to other users. Trajan runs tools without an approval step.

## Upstream

Adapted from [Cloudflare's Pi harness example](https://github.com/cloudflare/agents/tree/c31b57e11e19ad532915fcf15dec5f1be916d5b7/examples/next/harnesses/pi), under the MIT license retained in `LICENSE`. Pi's license is retained in `licenses/`. See the [Pi harness guide](https://developers.cloudflare.com/agents/harnesses/pi/).
