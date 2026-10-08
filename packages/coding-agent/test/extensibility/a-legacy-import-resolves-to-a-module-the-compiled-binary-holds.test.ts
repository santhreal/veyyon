/**
 * WHY: the compiled binary served the shimmed package roots under `veyyon-legacy-pi-bundled:@veyyon/pi-ai`,
 * `@veyyon/pi-coding-agent` and `@veyyon/pi-tui`, but the build table keys every module under its
 * canonical package name (`@veyyon/coding-agent`), so an extension importing
 * `@mariozechner/pi-coding-agent`, `@earendil-works/pi-tui` or `@veyyon/ai` failed to load with "no
 * bundled module registered". A legacy `pi-` subpath (`@mariozechner/pi-ai/oauth`) missed its
 * override, which is keyed by canonical name, and fell through to filesystem resolution, which a
 * compiled binary cannot satisfy.
 *
 * THE CLASS THIS CLOSES: a legacy or canonical pi specifier, in any scope alias and either basename
 * era, naming any module the build table holds, that compiled-mode resolution does not map to that
 * module's key; a compiled-mode override naming a key the table does not hold; and a legacy root
 * that resolves to another file than its canonical name outside the binary. Scopes, basenames and
 * keys are read from source at run time, so a new scope, package or exported module is covered on
 * arrival, and a bundled package with no legacy basename turns the sweep red.
 *
 * WHAT IT DOES NOT CATCH: the Bun plugin hooks and the synthetic module source served for a key,
 * which only a compiled binary runs; `legacy-pi-bundled-virtual.test.ts` drives the source synthesis.
 */

import { describe, expect, it } from "bun:test";
import {
	__buildLegacyPiPackageRootOverrides,
	__legacyPiOverrideFor,
	__legacyPiSpecifierSpace,
	__remapLegacyPiSpecifier,
} from "@veyyon/coding-agent/extensibility/plugins/legacy-pi-compat";
import { collectBundledPiEntries, collectShimmedRootKeys } from "../../scripts/legacy-pi-virtual-module";

const VIRTUAL = "veyyon-legacy-pi-bundled:";
const TYPEBOX_KEY = "typebox";
const CANONICAL_KEY = /^@veyyon\/([^/]+)(\/.*)?$/;

const keys = (await collectBundledPiEntries()).map(entry => entry.key);
const tableKeys = new Set(keys);
const compiled = __buildLegacyPiPackageRootOverrides(true, keys);
const { scopes, packages } = __legacyPiSpecifierSpace();

function overrideFor(specifier: string, overrides: Readonly<Record<string, string>>): string | undefined {
	const remapped = __remapLegacyPiSpecifier(specifier);
	return remapped === null ? undefined : __legacyPiOverrideFor(remapped, overrides);
}

describe("a legacy import in the compiled binary", () => {
	it("resolves, in every scope and basename era, to the table key of the module it names", () => {
		const misses: string[] = [];
		let checked = 0;
		for (const key of keys) {
			if (key === TYPEBOX_KEY) continue;
			const match = CANONICAL_KEY.exec(key);
			if (!match) {
				misses.push(`${key}: not an @veyyon key`);
				continue;
			}
			const [, pkg, subpath = ""] = match;
			for (const basename of [pkg!, `pi-${pkg}`]) {
				if (!packages.includes(basename)) {
					misses.push(`${basename}: not a legacy package name`);
					continue;
				}
				for (const scope of scopes) {
					const specifier = `@${scope}/${basename}${subpath}`;
					const target = overrideFor(specifier, compiled);
					checked++;
					if (target !== `${VIRTUAL}${key}`) misses.push(`${specifier} -> ${target}`);
				}
			}
		}
		expect(misses).toEqual([]);
		expect(checked).toBe((keys.length - 1) * scopes.length * 2);
	});

	it("names only modules the build table holds", async () => {
		const foreign = Object.entries(compiled)
			.filter(([, target]) => !target.startsWith(VIRTUAL) || !tableKeys.has(target.slice(VIRTUAL.length)))
			.map(([specifier, target]) => `${specifier} -> ${target}`);
		expect(foreign).toEqual([]);
		// Before the table loads, the shimmed roots alone are served, under keys the table holds.
		const seeded = Object.values(__buildLegacyPiPackageRootOverrides(true)).map(target =>
			target.slice(VIRTUAL.length),
		);
		expect(seeded.sort()).toEqual((await collectShimmedRootKeys()).sort());
	});

	it("follows a relocated upstream subpath to the module now holding it", () => {
		expect(overrideFor("@mariozechner/pi-ai/utils/oauth", compiled)).toBe(`${VIRTUAL}@veyyon/ai/oauth`);
	});
});

describe("a legacy root outside the binary", () => {
	it("resolves to the same source shim as its canonical name, in every scope", async () => {
		const dev = __buildLegacyPiPackageRootOverrides(false);
		const roots = await collectShimmedRootKeys();
		const misses: string[] = [];
		for (const root of roots) {
			const shim = dev[root];
			if (!shim || shim.startsWith(VIRTUAL)) {
				misses.push(`${root}: no source shim (${shim})`);
				continue;
			}
			const pkg = root.slice("@veyyon/".length);
			for (const scope of scopes) {
				for (const basename of [pkg, `pi-${pkg}`]) {
					const target = overrideFor(`@${scope}/${basename}`, dev);
					if (target !== shim) misses.push(`@${scope}/${basename} -> ${target}`);
				}
			}
		}
		expect(misses).toEqual([]);
		expect(roots.length).toBeGreaterThan(0);
	});
});
