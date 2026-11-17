# Trajan

Trajan uses Pi Durable through `agents/harness/pi` on Cloudflare Workers.

- Use `cf` and `cloudflare.config.ts` for the app. The Wrangler file under `src/tests` is only a Vitest fixture.
- Use the Node version in `.node-version` and npm with `package-lock.json`.
- Run `npm run check` and `npm run build` before publishing changes.
- Keep credentials out of source and logs. Workers AI uses the AI binding.
- Preserve Pi's ownership of the transcript, retries, inbox, and recovery. Treat the WebSocket protocol and UI projections as app code.
- Tool replay safety must reflect whether repeating the operation is harmless.
