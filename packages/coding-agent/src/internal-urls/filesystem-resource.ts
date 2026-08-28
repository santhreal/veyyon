import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { InternalResource } from "./types";

/** True when `targetPath` is `rootPath` itself or a descendant of it. This is the single owner of the internal-URL root-containment predicate, shared by the */
export function isWithinRoot(targetPath: string, rootPath: string): boolean {
	return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
}

/** Throw a scheme-specific "escapes root" error when `targetPath` is not within `rootPath`. `scheme` is the URL scheme label (e.g. "local"), producing the */
export function ensureWithinRoot(targetPath: string, rootPath: string, scheme: string): void {
	if (!isWithinRoot(targetPath, rootPath)) {
		throw new Error(`${scheme}:// URL escapes ${scheme} root`);
	}
}

/** Builds a text resource for a filesystem directory resolved by an internal URL handler. The resource is flagged immutable so the read tool never mints hashline edit */
export async function buildDirectoryResource(
	url: string,
	directoryPath: string,
	notes?: string[],
): Promise<InternalResource> {
	const entries = await fs.readdir(directoryPath, { withFileTypes: true });
	entries.sort((a, b) => {
		const directoryOrder = Number(b.isDirectory()) - Number(a.isDirectory());
		return directoryOrder || a.name.localeCompare(b.name);
	});
	const content =
		entries.length === 0
			? "(empty directory)"
			: entries.map(e => `${e.name}${e.isDirectory() ? "/" : ""}`).join("\n");
	return {
		url,
		content,
		contentType: "text/plain",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: directoryPath,
		immutable: true,
		...(notes ? { notes } : {}),
	};
}
