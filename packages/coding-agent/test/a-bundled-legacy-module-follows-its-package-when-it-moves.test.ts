/**
 * WHY: the compiled binary's legacy-extension surface named a package by its directory under
 * `packages/`, and two of those packages left `packages/`. `@veyyon/tui` became
 * `hosts/terminal/engine` and `@veyyon/natives` became `natives/bridge/bindings`, so
 * `readBundledManifest` opened `packages/natives/package.json` and the whole binary build died with
 * ENOENT — in the install-method jobs, which are the only jobs that compile a binary, and after
 * eleven minutes of native compilation each.
 *
 * THE CLASS THIS CLOSES: a build-time reader that infers a member's directory from its name. The
 * resolver reads the workspace member list and keys it by the name each manifest declares, so a
 * member that moves again is followed. The cases below drive the real
 * `collectBundledPiEntries()` / `collectShimmedRootKeys()` / `bundledPackageDirectories()`, sweep
 * `BUNDLED_PACKAGE_NAMES` at run time rather than restating it, and fail closed on a bundled package
 * this checkout does not carry — which is what a rename of a package looks like from here.
 *
 * WHAT IT DOES NOT CATCH: whether an entry's module graph compiles, which only a binary build says,
 * and the rest of `compile-binary.ts` — `packages/stats` is still named by path there, correctly,
 * because that member has not moved.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	BUNDLED_PACKAGE_NAMES,
	bundledPackageDirectories,
	collectBundledPiEntries,
	collectShimmedRootKeys,
} from "../scripts/legacy-pi-virtual-module";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

const directories = await bundledPackageDirectories();
const entries = await collectBundledPiEntries();

/** Every target string in an exports map, whatever conditions or nesting it is written under. */
const exportTargets = (node: unknown): string[] => {
	if (typeof node === "string") return [node];
	if (Array.isArray(node)) return node.flatMap(exportTargets);
	if (node && typeof node === "object") return Object.values(node).flatMap(exportTargets);
	return [];
};

/**
 * Whether the package owning `file` publishes a subpath that resolves to it. The owner is the
 * nearest ancestor holding a `package.json`, so this asks the same question Bun's resolver asks at
 * runtime without hardcoding a member or a subpath shape.
 */
const isPublishedByItsMember = async (file: string): Promise<boolean> => {
	let directory = path.dirname(file);
	while (!(await fs.stat(path.join(directory, "package.json")).catch(() => null))?.isFile()) {
		const parent = path.dirname(directory);
		if (parent === directory || directory.length <= REPO_ROOT.length) return false;
		directory = parent;
	}
	const manifest: unknown = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
	const relative = `./${path.relative(directory, file).split(path.sep).join("/")}`;
	return exportTargets((manifest as { exports?: unknown }).exports).some(target => {
		if (!target.startsWith("./")) return false;
		const star = target.indexOf("*");
		if (star < 0) return target === relative;
		const [head, tail] = [target.slice(0, star), target.slice(star + 1)];
		return relative.startsWith(head) && relative.endsWith(tail) && relative.length >= head.length + tail.length;
	});
};

describe("a bundled legacy module follows its package", () => {
	/**
	 * The resolution itself, for every name the table carries. A name this checkout does not hold
	 * throws inside `bundledPackageDirectories()`, so reaching this cell at all is the first half of
	 * the assertion; the second is that each directory really is that package.
	 */
	it("resolves every bundled package to the directory whose manifest declares its name", async () => {
		// Non-vacuity: an empty table would satisfy every sweep below.
		expect(BUNDLED_PACKAGE_NAMES.length).toBeGreaterThan(0);
		expect([...directories.keys()].sort()).toEqual([...BUNDLED_PACKAGE_NAMES].sort());

		for (const name of BUNDLED_PACKAGE_NAMES) {
			const directory = directories.get(name);
			expect(directory, `${name} resolved to no directory`).toBeDefined();
			const manifest: unknown = JSON.parse(await fs.readFile(path.join(directory ?? "", "package.json"), "utf8"));
			expect((manifest as { name?: string }).name, `${directory} declares another package`).toBe(name);
		}
	});

	/**
	 * The defect, stated as the property that broke rather than as the two paths that broke it: a
	 * bundled package need not live under `packages/`. Derived by asking which resolved directories
	 * are outside it, so this cell keeps measuring after the next member moves.
	 */
	it("carries at least one bundled package from outside packages/", () => {
		const outside = [...directories]
			.filter(([, directory]) => !path.relative(REPO_ROOT, directory).startsWith(`packages${path.sep}`))
			.map(([name]) => name)
			.sort();

		expect(outside).toEqual(["@veyyon/natives", "@veyyon/tui"]);
	});

	/**
	 * The surface the binary actually embeds. Every bundled package contributes its own root key, so
	 * a package that resolved to a directory holding no manifest name would drop out here rather
	 * than silently shrink the extension surface a published binary serves.
	 */
	it("gives every bundled package a root entry and a unique binding", () => {
		const keys = entries.map(entry => entry.key);
		for (const name of BUNDLED_PACKAGE_NAMES) expect(keys).toContain(name);

		expect(new Set(entries.map(entry => entry.binding)).size).toBe(entries.length);
		// Non-vacuity: the subpath expansion runs, so this is a surface rather than six root keys.
		expect(entries.length).toBeGreaterThan(BUNDLED_PACKAGE_NAMES.length);
	});

	/**
	 * The wildcard exports, which are most of the surface: `@veyyon/agent-core/compaction/*` reaches a
	 * binary only because the collector scans the source directory behind the pattern. The prefixes
	 * come from each manifest at run time, so a package that adds a wildcard export is swept without
	 * being named here, and dropping the expansion leaves every prefix with no entries.
	 */
	it("expands every source-backed wildcard export into concrete subpath entries", async () => {
		const prefixes: string[] = [];
		for (const [name, directory] of directories) {
			const manifest: unknown = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
			const exportsField = (manifest as { exports?: Record<string, unknown> }).exports ?? {};
			for (const [exportKey, target] of Object.entries(exportsField)) {
				if (!exportKey.startsWith("./") || !exportKey.includes("*")) continue;
				const importTarget =
					typeof target === "string"
						? target
						: ((target as { import?: string; default?: string } | null)?.import ??
							(target as { default?: string } | null)?.default);
				if (typeof importTarget !== "string" || !/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(importTarget)) continue;
				const exportPrefix = exportKey.slice(2, exportKey.indexOf("*"));
				if (exportPrefix === "" || exportPrefix === "/") continue;
				prefixes.push(`${name}/${exportPrefix}`);
			}
		}

		// Non-vacuity: a checkout with no wildcard export would pass the sweep below on an empty list.
		expect(prefixes.length).toBeGreaterThan(0);
		const keys = entries.map(entry => entry.key);
		for (const prefix of prefixes) {
			expect(
				keys.filter(key => key.startsWith(prefix) && key.length > prefix.length).length,
				`${prefix}* expanded to no entries`,
			).toBeGreaterThan(0);
		}
	});

	/**
	 * The absolute entries, which is where the build failed the second time: a root shim named by a
	 * path inside THIS package, after the pi-ai and TypeBox shims moved into `@veyyon/kernel`. Bun
	 * reported two unresolvable entrypoints and the binary never built.
	 *
	 * Existence alone is the weaker half, because the runtime resolves the same shims by PACKAGE
	 * SUBPATH (`@veyyon/kernel/loader/legacy-pi-ai-shim`) while the build resolves them by file. A
	 * shim parked in a directory its owner does not publish satisfies the build and fails every
	 * extension load, so each entry is matched against the exports map of the member that holds it.
	 */
	it("points every shim entry at a file its owning package publishes", async () => {
		const absolute = entries.filter(entry => path.isAbsolute(entry.importSpecifier));
		// Non-vacuity: the shims are the only absolute entries, so an empty list means none was collected.
		expect(absolute.length).toBeGreaterThan(0);

		const unpublished: string[] = [];
		for (const entry of absolute) {
			const stat = await fs.stat(entry.importSpecifier).catch(() => null);
			expect(stat?.isFile() ?? false, `${entry.key} -> ${entry.importSpecifier}`).toBe(true);
			if (!(await isPublishedByItsMember(entry.importSpecifier))) unpublished.push(`${entry.key} -> ${entry.importSpecifier}`);
		}

		expect(unpublished, "the runtime resolves these by package subpath and would not find them").toEqual([]);

		const codingAgent = path.join(REPO_ROOT, "packages", "coding-agent");
		expect(
			absolute.filter(entry => !entry.importSpecifier.startsWith(codingAgent)).length,
			"no shim resolves outside coding-agent, so the kernel-owned shims are being spelled by hand again",
		).toBeGreaterThan(0);
	});

	/**
	 * The shimmed roots, by exact equality: a package that gains or loses a compat shim changes what
	 * an extension importing its bare name receives, which is a decision rather than a detail.
	 */
	it("shims exactly the three roots whose barrel dropped a surface", async () => {
		expect((await collectShimmedRootKeys()).sort()).toEqual(["@veyyon/ai", "@veyyon/coding-agent", "@veyyon/tui"]);
	});
});
