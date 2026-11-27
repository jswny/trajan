import type { ChatPreview, ChatToolPreview } from "./protocol";

export function updateToolPreview(
	preview: typeof ChatPreview.Type,
	tool: typeof ChatToolPreview.Type,
): typeof ChatPreview.Type {
	const existing = preview.tools.find(({ call }) => call.id === tool.call.id);
	if (!existing) {
		return { ...preview, text: "", tools: [...preview.tools, tool] };
	}
	if (
		!tool.result &&
		(existing.result || (tool.activity.length === 0 && existing.activity.length > 0))
	) {
		return preview;
	}
	return { ...preview, tools: preview.tools.map((entry) => (entry === existing ? tool : entry)) };
}
