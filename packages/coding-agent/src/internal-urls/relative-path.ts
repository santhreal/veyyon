/**
 * Path-safety check shared by every internal URL scheme that takes a relative path.
 *
 * A leaf on purpose: `node:path` is the only thing it imports. It used to live in
 * `skill-protocol.ts`, which imports `extensibility/skills` and through it 375 more modules, so
 * `local-protocol`, `memory-protocol`, `vault-protocol` and `tools/bash-skill-urls` were each
 * pulling the whole skill subsystem in to call one nine-line function. Keep it dependency-free:
 * this is the check that stands between a URL and the filesystem, and it should be reachable from
 * anywhere without cost.
 */
import * as path from "node:path";

/**
 * Reject absolute paths and traversal in the path portion of an internal URL.
 *
 * @param relativePath - The already-decoded path portion of the URL.
 * @param scheme - The scheme to name in the error, without `://`. The message used to say
 *   `skill://` whatever the caller was, because the function lived in the skill handler, so a
 *   rejected `vault://` URL told you about a scheme you had not used.
 * @throws If the path is absolute or escapes its root.
 */
export function validateRelativePath(relativePath: string, scheme = "skill"): void {
	if (path.isAbsolute(relativePath)) {
		throw new Error(`Absolute paths are not allowed in ${scheme}:// URLs`);
	}

	const normalized = path.normalize(relativePath);
	if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
		throw new Error(`Path traversal (..) is not allowed in ${scheme}:// URLs`);
	}
}
