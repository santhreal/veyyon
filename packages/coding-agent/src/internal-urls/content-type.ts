import * as path from "node:path";
import type { InternalResource } from "./types";

/**
 * Map a file path's extension to the {@link InternalResource.contentType} used
 * by internal:// resource resolution.
 *
 * This is the single owner of the extension → content-type mapping for every
 * protocol that serves files (skill://, local://, vault://, and any new one).
 * Import it rather than re-deriving the mapping inline so the three content
 * types stay defined in exactly one place and cannot drift apart.
 */
export function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") return "text/markdown";
	if (ext === ".json") return "application/json";
	return "text/plain";
}
