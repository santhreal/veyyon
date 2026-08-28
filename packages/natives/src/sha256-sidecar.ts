export function parseSha256Sidecar(text: string): string | null {
	const token = text.trim().split(/\s+/)[0] ?? "";
	return /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : null;
}
