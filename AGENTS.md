# Trajan

Trajan uses Pi Durable through `agents/harness/pi` on Cloudflare Workers.

- Use `cf` and `cloudflare.config.ts` for the app. Vitest loads a separate `src/tests/cloudflare.config.ts` for the test Worker.
- Check current Cloudflare docs before changing Workers or Agents SDK behavior. Use `cf docs search` for platform guidance and `cf cli search` to find commands. For Pi lifecycle and recovery, consult the [Pi harness guide](https://developers.cloudflare.com/agents/harnesses/pi/).
- Use the Node version in `.node-version` and npm with `package-lock.json`.
- Run `npm run check` and `npm run build` before publishing changes.
- Keep `--force` in the deploy script so dashboard secret updates cannot block Workers Builds on false configuration conflicts ([cf#69](https://github.com/cloudflare/cf/issues/69), [cf#466](https://github.com/cloudflare/cf/issues/466)). Treat `cloudflare.config.ts` as the source of truth for Worker configuration.
- Keep credentials out of source and logs. Workers AI uses the AI binding.
- Preserve Pi's ownership of the transcript, retries, inbox, and recovery. Treat the WebSocket protocol and UI projections as app code.
- Tool replay safety must reflect whether repeating the operation is harmless.
