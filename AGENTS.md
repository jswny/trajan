# Trajan

Trajan uses Pi Durable through `agents/harness/pi` on Cloudflare Workers.

## Architecture principles

- Use Effect for app-owned asynchronous workflows and failure handling, and use Effect atoms for shared UI state. Compose effects through the workflow and run them at integration boundaries. Use plain functions for pure transformations and let the renderer schedule DOM work.
- Preserve Pi's ownership of durable agent execution, the transcript, inbox, retries, and recovery. Use Cloudflare's lifecycle and storage APIs for wake-up and persistence. Treat the WebSocket protocol and UI projections as app code.
- Scope subscriptions, timers, and in-flight work to the session, connection, or request that owns them. Distinguish transport connectivity from application readiness and make recovery explicit.
- Validate external data at app boundaries with Effect Schema. Correlate replies before settling requests or clearing user input. Reuse the original operation ID when retrying the same operation. Mark tools replay-safe only when repeating them is harmless.
- Test the failure and recovery paths of lifecycle changes. Exercise user-facing recovery in a real browser against a local Worker.
- Prioritize a current standard-size iPhone viewport for UI changes. Verify affected flows in a real browser at that size, on narrower phones, and at tablet and desktop widths. Check iPhone safe areas and on-screen keyboard behavior when the change affects layout or text input.

## Development and release

- Use `cf` and `cloudflare.config.ts` for the app. Vitest loads a separate `src/tests/cloudflare.config.ts` for the test Worker.
- Check current Cloudflare docs before changing Workers or Agents SDK behavior. Use `cf docs search` for platform guidance and `cf cli search` to find commands. For Pi lifecycle and recovery, consult the [Pi harness guide](https://developers.cloudflare.com/agents/harnesses/pi/).
- Use the Node version in `.node-version` and npm with `package-lock.json`.
- Run `npm run check` and `npm run build` before publishing changes.
- Keep `--force` in the deploy script so dashboard secret updates cannot block Workers Builds on false configuration conflicts ([cf#69](https://github.com/cloudflare/cf/issues/69), [cf#466](https://github.com/cloudflare/cf/issues/466)). Treat `cloudflare.config.ts` as the source of truth for Worker configuration.
- Keep credentials out of source and logs. Workers AI uses the AI binding.
