import { describe, expect, it } from "bun:test";
import {
	collectPackageSourceFiles,
	collectPackageSources,
	EXEMPT_PACKAGE_NAMES,
	PACKAGES_DIR,
	SKIP_DIR_NAMES,
} from "./support/package-sources";

/**
 * These tests exist because thirteen source-ownership lock suites used to each
 * hand-roll the "walk every package's TypeScript sources" traversal with an
 * independently maintained skip-set, and the copies had drifted — some skipped
 * `vendor`, some did not; some excluded the standalone `argot` package, some did
 * not. A divergent skip-set is a silent lock hole: a second copy of a locked
 * primitive can hide in a directory one lock skips and another scans, so the
 * ownership guarantee depends on which suite you happen to read. The walk now
 * has ONE owner (./support/package-sources); this suite pins its contract and
 * fails if a fresh hand-rolled copy reappears.
 */
describe("collectPackageSourceFiles / collectPackageSources", () => {
	it("collects production src files across packages and returns absolute .ts paths", async () => {
		const files = await collectPackageSourceFiles();
		// A known production source is present, by absolute path.
		expect(files.some(f => f.endsWith("/utils/src/regex.ts"))).toBe(true);
		expect(files.every(f => f.startsWith(PACKAGES_DIR))).toBe(true);
		expect(files.every(f => f.endsWith(".ts"))).toBe(true);
	});

	it("defaults to src only and excludes *.test.ts files", async () => {
		const rels = (await collectPackageSources()).map(s => s.rel);
		expect(rels).toContain("utils/src/regex.ts");
		expect(rels).toContain("utils/src/tokens.ts");
		expect(rels.some(r => r.endsWith(".test.ts"))).toBe(false);
		expect(rels.some(r => r.includes("/test/"))).toBe(false);
	});

	it("excludes the standalone argot package root from every scan", async () => {
		const srcRels = (await collectPackageSources()).map(s => s.rel);
		const testRels = (await collectPackageSources({ dirs: ["src", "test"], includeTests: true })).map(s => s.rel);
		expect(srcRels.some(r => r.startsWith("argot/"))).toBe(false);
		expect(testRels.some(r => r.startsWith("argot/"))).toBe(false);
	});

	it("never descends into node_modules, dist, or vendor trees", async () => {
		const rels = (await collectPackageSources({ dirs: ["src", "test"], includeTests: true })).map(s => s.rel);
		expect(rels.some(r => r.includes("/node_modules/"))).toBe(false);
		expect(rels.some(r => r.includes("/dist/"))).toBe(false);
		expect(rels.some(r => r.includes("/vendor/"))).toBe(false);
		// A nested dir literally named `argot` (a vendored SDK copy) is skipped too.
		expect(rels.some(r => r.includes("/argot/"))).toBe(false);
	});

	it("includes *.test.ts only when includeTests is set", async () => {
		const withTests = (await collectPackageSources({ dirs: ["test"], includeTests: true })).map(s => s.rel);
		expect(withTests).toContain("utils/test/tokens.test.ts");
		expect(withTests.every(r => r.startsWith("utils/") || r.includes("/"))).toBe(true);

		// The same test/ scan with includeTests off yields nothing (only *.test.ts live there).
		const withoutTests = (await collectPackageSources({ dirs: ["test"] })).map(s => s.rel);
		expect(withoutTests.some(r => r.endsWith(".test.ts"))).toBe(false);
	});

	it("reads real file contents for each collected path", async () => {
		const sources = await collectPackageSources();
		const regex = sources.find(s => s.rel === "utils/src/regex.ts");
		expect(regex).toBeDefined();
		// The owner exports escapeRegExp — proves we read bytes, not just paths.
		expect(regex?.text).toContain("export function escapeRegExp");
	});

	it("exposes the canonical skip-set constants", () => {
		expect([...SKIP_DIR_NAMES].sort()).toEqual(["dist", "node_modules", "vendor"]);
		expect([...EXEMPT_PACKAGE_NAMES]).toEqual(["argot"]);
		expect(PACKAGES_DIR.endsWith("packages")).toBe(true);
	});
});

/**
 * Meta-lock: once the ownership-walk was unified, a fresh hand-rolled copy in a
 * utils/test suite would silently reintroduce the drift this owner eliminated.
 * This scan fails if any utils/test file compares a directory entry against the
 * node_modules skip literal — the signature of a hand-rolled skip-set — outside
 * the small allow-list of suites whose traversal is genuinely different from the
 * shared one. Scope is utils/test only: the helper is a utils-local test module
 * reached by relative import, so no other package can dedupe onto it. The needle
 * is built at runtime so this file does not match itself.
 */
describe("ownership-walk meta-lock", () => {
	// Suites whose traversal genuinely differs from the shared owner and must
	// keep a bespoke walk:
	//   math          — also scans scripts/ and conditionally skips modes/
	//   jwt, json     — skip test/__tests__ by name and scan the whole package tree
	//   browser-safe-barrel — a browser-import-safety scan, skips only node_modules/dist
	const ALLOWED_BESPOKE_WALKS: ReadonlySet<string> = new Set([
		"utils/test/math.test.ts",
		"utils/test/jwt.test.ts",
		"utils/test/json.test.ts",
		"utils/test/browser-safe-barrel.test.ts",
	]);

	it("no utils/test file hand-rolls a package walk skip-set outside the allow-list", async () => {
		const needle = `=== ${JSON.stringify("node_modules")}`; // the `entry.name ===` skip idiom, assembled at runtime
		const offenders: string[] = [];
		for (const { rel, text } of await collectPackageSources({ dirs: ["test"], includeTests: true })) {
			if (!rel.startsWith("utils/test/")) continue;
			if (ALLOWED_BESPOKE_WALKS.has(rel)) continue;
			if (text.includes(needle)) offenders.push(rel);
		}
		expect(
			offenders,
			"new hand-rolled package-walk skip-set — import collectPackageSourceFiles/collectPackageSources from ./support/package-sources instead",
		).toEqual([]);
	});

	it("the allow-listed bespoke walks still exist (stale entries must be removed)", async () => {
		const needle = `=== ${JSON.stringify("node_modules")}`;
		const testRels = new Map(
			(await collectPackageSources({ dirs: ["test"], includeTests: true })).map(s => [s.rel, s.text]),
		);
		const stale: string[] = [];
		for (const rel of ALLOWED_BESPOKE_WALKS) {
			if (!testRels.get(rel)?.includes(needle)) stale.push(rel);
		}
		expect(stale, "allow-listed file no longer hand-rolls a walk — remove it from ALLOWED_BESPOKE_WALKS").toEqual([]);
	});
});
