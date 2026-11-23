# Trajan

Keep this file focused on durable decisions that contributors cannot infer from the code or existing documentation. Keep the README focused on what Trajan does and put implementation notes next to the code they explain.

- Use Effect for app-owned asynchronous workflows and Effect atoms for shared UI state. Compose workflows before running them at integration boundaries. Use plain functions for pure transformations and let the renderer schedule DOM work.
- Preserve Pi's ownership of durable execution and recovery. Keep the app's chat view rebuildable from Pi's persisted state after a reconnect.
- Check with the user before making any change that requires a migration or backward-compatibility support.
- Scope subscriptions, timers, and in-flight work to their owning session, connection, or request. Gate actions on application readiness as well as transport connectivity.
- Validate external data at app boundaries with Effect Schema. Correlate acknowledgments with their requests before settling the requests or clearing user input.
- Reuse operation IDs when retrying the same action. Mark tools replay-safe only when repeating them is harmless.
- Verify the failure and recovery paths of lifecycle changes. Exercise user-facing recovery in a real browser against a local Worker.
- Verify UI changes in a real browser using the iPhone 17 Pro as the reference viewport. Check safe areas and on-screen keyboard behavior when the change affects layout or text input.
- Review per-chat authorization before widening Cloudflare Access.
- Treat checked-in Worker configuration as authoritative.
- Run the repository checks and verify the production bundle before publishing.
- Check current Cloudflare documentation before changing Workers or Agents SDK behavior. Use `cf docs search` to find platform guidance and `cf cli search` to discover commands. For Pi lifecycle and recovery, consult the [Pi harness guide](https://developers.cloudflare.com/agents/harnesses/pi/).
