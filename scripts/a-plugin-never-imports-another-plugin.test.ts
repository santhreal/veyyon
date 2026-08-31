/**
 * A `plugins/*` member imports contracts, shared runtime packages and the platform, and never a sibling plugin.
 *
 * WHY THIS SUITE EXISTS. Every workspace member except the kernel is a plugin (Refs #927), and a
 * plugin is optional: the product runs with it absent. That property survives only while the plugins
 * are independent of each other. One plugin importing another types-checks silently, because every
 * workspace package resolves through one hoisted `node_modules` tree, and it converts two optional
 * members into one member with a hidden prerequisite — uninstalling `plugins/hashline` would then
 * break `plugins/mnemopi` at runtime with a module-resolution error, not a missing contribution.
 *
 * THE DEFECT CLASS. A bare specifier naming a sibling plugin's published package name, in any of the
 * three forms a module graph reaches (value import, type-only import, dynamic `import()`), from any
 * TypeScript file a plugin ships or tests with; and a relative specifier that climbs out of its own
 * plugin directory into a sibling's.
 *
 * WHAT IT DOES NOT CATCH. Coupling that is not an import: a plugin that reads a sibling's file from
 * disk, spawns its CLI, or depends on a contribution the sibling registers under a name it hardcoded.
 * The kernel's contribution registry is what those go through, and no static rule can see them.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { dynamicImportSpecifiersIn, moduleSpecifiersIn, typeOnlyModuleSpecifiersIn } from "@veyyon/utils/module-reach";
import { REPO_ROOT, typeScriptMembers } from "./workspace-layout.ts";

/** One plugin: its member directory (`plugins/mnemopi`) and the package name it publishes. */
interface Plugin {
	member: string;
	name: string;
}

/** A rejected edge: the file that declares it, the specifier, and why it is forbidden. */
export interface PluginEdgeViolation {
	file: string;
	specifier: string;
	reason: string;
}

/**
 * The relative specifiers a plugin may climb out of its own directory with, keyed by the member.
 *
 * Both are shared test scaffolding, not product code: the isolated-config-root helper that keeps a
 * suite out of the real home, and the root manifest a version assertion reads. They are pinned by
 * exact equality below so a fourth escape is a decision somebody records rather than a habit.
 */
const PERMITTED_ESCAPES = ["package.json", "packages/utils/test/helpers/isolated-config-root"] as const;

/** Every `plugins/*` member, resolved from the root manifest rather than named. */
export function plugins(): Plugin[] {
	const found: Plugin[] = [];
	for (const member of typeScriptMembers()) {
		if (!member.startsWith("plugins/")) continue;
		const manifestPath = path.join(REPO_ROOT, member, "package.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: string };
		if (manifest.name === undefined) throw new Error(`${member}/package.json declares no name`);
		found.push({ member, name: manifest.name });
	}
	return found.sort((left, right) => left.member.localeCompare(right.member));
}

/** Every `.ts`/`.tsx` file under a directory, absolute, sorted, skipping `node_modules`. */
function typeScriptFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...typeScriptFiles(full));
		else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) files.push(full);
	}
	return files.sort();
}

/**
 * Why `specifier` is forbidden inside `owner`, or null when it is allowed.
 *
 * `siblings` carries every OTHER plugin, so the rule is derived from the resolved member list and a
 * plugin added tomorrow is judged with no edit here.
 */
export function classifyPluginEdge(
	specifier: string,
	fromFile: string,
	owner: Plugin,
	siblings: readonly Plugin[],
): string | null {
	for (const sibling of siblings) {
		if (specifier === sibling.name || specifier.startsWith(`${sibling.name}/`)) {
			return `names the sibling plugin ${sibling.member} (${sibling.name})`;
		}
	}
	if (!specifier.startsWith(".")) return null;

	const ownerDir = path.resolve(REPO_ROOT, owner.member);
	const resolved = path.resolve(path.dirname(fromFile), specifier);
	if (resolved === ownerDir || resolved.startsWith(ownerDir + path.sep)) return null;

	const escaped = path.relative(REPO_ROOT, resolved).replaceAll(path.sep, "/");
	for (const sibling of siblings) {
		if (escaped === sibling.member || escaped.startsWith(`${sibling.member}/`)) {
			return `climbs into the sibling plugin ${sibling.member}`;
		}
	}
	if (escaped.startsWith("plugins/")) return "climbs into another plugins/ member";
	return PERMITTED_ESCAPES.includes(escaped as (typeof PERMITTED_ESCAPES)[number])
		? null
		: `climbs out of ${owner.member} to ${escaped}, which is not a recorded escape`;
}

/** Every rejected edge across every plugin, and the file count the sweep read. */
export function pluginEdgeViolations(): { violations: PluginEdgeViolation[]; filesRead: number; edges: number } {
	const members = plugins();
	const violations: PluginEdgeViolation[] = [];
	let filesRead = 0;
	let edges = 0;
	for (const owner of members) {
		const siblings = members.filter(candidate => candidate.member !== owner.member);
		for (const file of typeScriptFiles(path.join(REPO_ROOT, owner.member))) {
			filesRead += 1;
			const source = fs.readFileSync(file, "utf8");
			// Every shape a module graph reaches: value import, type-only import, dynamic `import()`.
			const specifiers = [
				...moduleSpecifiersIn(source),
				...typeOnlyModuleSpecifiersIn(source),
				...dynamicImportSpecifiersIn(source),
			];
			for (const specifier of specifiers) {
				edges += 1;
				const reason = classifyPluginEdge(specifier, file, owner, siblings);
				if (reason !== null) {
					violations.push({ file: path.relative(REPO_ROOT, file).replaceAll(path.sep, "/"), specifier, reason });
				}
			}
		}
	}
	return { violations, filesRead, edges };
}

describe("a plugin never imports another plugin", () => {
	const members = plugins();
	const swept = pluginEdgeViolations();

	/**
	 * Anti-vacuity. Every cell below reports zero violations when the sweep reads nothing, which is
	 * the same green as a clean tree. A plugin whose files this walk cannot reach is a hole, so each
	 * member is asserted to contribute files rather than the total being asserted alone.
	 */
	it("reads every plugin's TypeScript files and the specifiers in them", () => {
		expect(members.map(plugin => plugin.member)).toEqual([
			"plugins/argot",
			"plugins/hashline",
			"plugins/mnemopi",
			"plugins/mode-swarm",
		]);
		for (const plugin of members) {
			expect(typeScriptFiles(path.join(REPO_ROOT, plugin.member)).length).toBeGreaterThan(0);
		}
		expect(swept.filesRead).toBeGreaterThan(1000);
		expect(swept.edges).toBeGreaterThan(2000);
	});

	it("has no plugin naming a sibling plugin's package or climbing into its directory", () => {
		expect(swept.violations).toEqual([]);
	});

	/**
	 * The escape list is the whole recorded decision, so it is pinned by equality rather than by
	 * length: a fourth entry, or a silent widening to `packages/**`, turns this red.
	 */
	it("permits exactly the two escapes that were recorded", () => {
		expect([...PERMITTED_ESCAPES]).toEqual(["package.json", "packages/utils/test/helpers/isolated-config-root"]);
	});

	/**
	 * The classifier is exercised directly on edges the tree does not contain, because a rule proved
	 * only by a clean sweep is a rule that has never been observed to reject anything. One case per
	 * branch: the bare package name, a subpath of it, a relative climb into a sibling, an unrecorded
	 * relative climb, and the two shapes that must stay allowed.
	 */
	it("rejects each shape of a cross-plugin edge and allows the ones a plugin needs", () => {
		const [argot, hashline, mnemopi] = [members[0], members[1], members[2]];
		expect(argot?.member).toBe("plugins/argot");
		expect(hashline?.member).toBe("plugins/hashline");
		expect(mnemopi === undefined).toBe(false);
		if (argot === undefined || hashline === undefined || mnemopi === undefined) return;

		const file = path.join(REPO_ROOT, "plugins/mnemopi/src/core/recall.ts");
		const siblings = [argot, hashline];

		expect(classifyPluginEdge(hashline.name, file, mnemopi, siblings)).toBe(
			`names the sibling plugin plugins/hashline (${hashline.name})`,
		);
		expect(classifyPluginEdge(`${hashline.name}/prompts/registry`, file, mnemopi, siblings)).toBe(
			`names the sibling plugin plugins/hashline (${hashline.name})`,
		);
		expect(classifyPluginEdge(argot.name, file, mnemopi, siblings)).toBe(
			`names the sibling plugin plugins/argot (${argot.name})`,
		);
		expect(classifyPluginEdge("../../../hashline/src/tokenizer", file, mnemopi, siblings)).toBe(
			"climbs into the sibling plugin plugins/hashline",
		);
		expect(classifyPluginEdge("../../../../plugins/future-plugin/src/index", file, mnemopi, siblings)).toBe(
			"climbs into another plugins/ member",
		);
		expect(classifyPluginEdge("../../../../packages/coding-agent/src/tools/read", file, mnemopi, siblings)).toBe(
			"climbs out of plugins/mnemopi to packages/coding-agent/src/tools/read, which is not a recorded escape",
		);

		expect(classifyPluginEdge("./types", file, mnemopi, siblings)).toBe(null);
		expect(classifyPluginEdge("@veyyon/utils/logger", file, mnemopi, siblings)).toBe(null);
		expect(classifyPluginEdge("node:fs", file, mnemopi, siblings)).toBe(null);
		expect(
			classifyPluginEdge(
				"../../../packages/utils/test/helpers/isolated-config-root",
				path.join(REPO_ROOT, "plugins/mnemopi/test/setup.ts"),
				mnemopi,
				siblings,
			),
		).toBe(null);
		expect(
			classifyPluginEdge("../../../package.json", path.join(REPO_ROOT, "plugins/mnemopi/test/x.test.ts"), mnemopi, [
				argot,
			]),
		).toBe(null);
	});

	/**
	 * A plugin's manifest is the other place the edge can be declared, and a dependency there is what
	 * makes the import resolve for an installed consumer rather than only inside this workspace.
	 */
	it("has no plugin declaring a sibling plugin as a dependency", () => {
		const declared: string[] = [];
		for (const plugin of members) {
			const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, plugin.member, "package.json"), "utf8")) as {
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
				peerDependencies?: Record<string, string>;
			};
			const names = [
				...Object.keys(manifest.dependencies ?? {}),
				...Object.keys(manifest.devDependencies ?? {}),
				...Object.keys(manifest.peerDependencies ?? {}),
			];
			for (const sibling of members) {
				if (sibling.member === plugin.member) continue;
				if (names.includes(sibling.name)) declared.push(`${plugin.member} -> ${sibling.name}`);
			}
		}
		expect(declared).toEqual([]);
	});
});
