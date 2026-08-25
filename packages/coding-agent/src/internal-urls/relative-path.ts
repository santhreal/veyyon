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

/** `C:` or `c:` at the head of a path. Not `path.isAbsolute` on POSIX, but never a relative leaf. */
const WINDOWS_DRIVE_PREFIX = /^[a-z]:/i;

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
	if (path.isAbsolute(relativePath) || WINDOWS_DRIVE_PREFIX.test(relativePath)) {
		throw new Error(`Absolute paths are not allowed in ${scheme}:// URLs`);
	}

	const traversal = new Error(`Path traversal (..) is not allowed in ${scheme}:// URLs`);

	// A URL path separates with `/`. A backslash arrives from a Windows-authored URL and reads
	// two ways: one filename on POSIX, three components with a parent hop on Windows. Rather
	// than pick a platform, refuse a `..` component in the backslash reading. `foo\bar`, which
	// carries no hop, still resolves as an ordinary name.
	if (relativePath.includes("\\")) {
		const segments = relativePath.split(/[\\/]/);
		if (segments.includes("..")) throw traversal;
	}

	// Only a normalized path that still leaves the root is an escape. `foo/../bar` collapses to
	// `bar` and stays inside it; `..foo`, `foo/..bar` and `foo/.../bar` are filenames that begin
	// with dots, not parent hops, and node:path does not rewrite them.
	const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
	if (normalized === ".." || normalized.startsWith("../")) {
		throw traversal;
	}
}
