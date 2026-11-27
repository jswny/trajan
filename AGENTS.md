# Trajan

Keep this file focused on durable decisions that contributors cannot infer from the code or existing documentation. Keep the README focused on what Trajan does and put implementation notes next to the code they explain.

- Name packages for the capabilities they provide. Use platform or provider qualifiers when the platform or provider is part of the package's contract.
- Extract reusable capabilities with interfaces that can be tested independently. Have platform adapters depend on the platform-neutral core. Keep product policy and composition in the deployable app.
- Use Effect for app-owned asynchronous workflows and Effect atoms for shared UI state. Compose workflows before running them at integration boundaries. Use plain functions for pure transformations.
- Give the model one tool surface through Code Mode. Expose only `exec` to the model. Route script effects through registered tools with an explicit replay policy.
- Isolate model-written scripts from the agent's request handling. Keep tool authorization, scheduling, and durable recovery in the host.
- Journal tool replies and their delivery order before releasing them to the script. During recovery, verify the runtime identity and replayed calls before admitting new effects.
- Keep tool replies focused on what the caller needs. Record structured UI details alongside the tool outcome so previews can be restored after recovery.
- Use Pi Durable as a design reference for turn execution and recovery. Keep the chat rebuildable from durable state after a reconnect.
- Check with the user before making any change that requires a migration or backward-compatibility support.
- Scope subscriptions, timers, and in-flight work to their owning session, connection, or request. Gate actions on application readiness as well as transport connectivity.
- Validate external data at app boundaries with Effect Schema. Correlate acknowledgments with their requests before settling the requests or clearing user input.
- Reuse operation IDs when retrying the same action. Mark tools replay-safe only when repeating them is harmless. Have the host persist recovery intent before an external effect. Reconcile uncertain effects through a read-only check of the affected system before retrying the action.
- Let independent tool calls overlap. Serialize calls whose effects can interfere with each other.
- Commit local tool mutations and their recovery checkpoints in the same transaction. Keep external side effects outside that transaction.
- Keep accepted work and unrecorded outcomes recoverable. Distinguish failures to wake work or record an outcome from failures of the work itself.
- Preserve consequential failures, partial results, and uncertain outcomes across recovery. Surface them in chat and in the model’s context when relevant to its next decision. State what took effect and what remains uncertain.
- Verify the failure and recovery paths of lifecycle changes. Exercise user-facing recovery in a real browser against a local Worker.
- Review per-chat authorization before widening Cloudflare Access.
- Treat checked-in Worker configuration as authoritative.
- Run the repository checks and verify the production bundle before publishing.
- Before writing or changing Effect code, read the installed `node_modules/effect/AGENTS.md` in full. Follow its links for relevant examples and consult `node_modules/effect/src` for API details the guide doesn’t cover.
- Check current Cloudflare documentation before changing Workers or Agents SDK behavior. Use `cf docs search` to find platform guidance and `cf cli search` to discover commands. For Pi lifecycle and recovery, consult the [Pi harness guide](https://developers.cloudflare.com/agents/harnesses/pi/).

## UI design

- Keep view-local state in Effect UI component models. Use scoped commands, subscriptions, and mounts for browser effects. Give third-party DOM renderers dedicated hosts and release their resources when those hosts unmount.
- Consult the installed `node_modules/@effect/ui/AGENTS.md` before changing Effect UI components or lifecycle code.
- Keep the conversation primary. Use compact controls and let users reveal supporting details on demand.
- Surface transient progress in the live UI. Keep conversation history focused on messages and outcomes worth revisiting.
- Reuse shared visual tokens for color, shape, and spacing. Give elements with the same role a consistent treatment across states, and keep nested surfaces visually secondary.
- Inspect the rendered change in the local app in a real browser at desktop and iPhone 17 Pro sizes. Use representative content and exercise the affected states. Check safe areas and on-screen keyboard behavior when the change affects layout or text input.
