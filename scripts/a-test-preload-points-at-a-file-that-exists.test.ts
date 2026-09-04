/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECT IT CLOSES. Bun reads `bunfig.toml` from the working directory only, so every workspace
 * member that ships tests carries its own copy pointing at the shared preloads with a relative path:
 * `preload = ["../utils/test/helpers/real-data-tripwire.ts"]`. Moving `packages/wire` to
 * `contracts/wire` left that pointer one directory too shallow. Bun answered `preload not found`, and
 * every suite in the package crashed before its first assertion — eight files, zero of them run,
 * reported as eight failures with nothing about the cause.
 *
 * THE CLASS. A relative pointer out of a member's own directory breaks when the member moves, and the
 * three that matter here are all of that shape: the real-data tripwire, the mnemopi home isolation and
 * the provider-override tripwire. The pointer is not code, so no type check and no import gate reads
 * it; the failure surfaces only as a crashed worker in whichever bucket runs that package.
 *
 * HOW IT FAILS BY DEFAULT. The members come from the root manifest rather than assumed from globs,
 * every `bunfig.toml` under one is read, and each `preload` entry is resolved against the file that
 * declares it. A new member with a copied pointer, a moved member, and a renamed preload each turn
 * this red.
 *
 * WHAT IT DOES NOT CATCH. Whether the preload does anything: a file that exists and no longer
 * redirects `HOME` passes here and is `tests-never-touch-real-home.test.ts`'s subject. It also says
 * nothing about a member that ships tests and declares no `bunfig.toml` at all, because Bun then reads
 * the root config, which is correct rather than broken.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { REPO_ROOT, typeScriptMembers } from "./workspace-layout";

/** `preload = [ ... ]` in a `[test]` section, which is the only place these appear. */
const PRELOAD_LIST = /preload\s*=\s*\[([^\]]*)\]/;

/** Every `bunfig.toml` a `bun test` in this repository can read: the root one and each member's. */
function bunfigFiles(): string[] {
	const files = [join(REPO_ROOT, "bunfig.toml")];
	for (const member of typeScriptMembers()) {
		const config = join(REPO_ROOT, member, "bunfig.toml");
		if (existsSync(config)) files.push(config);
	}
	return files;
}

/** Each preload entry of `config`, as the absolute path Bun resolves it to. */
function preloadTargets(config: string): { entry: string; target: string }[] {
	const list = readFileSync(config, "utf-8").match(PRELOAD_LIST);
	if (!list?.[1]) return [];
	const targets: { entry: string; target: string }[] = [];
	for (const match of list[1].matchAll(/"([^"]+)"/g)) {
		const entry = match[1];
		if (entry === undefined) continue;
		targets.push({ entry, target: resolve(dirname(config), entry) });
	}
	return targets;
}

/** Every preload entry whose target does not exist, phrased the way the failure has to read. */
function missingPreloads(configs: readonly string[], base: string): { missing: string[]; checked: number } {
	const missing: string[] = [];
	let checked = 0;
	for (const config of configs) {
		for (const { entry, target } of preloadTargets(config)) {
			checked += 1;
			if (!existsSync(target)) missing.push(`${relative(base, config)} -> ${entry}`);
		}
	}
	return { missing, checked };
}

describe("a test preload", () => {
	const configs = bunfigFiles();

	it("is declared by the root and by every member that overrides it", () => {
		// Non-vacuity: an empty sweep would pass the resolution cell below. The root config and the
		// member that moved are both named, so a sweep that lost a whole root cannot read green.
		const found = configs.map(config => relative(REPO_ROOT, config));
		expect(found).toContain("bunfig.toml");
		expect(found).toContain("contracts/wire/bunfig.toml");
		expect(found).toContain("packages/coding-agent/bunfig.toml");
	});

	it("names a file that exists, from the config that declares it", () => {
		const { missing, checked } = missingPreloads(configs, REPO_ROOT);

		// A config whose preload list did not parse would report nothing missing, so the count of
		// resolved entries is asserted too: every member carrying one declares at least one.
		expect(checked).toBeGreaterThanOrEqual(configs.length);
		expect(missing).toEqual([]);
	});

	/**
	 * Anti-vacuity, and the arm the gate needs most: the assertion above is an empty list, which a
	 * resolution that stopped reporting satisfies exactly as well as a correct tree does. This plants
	 * one broken pointer and one valid one and sweeps THAT tree through the same function, so the
	 * parse, the resolution and the reported text are exercised against a known answer.
	 */
	it("reports a planted broken pointer, and only it", () => {
		const tree = mkdtempSync(join(tmpdir(), "preload-pointer-"));
		try {
			mkdirSync(join(tree, "moved"), { recursive: true });
			mkdirSync(join(tree, "settled"), { recursive: true });
			writeFileSync(join(tree, "moved", "bunfig.toml"), '[test]\npreload = ["../helpers/tripwire.ts"]\n');
			writeFileSync(join(tree, "settled", "bunfig.toml"), '[test]\npreload = ["./tripwire.ts"]\n');
			writeFileSync(join(tree, "settled", "tripwire.ts"), "export {};\n");

			const planted = [join(tree, "moved", "bunfig.toml"), join(tree, "settled", "bunfig.toml")];
			const { missing, checked } = missingPreloads(planted, tree);

			expect(checked).toBe(2);
			expect(missing).toEqual(["moved/bunfig.toml -> ../helpers/tripwire.ts"]);
		} finally {
			rmSync(tree, { recursive: true, force: true });
		}
	});
});
