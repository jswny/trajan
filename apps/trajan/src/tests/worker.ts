export { ChatTestObject } from "./chat-runtime-fixture";
import { isChatPath } from "../chat/protocol";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/__browser-smoke/ready") {
			return new Response("Trajan browser fixture");
		}
		const origin = request.headers.get("Origin");
		if (origin !== null && origin !== url.origin) {
			return new Response(null, { status: 403 });
		}
		const fixture = /(?:^|;\s*)trajan-fixture=([a-f0-9-]+)(?:;|$)/.exec(
			request.headers.get("Cookie") ?? "",
		)?.[1];
		const stub = env.CHAT_TEST.getByName(fixture ?? "test-chat");
		if (isChatPath(url.pathname)) {
			return stub.fetch(request);
		}
		const action =
			/^\/__browser-smoke\/chat\/(pause|pause-between-tools|pause-replay|pause-replay-edit|pause-replay-git|pause-remote-push|fail-inbox-wake|fail-transcript-write|restore-transcript-write|miss-schedule|defer-missed-schedule|retry-inbox-wake|retry-missed-schedule|release|crash|state|task-state)$/.exec(
				url.pathname,
			)?.[1];
		if (action && fixture && request.method === "POST") {
			switch (action) {
				case "pause":
					await stub.pause("during-reply");
					return new Response(null, { status: 204 });
				case "pause-between-tools":
					await stub.pause("between-tools");
					return new Response(null, { status: 204 });
				case "pause-replay":
					await stub.pause("during-replay-read");
					return new Response(null, { status: 204 });
				case "pause-replay-edit":
					await stub.pause("during-replay-edit");
					return new Response(null, { status: 204 });
				case "pause-replay-git":
					await stub.pause("during-replay-git");
					return new Response(null, { status: 204 });
				case "pause-remote-push":
					await stub.pause("during-remote-push");
					return new Response(null, { status: 204 });
				case "fail-inbox-wake":
					await stub.failInboxWake(3);
					return new Response(null, { status: 204 });
				case "fail-transcript-write":
				case "restore-transcript-write":
					await stub.setTranscriptWriteFailure(action === "fail-transcript-write");
					return new Response(null, { status: 204 });
				case "miss-schedule":
					await stub.setScheduledFailure("before-admission");
					return new Response(null, { status: 204 });
				case "defer-missed-schedule":
					await stub.setScheduledFailure("before-admission");
					await stub.failMissedScheduleReports(1);
					return new Response(null, { status: 204 });
				case "retry-inbox-wake":
				case "retry-missed-schedule": {
					const retry = action === "retry-inbox-wake" ? "inbox-wake" : "missed-schedule";
					return new Response(null, { status: (await stub.makeRetryDue(retry)) ? 204 : 409 });
				}
				case "release":
					await stub.release();
					return new Response(null, { status: 204 });
				case "crash":
					await stub.crash();
					return new Response(null, { status: 204 });
				case "state":
					return Response.json(await stub.state());
				case "task-state": {
					const runId = url.searchParams.get("runId");
					return runId
						? new Response(await stub.taskState(runId))
						: new Response(null, { status: 400 });
				}
			}
		}
		return new Response(null, { status: 404 });
	},
};
