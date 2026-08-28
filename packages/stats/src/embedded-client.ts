export function decodeEmbeddedClientArchive(txt: string): Buffer | null {
	const normalized = txt.replaceAll(/\s+/g, "");
	if (!normalized) return null;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
	const archiveBytes = Buffer.from(normalized, "base64");
	if (archiveBytes[0] !== 0x1f || archiveBytes[1] !== 0x8b) return null;
	return archiveBytes;
}
