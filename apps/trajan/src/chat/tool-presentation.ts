import { ToolActivityIdentity } from "@trajan/harness";
import { Schema } from "effect";

export const toolPreviewBytes = 3 * 1024;
export const fileDiffBytes = 8 * 1024;
export const FileChange = Schema.Struct({
	path: Schema.NonEmptyString,
	kind: Schema.Literals(["added", "modified", "unchanged"]),
	diff: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(fileDiffBytes))),
});
const toolPreviewFields = {
	text: Schema.String.check(Schema.isMaxLength(toolPreviewBytes)),
	truncated: Schema.Boolean,
};
export const FilePreview = Schema.Struct({
	format: Schema.Literal("file"),
	path: Schema.NonEmptyString,
	...toolPreviewFields,
});
export const ToolActivityPreview = Schema.Union([
	Schema.Struct({ format: Schema.Literals(["json", "text"]), ...toolPreviewFields }),
	FilePreview,
]);
export const ToolActivity = Schema.Struct({
	...ToolActivityIdentity.fields,
	category: Schema.optionalKey(Schema.Literal("browser")),
	input: Schema.optionalKey(ToolActivityPreview),
	output: Schema.optionalKey(ToolActivityPreview),
	fileChange: Schema.optionalKey(FileChange),
});
