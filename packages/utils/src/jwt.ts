import { tryParseJson } from "./json";

export function decodeJwtPayload<T = Record<string, unknown>>(token: string): T | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const payload = parts[1];
	if (!payload) return null;
	const decoded = Buffer.from(payload, "base64url").toString("utf8");
	return tryParseJson<T>(decoded);
}
