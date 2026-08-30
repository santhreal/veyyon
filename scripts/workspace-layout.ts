/**
 * Where the workspace members are, read from the manifests that declare them.
 *
 * WHY THIS MODULE EXISTS. Three gates need to know which directories hold workspace members:
 * `package-map-coverage.test.ts` (every member has a documentation row),
 * `workspace-test-coverage.test.ts` (every member that ships tests is run) and
 * `workspace-typecheck-coverage.test.ts` (every member is type-checked). All three answered it the
 * same way, by naming `packages/` and `crates/` literally.
 *
 * That held while those were the only two roots. Adding `contracts/` broke all three at once, in the
 * quietest way available: each gate kept passing, because each was looking somewhere the new members
 * were not. A contract could ship with no documentation row, no test run and no type check, and every
 * signal read green. The three suites exist precisely to catch a member nothing reaches, so a root
 * they cannot see is the one failure they must not have.
 *
 * The fix is to stop asserting the layout and read it. The root `package.json` `workspaces.packages`
 * and `Cargo.toml` `workspace.members` are what the package managers themselves resolve, so a root
 * added there is a root in fact. Adding `plugins/*` or `hosts/*` to either file makes all three gates
 * cover it with no edit to any of them.
 *
 * RUN COMMAND: this module is a library. Its behaviour is asserted by
 * `bun test scripts/workspace-layout.test.ts`, and it is imported by the three suites above.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Repository root, derived from this file's own location. */
export const REPO_ROOT = resolve(import.meta.dirname, "..");

/** A directory holding workspace members, and how a member there identifies itself. */
export interface WorkspaceRoot {
	/** Directory name, relative to the repository root. */
	directory: string;
	/** The file whose presence makes a subdirectory a member. */
	manifest: string;
}

/**
 * The directory each globbed entry of a manifest's member list sweeps.
 *
 * An entry is a root only if it contains a wildcard, and the root is the directory holding the
 * wildcard rather than the entry itself. That distinction is not pedantic: the Cargo workspace
 * declares `crates/veyyon-*`, a prefix glob, so a rule that only recognised `<dir>/*` found no Rust
 * root at all and every Rust member silently left the sweep.
 *
 * Two kinds of entry are deliberately not roots. A nested glob (`crates/vendor/*`) sweeps a
 * subdirectory of a root, holding vendored third-party code rather than first-party members. A
 * literal path with no wildcard (`python/veybot/web`) names one member rather than a directory of
 * them, so there is no root to sweep.
 */
export function globbedRoots(manifestText: string, listPattern: RegExp): string[] {
	const list = manifestText.match(listPattern);
	if (!list?.[1]) return [];
	const roots = new Set<string>();
	for (const entry of list[1].matchAll(/"([A-Za-z0-9._\-/*]+)"/g)) {
		const member = entry[1];
		if (member === undefined) continue;
		const wildcard = member.indexOf("*");
		if (wildcard < 0) continue;
		const separator = member.lastIndexOf("/", wildcard);
		if (separator < 0) continue;
		const directory = member.slice(0, separator);
		if (directory.includes("/")) continue;
		roots.add(directory);
	}
	return [...roots].sort();
}

/**
 * Directories holding TypeScript workspace members, from a given checkout's root `package.json`.
 *
 * A gate driven against a throwaway tree needs the roots that tree declares, not this repository's,
 * so the checkout is a parameter. A missing manifest throws rather than falling back to a literal
 * `packages/`: a fallback is how a root nothing sweeps reads green.
 */
export function typeScriptRootDirectoriesOf(repoRoot: string): string[] {
	const manifest = readFileSync(join(repoRoot, "package.json"), "utf-8");
	return globbedRoots(manifest, /"packages"\s*:\s*\[([^\]]*)\]/);
}

/** Directories holding TypeScript workspace members, from the root `package.json`. */
export function typeScriptRootDirectories(): string[] {
	return typeScriptRootDirectoriesOf(REPO_ROOT);
}

/** Directories holding Rust workspace members, from the root `Cargo.toml`. */
export function rustRootDirectories(): string[] {
	const manifest = readFileSync(join(REPO_ROOT, "Cargo.toml"), "utf-8");
	return globbedRoots(manifest, /members\s*=\s*\[([^\]]*)\]/);
}

/** Every workspace root, TypeScript first, each paired with the manifest that identifies a member. */
export function workspaceRoots(): WorkspaceRoot[] {
	return [
		...typeScriptRootDirectories().map(directory => ({ directory, manifest: "package.json" })),
		...rustRootDirectories().map(directory => ({ directory, manifest: "Cargo.toml" })),
	];
}
