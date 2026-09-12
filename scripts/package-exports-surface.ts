/**
 * The import specifiers a publishable workspace member offers a consumer, read from the manifests
 * that declare them.
 *
 * A member's `exports` map is the whole of what an outside project may import: a name reachable
 * only through a path the map does not declare is not public. The map is read here rather than
 * listed, so a member that grows an entry point arrives covered, and one that loses an entry point
 * takes its baseline row with it.
 *
 * A wildcard entry (`./tools/*`) declares a shape rather than a module, and the set it resolves to
 * is the file tree, which moves under every refactor. Those are left out, and the caller states
 * what it does about a member that declares nothing else.
 *
 * Usage: read by `scripts/a-package-exports-its-public-surface.test.ts` and by the generator that
 * writes the baseline it compares against:
 *
 *   bun run scripts/gen-package-exports-baseline.ts
 */

import { REPO_ROOT, readPackageJson, typeScriptMembers } from "./workspace-layout";

/** Extensions an `exports` entry names when it publishes an asset rather than a module. */
const ASSET_SUFFIXES = [".json", ".css", ".md", ".lark", ".txt", ".wasm", ".node", ".sql"];

/**
 * Specifiers no server runtime can import, each with the reason, so the gate states the gap instead
 * of resolving it silently.
 *
 * A module written for a document reaches for `document` while it loads, which throws in a runtime
 * that has none. Its value surface is real and unguarded here; a browser test is what covers it.
 * The map is read by both the generator and the gate, so a new entry point of this kind fails the
 * gate on its first run rather than dropping out of the sweep.
 */
export const SPECIFIERS_A_SERVER_RUNTIME_CANNOT_IMPORT: Record<string, string> = {
	"@veyyon/stats/client": "the dashboard's browser client, which reads `document` as it loads",
};

/** One publishable member: its package name, its directory, and the specifiers a consumer imports. */
export interface PublishableMember {
	/** The package name, which is the `.` specifier. */
	name: string;
	/** The member directory, relative to the repository root. */
	directory: string;
	/** Every declared, non-wildcard, JavaScript-resolving specifier, sorted. */
	specifiers: string[];
}

/**
 * The specifier an `exports` key names for `packageName`, or undefined when the gate does not sweep
 * it: a wildcard shape, a published asset, or an entry no server runtime can import.
 */
function specifierOf(packageName: string, exportKey: string): string | undefined {
	if (exportKey.includes("*") || ASSET_SUFFIXES.some(suffix => exportKey.endsWith(suffix))) return undefined;
	const specifier =
		exportKey === "." ? packageName : exportKey.startsWith("./") ? `${packageName}/${exportKey.slice(2)}` : undefined;
	return specifier && !(specifier in SPECIFIERS_A_SERVER_RUNTIME_CANNOT_IMPORT) ? specifier : undefined;
}

/**
 * Every publishable TypeScript workspace member, with the specifiers it publishes.
 *
 * A member is publishable when its manifest does not declare `"private": true`, which is the same
 * test the changelog gate applies, so the two agree on what ships.
 */
export function publishableMembers(): PublishableMember[] {
	const members: PublishableMember[] = [];
	for (const directory of typeScriptMembers()) {
		const manifest = readPackageJson(directory, REPO_ROOT);
		if (!manifest || manifest.private === true || typeof manifest.name !== "string" || !manifest.name) continue;
		const name = manifest.name;
		const specifiers = Object.keys((manifest.exports as Record<string, unknown>) ?? {})
			.map(key => specifierOf(name, key))
			.filter((specifier): specifier is string => specifier !== undefined)
			.sort();
		members.push({ name, directory, specifiers });
	}
	return members.sort((left, right) => left.name.localeCompare(right.name));
}

/** Every gated specifier across every publishable member, sorted. */
export function gatedSpecifiers(): string[] {
	return publishableMembers()
		.flatMap(member => member.specifiers)
		.sort();
}

/** The value names a specifier exports at run time, sorted. */
export async function exportedNames(specifier: string): Promise<string[]> {
	// Dynamic import: the specifier comes from a manifest at run time, which a static import cannot
	// express. This is the loader boundary the gate exists to exercise.
	const module: Record<string, unknown> = await import(specifier);
	return Object.keys(module).sort();
}
