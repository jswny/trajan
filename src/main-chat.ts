export const MAIN_CHAT_NAME = "main";
export const MAIN_CHAT_PATH = `/agents/trajan/${MAIN_CHAT_NAME}`;

export function isMainChatUrl(url: URL): boolean {
	return url.pathname === MAIN_CHAT_PATH && !url.searchParams.has("session");
}
