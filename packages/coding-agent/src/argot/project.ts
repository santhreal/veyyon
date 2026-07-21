// Vendored from the standalone `argot` SDK. See ./constants.ts for the sync note.
/**
 * Locating a project and naming its cache.
 *
 * The cache flow keeps a generated dictionary outside the repository, in a state
 * directory the harness owns, keyed by a stable id for the project it belongs
 * to. Two questions have to be answered before a cache can be read or written:
 * where does this project start, and what is its cache called. This module
 * answers both as pure, injectable functions so a harness can test them without
 * a real filesystem.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Markers that identify a project root, checked in each ancestor directory. A
 * `.git` directory is the usual signal. `.argot` is an explicit opt-in a user
 * drops into a project that has no git, or into a subtree they want treated as
 * its own root. Override this to change what counts as a project.
 */
export const PROJECT_MARKERS: readonly string[] = [".git", ".argot"];

/** Options for {@link resolveProjectRoot}. */
export interface ResolveProjectOptions {
	/** Marker names to look for in each ancestor. Default {@link PROJECT_MARKERS}. */
	markers?: readonly string[];
	/**
	 * Existence test for a path, injectable for testing. Default {@link existsSync}.
	 * A marker counts whether it is a file or a directory.
	 */
	exists?: (path: string) => boolean;
}

/**
 * Walk up from `startDir` and return the first ancestor that contains any
 * marker, or `undefined` if the filesystem root is reached without one. The
 * returned path is absolute. `startDir` itself is checked first, so a marker in
 * the starting directory resolves to that directory.
 *
 * This never throws for a missing directory: an absent marker is simply not
 * found, and the walk continues upward until the root.
 */
export function resolveProjectRoot(startDir: string, options: ResolveProjectOptions = {}): string | undefined {
	const markers = options.markers ?? PROJECT_MARKERS;
	const exists = options.exists ?? existsSync;

	let dir = resolve(startDir);
	// dirname of the filesystem root is the root itself; that fixpoint ends the walk.
	while (true) {
		for (const marker of markers) {
			if (exists(join(dir, marker))) {
				return dir;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

/**
 * A stable identifier for a project, derived from its absolute root path alone.
 *
 * The cache is per-machine and local, so the path is all the identity it needs:
 * no git, no network, no reading the tree. The same root always yields the same
 * id, and two different roots yield different ids (a SHA-256 collision aside),
 * so concurrent agents on one project share one cache directory while separate
 * projects never overlap. The id is a lowercase hex string safe to use as a
 * directory name.
 *
 * The path is resolved to an absolute, normalized form first, so equivalent
 * spellings of the same root (a trailing slash, a `.` segment) map to one id.
 */
export function projectCacheId(rootPath: string): string {
	const normalized = resolve(rootPath);
	return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}
