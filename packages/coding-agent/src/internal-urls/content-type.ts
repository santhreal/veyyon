import * as path from "node:path";
import type { InternalResource } from "./types";

/** Map a file path's extension to the {@link InternalResource.contentType} used by internal:// resource resolution. */
export function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") return "text/markdown";
	if (ext === ".json") return "application/json";
	return "text/plain";
}
