/**
 * Where the workspace members are, read from the manifests that declare them.
 *
 * WHY THIS MODULE EXISTS. Several gates need to know where the workspace members are:
 * `package-map-coverage.test.ts` (every member has a documentation row),
 * `workspace-test-coverage.test.ts` (every member that ships tests is run),
 * `workspace-typecheck-coverage.test.ts` (every member is type-checked), and about twenty source
 * sweeps. All of them answered it the same way, by naming `packages/` and `crates/` literally.
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
 * WHICH VIEW TO TAKE. `typeScriptMembers()` is the answer for a source sweep, a coverage gate and a
 * release pass alike: it reaches a member at any depth and a member declared as a literal path.
 * `typeScriptMemberTopLevels()` is for a sweep that reports coverage one tree at a time.
 * `typeScriptRootDirectories()` answers a narrower question — which directories a member GLOB sweeps
 * — and is therefore blind to a literal member by construction; it survives only where the question
 * really is about the glob, such as asserting the manifest's own shape. See `WorkspaceMember` for why
 * the root view cannot reach every member, and why the Rust side has no root view at all.
 *
 * RUN COMMAND: this module is a library. Its behaviour is asserted by
 * `bun test scripts/workspace-layout.test.ts`, and it is imported by the three suites above.
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Repository root, derived from this file's own location. */
export const REPO_ROOT = resolve(import.meta.dirname, "..");

/**
 * The directory each globbed entry of a manifest's member list sweeps.
 *
 * An entry is a root only if it contains a wildcard, and the root is the directory holding the
 * wildcard rather than the entry itself. That distinction is not pedantic: the Cargo workspace used
 * to declare `crates/veyyon-*`, a prefix glob, so a rule that only recognised `<dir>/*` found no Rust
 * root at all and every Rust member silently left the sweep.
 *
 * Two kinds of entry are deliberately not roots, which is why this view is TypeScript-only. A nested
 * entry (`natives/search/*`) sweeps a directory that is itself inside another, and a literal path
 * with no wildcard (`clients/python/veybot/web`) names one member rather than a directory of them, so there
 * is no root to sweep. The Rust member list is now entirely of those two shapes.
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

/**
 * One workspace member: where it is, and which manifest declared it.
 *
 * WHY MEMBERS EXIST BESIDE ROOTS. A root answers "which directories hold members", which is the
 * question a source sweep asks: it walks every `.ts` file under `packages/` and `contracts/` and does
 * not care where one member ends and the next begins. It is the wrong question for a gate that must
 * reach every member exactly once, and it stopped being answerable at all when the Rust tree moved to
 * `natives/`, grouped by purpose: `natives/search/glob` sits two levels down, and `natives/shell` and
 * `tests/conformance` are declared as literal paths rather than globs, so they are not under a root in
 * any sense a sweep could find. A root list would have returned the group directories and missed the
 * two literals entirely, which is the same silent narrowing `globbedRoots` was written to end.
 *
 * So the member list is resolved instead of inferred: each entry of a manifest's member list is
 * expanded against the filesystem, and what comes back is the set the package manager itself builds.
 */
export interface WorkspaceMember {
	/** Path from the repository root to the member directory, at whatever depth it sits. */
	directory: string;
	/** The manifest that declares it, and the file that marks the directory as a member. */
	manifest: string;
}

/**
 * Every directory one member-list entry resolves to.
 *
 * A literal entry resolves to itself when it holds the manifest. A wildcard entry resolves against
 * the directory holding it, matching the prefix and suffix around the `*`, which is what makes both
 * `packages/*` and the older `crates/veyyon-*` prefix form resolve. An entry whose wildcard is not in
 * the last segment, or which uses `**`, throws rather than resolving to nothing: a member list this
 * reader cannot resolve must fail loudly, because resolving to nothing is indistinguishable from a
 * workspace with no members and every gate built on it passes about less.
 *
 * A wildcard whose parent directory does not exist is a different case and resolves to nothing, which
 * is what the package manager does with it too. A manifest may name a tree a checkout does not carry
 * -- a fixture repository declaring the same member list as this one, a sparse clone -- and a throw
 * there would report a missing directory as a broken member list. What it cannot hide is a wholesale
 * empty answer: every sweep built on this asserts it found members before it asserts it found no
 * offenders.
 */
export function expandMemberPattern(pattern: string, repoRoot: string, manifest: string): string[] {
	const separator = pattern.lastIndexOf("/");
	const parent = separator < 0 ? "" : pattern.slice(0, separator);
	const segment = separator < 0 ? pattern : pattern.slice(separator + 1);
	if (parent.includes("*")) {
		throw new Error(`workspace member "${pattern}" globs above its last segment, which this reader does not resolve`);
	}
	const wildcards = segment.split("*").length - 1;
	if (wildcards > 1) {
		throw new Error(`workspace member "${pattern}" holds more than one wildcard, which this reader does not resolve`);
	}
	const holdsManifest = (directory: string): boolean => existsSync(join(repoRoot, directory, manifest));
	if (wildcards === 0) return holdsManifest(pattern) ? [pattern] : [];
	const star = segment.indexOf("*");
	const prefix = segment.slice(0, star);
	const suffix = segment.slice(star + 1);
	const resolved: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(join(repoRoot, parent), { withFileTypes: true });
	} catch {
		return resolved;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (!entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) continue;
		if (entry.name.length < prefix.length + suffix.length) continue;
		const directory = parent === "" ? entry.name : `${parent}/${entry.name}`;
		if (!holdsManifest(directory)) continue;
		resolved.push(directory);
	}
	return resolved;
}

/**
 * Every member directory a manifest's member list resolves to, sorted.
 *
 * `excluded` carries Cargo's `exclude` list, which names paths that match a member glob and are
 * nonetheless not members: the two vendored crates this workspace patches in rather than builds.
 */
export function memberDirectories(
	manifestText: string,
	listPattern: RegExp,
	repoRoot: string,
	manifest: string,
	excluded: ReadonlySet<string> = new Set(),
): string[] {
	const list = manifestText.match(listPattern);
	if (!list?.[1]) return [];
	const members = new Set<string>();
	for (const entry of list[1].matchAll(/"([A-Za-z0-9._\-/*]+)"/g)) {
		const pattern = entry[1];
		if (pattern === undefined) continue;
		for (const directory of expandMemberPattern(pattern, repoRoot, manifest)) {
			if (excluded.has(directory)) continue;
			members.add(directory);
		}
	}
	return [...members].sort();
}

/** The quoted paths of a manifest's list, unexpanded. */
function listedPaths(manifestText: string, listPattern: RegExp): Set<string> {
	const list = manifestText.match(listPattern);
	if (!list?.[1]) return new Set();
	const paths = new Set<string>();
	for (const entry of list[1].matchAll(/"([A-Za-z0-9._\-/*]+)"/g)) if (entry[1]) paths.add(entry[1]);
	return paths;
}

/** TypeScript workspace members, from a given checkout's root `package.json`. */
export function typeScriptMembersOf(repoRoot: string): string[] {
	const manifest = readFileSync(join(repoRoot, "package.json"), "utf-8");
	return memberDirectories(manifest, /"packages"\s*:\s*\[([^\]]*)\]/, repoRoot, "package.json");
}

/** TypeScript workspace members, from the root `package.json`. */
export function typeScriptMembers(): string[] {
	return typeScriptMembersOf(REPO_ROOT);
}

/** Paths the root `Cargo.toml` excludes: directories that hold a manifest and are not members. */
export function rustExcluded(): Set<string> {
	const manifest = readFileSync(join(REPO_ROOT, "Cargo.toml"), "utf-8");
	return listedPaths(manifest, /exclude\s*=\s*\[([^\]]*)\]/);
}

/** Rust workspace members, from the root `Cargo.toml`, honouring its `exclude` list. */
export function rustMembers(): string[] {
	const manifest = readFileSync(join(REPO_ROOT, "Cargo.toml"), "utf-8");
	return memberDirectories(manifest, /members\s*=\s*\[([^\]]*)\]/, REPO_ROOT, "Cargo.toml", rustExcluded());
}

/** Every workspace member, TypeScript first, each paired with the manifest that declares it. */
export function workspaceMembers(): WorkspaceMember[] {
	return [
		...typeScriptMembers().map(directory => ({ directory, manifest: "package.json" })),
		...rustMembers().map(directory => ({ directory, manifest: "Cargo.toml" })),
	];
}

/**
 * The top-level directories that hold workspace members, derived from the member list.
 *
 * WHY THIS IS NOT A NAMED LIST. A sweep over source files — the release sentinel rewrite, an
 * undeclared-manifest scan — needs one directory per tree to walk, not one per member, because a
 * file it must reach may sit beside a member rather than inside one. A hardcoded `["packages",
 * "natives"]` is the hole this replaces: it passes unchanged the day a member lands under a new
 * top-level directory, and everything in that tree is then swept by nothing.
 */
export function memberTopLevels(): string[] {
	return [...new Set(workspaceMembers().map(member => member.directory.split("/")[0] ?? ""))].sort();
}

/**
 * The top-level directories that hold TypeScript members, derived from the TypeScript member list.
 *
 * WHAT THIS IS FOR. A source sweep that reports its own coverage by root — "the walk reached every
 * tree the workspace declares, so a rule reporting nothing is reporting about everything" — needs the
 * trees, not the members. It used to ask `typeScriptRootDirectories()`, which answers with the
 * directories a GLOB sweeps and therefore cannot see a member declared as a literal path:
 * `clients/python/veybot/web` and `natives/bridge/bindings` are both invisible to it, and a sweep that never
 * opened them reported no violation there and read green. This answers from the resolved member list,
 * so a member at any depth puts its tree on the list.
 */
export function typeScriptMemberTopLevels(): string[] {
	return [...new Set(typeScriptMembers().map(member => member.split("/")[0] ?? ""))].sort();
}

/**
 * Returns whether a path is inside a third-party or vendored directory.
 */
export function isVendored(path: string): boolean {
	return path.split("/").includes("vendor");
}

/**
 * Returns whether a relative file path is a test file or within a test directory.
 */
export function isTestPath(file: string): boolean {
	return (
		file.endsWith(".test.ts") ||
		file.endsWith(".test.tsx") ||
		file.includes(".test.") ||
		file.includes("/test/") ||
		file.includes("/tests/") ||
		file.includes("/__tests__/") ||
		file.includes("/fixtures/") ||
		file.includes("/oracles/")
	);
}

/**
 * Filters relative paths to only those that currently exist on disk.
 */
export function existingOnly(rootDir: string, relativePaths: readonly string[]): string[] {
	return relativePaths.filter(rel => existsSync(join(rootDir, rel)));
}

/**
 * Reads a file as string if it exists; returns undefined on ENOENT.
 */
export function readIfPresent(absPath: string): string | undefined {
	try {
		return readFileSync(absPath, "utf8");
	} catch (error: unknown) {
		if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

/**
 * Checks whether a directory is a workspace package directory by verifying package.json existence.
 */
export function isPackageDir(dir: string, repoRoot: string = REPO_ROOT): boolean {
	return existsSync(join(repoRoot, dir, "package.json"));
}

/**
 * Reads and parses the package.json manifest of a member directory.
 */
export function readPackageJson(dir: string, repoRoot: string = REPO_ROOT): Record<string, unknown> | null {
	const manifestPath = join(repoRoot, dir, "package.json");
	try {
		return JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Recursively walks a directory, collecting paths matching a filter predicate.
 */
export function walkDirectory(
	dir: string,
	predicate?: (path: string) => boolean,
	skipDirs: readonly string[] = ["node_modules", "dist", "target", "repo-cache", "runs", "assets", "vendor", "build"],
): string[] {
	const found: string[] = [];
	const skipped = new Set(skipDirs);
	const walk = (d: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(d, entry.name);
			if (entry.isDirectory()) {
				if (!skipped.has(entry.name)) walk(full);
				continue;
			}
			if (!predicate || predicate(full)) {
				found.push(full);
			}
		}
	};
	walk(dir);
	return found.sort();
}

/**
 * Collects all shipped TypeScript source files across workspace members.
 */
export function collectSourceFiles(
	members: readonly string[] = typeScriptMembers(),
	repoRoot: string = REPO_ROOT,
): string[] {
	const found: string[] = [];
	for (const member of members) {
		const src = join(repoRoot, member, "src");
		if (existsSync(src)) {
			found.push(
				...walkDirectory(
					src,
					p =>
						(p.endsWith(".ts") || p.endsWith(".tsx")) &&
						!p.endsWith(".test.ts") &&
						!p.endsWith(".test.tsx") &&
						!p.endsWith(".d.ts"),
				),
			);
		}
	}
	return found;
}

export interface WorkspacePackage {
	readonly dir: string;
	readonly name: string;
	readonly scripts: Record<string, string>;
	readonly manifest: Record<string, unknown>;
}

export function workspacePackages(repoRoot: string = REPO_ROOT): WorkspacePackage[] {
	const out: WorkspacePackage[] = [];
	for (const member of typeScriptMembersOf(repoRoot)) {
		const parsed = readPackageJson(member, repoRoot);
		if (!parsed) continue;
		const name = typeof parsed.name === "string" ? parsed.name : member;
		const rawScripts = parsed.scripts;
		const scripts: Record<string, string> = {};
		if (rawScripts && typeof rawScripts === "object") {
			for (const [k, v] of Object.entries(rawScripts)) {
				if (typeof v === "string") {
					scripts[k] = v;
				}
			}
		}
		out.push({ dir: member, name, scripts, manifest: parsed });
	}
	return out;
}

/**
 * Map from declared package name to member directory path, read fresh from disk on each invocation.
 */
export function packageDirectories(repoRoot: string = REPO_ROOT): Map<string, string> {
	const dirs = new Map<string, string>();
	for (const member of typeScriptMembersOf(repoRoot)) {
		const manifestPath = join(repoRoot, member, "package.json");
		if (!existsSync(manifestPath)) continue;
		try {
			const data = JSON.parse(readFileSync(manifestPath, "utf-8")) as { name?: unknown };
			if (typeof data.name === "string") dirs.set(data.name, join(repoRoot, member));
		} catch {}
	}
	return dirs;
}

let workspaceDirectoriesByRepo: Map<string, Map<string, string>> | undefined;

/**
 * Resolves the directory of a TypeScript workspace package by its manifest name, cached per repository root.
 */
export function memberDirectoryOf(packageName: string, repoRoot: string = REPO_ROOT): string | undefined {
	if (workspaceDirectoriesByRepo === undefined) {
		workspaceDirectoriesByRepo = new Map();
	}
	let dirs = workspaceDirectoriesByRepo.get(repoRoot);
	if (dirs === undefined) {
		dirs = packageDirectories(repoRoot);
		workspaceDirectoriesByRepo.set(repoRoot, dirs);
	}
	return dirs.get(packageName);
}

export interface WorkspaceManifestEntry {
	readonly rel: string;
	readonly manifest: Record<string, unknown>;
}

export function workspaceManifests(repoRoot: string = REPO_ROOT): WorkspaceManifestEntry[] {
	const found: WorkspaceManifestEntry[] = [];
	for (const member of typeScriptMembersOf(repoRoot)) {
		const rel = `${member}/package.json`;
		const parsed = readPackageJson(member, repoRoot);
		if (parsed) {
			found.push({ rel, manifest: parsed });
		}
	}
	return found;
}

export function testFileCount(dir: string, repoRoot: string = REPO_ROOT): number {
	const SKIP = new Set(["node_modules", ".git", "dist", "target", "repo-cache", "runs", "deep-swe", "assets"]);
	let found = 0;
	const walk = (abs: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(abs, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (SKIP.has(entry.name)) continue;
				walk(join(abs, entry.name));
				continue;
			}
			if (/\.test\.tsx?$/.test(entry.name)) found += 1;
		}
	};
	walk(join(repoRoot, dir));
	return found;
}

export function packagesWithTests(repoRoot: string = REPO_ROOT): string[] {
	return typeScriptMembersOf(repoRoot)
		.filter(member => testFileCount(member, repoRoot) > 0)
		.sort();
}
