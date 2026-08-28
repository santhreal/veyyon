import { CODEX_BASE_URL } from "@veyyon/catalog/wire/codex";
import { trimTrailingSlashes } from "@veyyon/utils/url";

export function normalizeCodexBaseUrl(baseUrl?: string): string {
	const trimmed = baseUrl === undefined ? undefined : trimTrailingSlashes(baseUrl.trim());
	if (!trimmed) return CODEX_BASE_URL;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return CODEX_BASE_URL;
	}
	const host = parsed.host.toLowerCase();
	if (host !== "chatgpt.com" && host !== "chat.openai.com") return CODEX_BASE_URL;
	return `${parsed.origin}/backend-api`;
}
