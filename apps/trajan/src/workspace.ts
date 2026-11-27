import { codeModeError, defineTool } from "@trajan/code-mode";
import type { CodeModeError } from "@trajan/code-mode";
import { createCloudflareWorkspace, createWorkspaceTools } from "@trajan/workspace-cloudflare";
import {
	DEFAULT_WORKSPACE_SKILLS_ROOT,
	loadSkillCatalog,
	renderSkillResource,
	workspace as skillSource,
} from "agents/skills";
import type { SkillCatalog } from "agents/skills";
import { Effect, Schema } from "effect";
import { filePreview } from "./chat/tool-activity";
import { fileDiffBytes, FilePreview } from "./chat/tool-presentation";

export const WORKSPACE_PROMPT =
	"You are Trajan, a concise and capable assistant. You have a durable workspace at /workspace. Use exec to compose tools when they can answer the request, and explain their results plainly.";

const root = "/workspace";

export function createTrajanWorkspace(ctx: DurableObjectState) {
	return createCloudflareWorkspace(ctx, root);
}

const SkillName = Schema.Struct({ name: Schema.NonEmptyString });
const SkillResourceRequest = Schema.Struct({ ...SkillName.fields, path: Schema.NonEmptyString });

function workspaceSkills(workspace: ReturnType<typeof createTrajanWorkspace>) {
	function operation<A, B extends Schema.Json>(
		input: Schema.Codec<A>,
		output: Schema.Codec<B>,
		read: (
			catalog: SkillCatalog,
			input: A,
			recordDetails: (detail: typeof FilePreview.Type) => void,
		) => Effect.Effect<B, CodeModeError>,
	) {
		return defineTool({
			replay: "safe",
			input,
			output,
			details: FilePreview,
			run: Effect.fnUntraced(function* (args, { signal, recordDetails }) {
				const catalog = yield* Effect.tryPromise({
					try: () => {
						signal.throwIfAborted();
						return loadSkillCatalog([skillSource(workspace)]);
					},
					catch: codeModeError,
				});
				const failure = catalog.diagnostics.find(
					(diagnostic) => diagnostic._tag === "SourceFailed",
				);
				if (failure) {
					return yield* codeModeError(failure.error);
				}
				return yield* read(catalog, args, recordDetails);
			}),
		});
	}

	return {
		listSkills: operation(
			Schema.NullOr(Schema.Struct({})),
			Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
			(catalog) =>
				Effect.succeed(
					catalog.skills.map(({ skill: { name, description } }) => ({ name, description })),
				),
		),
		activateSkill: operation(SkillName, Schema.String, (catalog, { name }) => {
			const activated = catalog.activate(name);
			return activated.ok
				? Effect.succeed(activated.value)
				: Effect.fail(codeModeError(activated.error));
		}),
		readSkillResource: operation(
			SkillResourceRequest,
			Schema.String,
			(catalog, input, recordDetails) =>
				Effect.gen(function* () {
					const read = yield* Effect.tryPromise({
						try: () => catalog.readResource(input),
						catch: codeModeError,
					});
					if (!read.ok) {
						return yield* codeModeError(read.error);
					}
					const { resource } = read.value;
					if (resource.encoding === "text") {
						recordDetails(filePreview(resource.path, resource.content));
					}
					return renderSkillResource(read.value);
				}),
		),
	};
}

export function workspaceToolset(workspace: ReturnType<typeof createTrajanWorkspace>) {
	const { files, git } = createWorkspaceTools(workspace, {
		root,
		maxDiffBytes: fileDiffBytes,
		describeRead: ({ path, content, truncated }) => filePreview(path, content, truncated),
	});
	const tools = Object.assign(files, workspaceSkills(workspace));
	const instructions = [
		"Import named file tools from codemode:tools. Each takes an object and returns { text, isError, details? }. Check isError before using its result.",
		"Successful write and edit calls both return details: { path, bytesWritten }.",
		"Skills are named exports from codemode:tools. Use listSkills() to find a relevant workflow, activateSkill({ name }) to load its instructions and file list, and readSkillResource({ name, path }) to read a bundled file by its skill-relative path.",
		`Use the workspace file tools to create or update skills under ${DEFAULT_WORKSPACE_SKILLS_ROOT}/<name>/SKILL.md. Start the file with YAML frontmatter containing name (matching the folder) and description. Skill tools discover saved changes on the next call.`,
		"Import named Git tools from codemode:git. The directory defaults to /workspace.",
	].join("\n");
	return {
		instructions,
		catalog: {
			"codemode:tools": tools,
			"codemode:git": git,
		},
	};
}
