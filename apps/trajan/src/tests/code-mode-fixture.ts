import type { Workspace } from "@cloudflare/computer";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { CodeModeError, createCodeMode } from "@trajan/code-mode";
import type { CodeModeTool } from "@trajan/code-mode";
import { Effect, Schema } from "effect";
import { browserToolset } from "../browser";

const dir = "/workspace";
const path = `${dir}/code-mode.txt`;
const branch = "code-mode-proof";
type Point =
	| "code-mode-read"
	| "code-mode-edit"
	| "code-mode-branch"
	| "code-mode-browser"
	| "code-mode-settle";
const label = Schema.Struct({ label: Schema.String });
const oldText = Schema.Struct({ oldText: Schema.String, newText: Schema.String });
const toError = (cause: unknown) =>
	new CodeModeError({ message: cause instanceof Error ? cause.message : String(cause) });
const io = <A>(operation: () => Promise<A>) =>
	Effect.tryPromise({ try: operation, catch: toError });

export function createCodeModeFixture(
	workspace: Workspace,
	storage: DurableObjectStorage,
	loader: WorkerLoader,
	pause: (point: Point, signal: AbortSignal) => Promise<void>,
) {
	const files = createPiTools({ workspace, root: dir, exec: { backends: {} } });
	const receipt = (name: string, callId: string) =>
		Effect.sync(() => {
			const calls = storage.kv.get<Array<string>>(`code-mode-test:${name}`) ?? [];
			storage.kv.put(`code-mode-test:${name}`, [...calls, callId]);
		});
	const fileTool = Effect.fnUntraced(function* (
		id: string,
		name: "read" | "edit",
		args: Schema.Json,
		signal: AbortSignal,
	) {
		const result = yield* io(() => {
			signal.throwIfAborted();
			return files.execute({ id, name, arguments: args });
		});
		const text = result.content
			.flatMap((item) => (item.type === "text" ? [item.text] : []))
			.join("\n");
		if (result.isError) {
			return yield* new CodeModeError({ message: text });
		}
		return text;
	});
	const browser = browserToolset({
		session: () => ({
			lock: () => Promise.resolve(),
			close: () =>
				Promise.resolve({
					restarted: storage.kv.get<boolean>("fixture-browser-closed") ?? false,
					newTabs: [],
					tabClosed: false,
					tabShared: false,
					notices: [],
				}),
			send: ({ method, params }) => {
				if (method === "Page.navigate" && typeof params?.url === "string") {
					storage.kv.put("fixture-browser-url", params.url);
					storage.kv.delete("fixture-browser-closed");
					return Promise.resolve({});
				}
				if (method === "Runtime.evaluate") {
					const url = storage.kv.get<string>("fixture-browser-url") ?? "about:blank";
					return Promise.resolve({
						result: { value: { url, title: "Fixture", text: "Page", links: [] } },
					});
				}
				if (method === "Page.getLayoutMetrics") {
					return Promise.resolve({
						cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 640, clientHeight: 480 },
					});
				}
				if (method === "Page.captureScreenshot") {
					const data = storage.kv.delete("fixture-browser-oversized") ? "x".repeat(55_004) : "/9j/";
					return Promise.resolve({ data });
				}
				return Promise.reject(new Error(`Unexpected fixture browser method: ${method}`));
			},
		}),
		close: () => {
			storage.kv.put("fixture-browser-closed", true);
			return Promise.resolve(storage.kv.delete("fixture-browser-url"));
		},
	}).tools;

	const tools = {
		"codemode:tools": {
			...browser,
			settle: {
				replay: "unsafe",
				run: (_input, { callId }) =>
					io(() => pause("code-mode-settle", new AbortController().signal)).pipe(
						Effect.andThen(receipt("settle", callId)),
						Effect.as(null),
					),
			},
			browserNavigate: {
				...browser.browserNavigate,
				run: (input, context) =>
					receipt("browserNavigate", context.callId).pipe(
						Effect.andThen(browser.browserNavigate.run(input, context)),
						Effect.tap(() => Effect.sync(() => storage.kv.put("fixture-browser-oversized", true))),
						Effect.tap(() => io(() => pause("code-mode-browser", context.signal))),
					),
			},
			browserRead: {
				...browser.browserRead,
				run: (input, context) =>
					receipt("browserRead", context.callId).pipe(
						Effect.andThen(browser.browserRead.run(input, context)),
					),
			},
			read: {
				replay: "safe",
				run: Effect.fnUntraced(function* (input, { callId, signal }) {
					const args = yield* Schema.decodeUnknownEffect(label)(input).pipe(
						Effect.mapError(toError),
					);
					yield* receipt(args.label, callId);
					if (args.label === "retry") {
						yield* io(() => pause("code-mode-read", signal));
					}
					return yield* fileTool(callId, "read", { path }, signal);
				}),
			},
			edit: {
				replay: "unsafe",
				run: Effect.fnUntraced(function* (input, { callId, signal }) {
					const edits = yield* Schema.decodeUnknownEffect(oldText)(input).pipe(
						Effect.mapError(toError),
					);
					yield* receipt("edit", callId);
					const result = yield* fileTool(callId, "edit", { path, edits: [edits] }, signal);
					yield* io(() => pause("code-mode-edit", signal));
					return result;
				}),
			},
		},
		"codemode:git": {
			branch: {
				replay: "unsafe",
				run: Effect.fnUntraced(function* (_input, { callId, signal }) {
					yield* receipt("branch", callId);
					yield* io(() => workspace.git.branch({ dir, name: branch }));
					yield* io(() => pause("code-mode-branch", signal));
					return null;
				}),
			},
			branches: {
				replay: "safe",
				run: () => io(() => workspace.git.branchList({ dir })),
			},
		},
	} satisfies Record<string, Record<string, CodeModeTool>>;

	return {
		run: createCodeMode(loader, storage, tools).run,
		async seed() {
			await workspace.fs.mkdir(dir, { recursive: true });
			await workspace.fs.writeFile(path, "seed");
			await workspace.git.init({ dir });
			await workspace.git.add({ dir, paths: ["code-mode.txt"] });
			await workspace.git.commit({
				dir,
				message: "Seed Code Mode fixture",
				author: { name: "Trajan fixture", email: "fixture@example.invalid" },
			});
		},
		state() {
			const prefix = "code-mode-test:";
			const receipts = Object.fromEntries(
				Array.from(storage.kv.list<Array<string>>({ prefix }), ([key, value]) => [
					key.slice(prefix.length),
					value,
				]),
			);
			return { receipts, pausedAt: storage.kv.get<string>("pausedAt") };
		},
	};
}
