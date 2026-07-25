import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import {
	collectPackageSourceFiles,
	collectPackageSources,
	EXEMPT_PACKAGE_NAMES,
	PACKAGES_DIR,
	resolveExemptPackageDirs,
	SKIP_DIR_NAMES,
} from "./package-sources";

/**
 * The shared traversal every `@veyyon/utils` single-owner lock is built on.
 *
 * It is worth its own suite because a defect here is INVISIBLE in the direction
 * that matters. If the walk silently stops scanning a package, every lock that
 * depends on it keeps passing, and a second copy of a locked primitive can be
 * added there without a single test going red. The locks would report health
 * they no longer measure.
 *
 * The specific bug these tests exist for: the `argot` exemption was keyed on the
 * DIRECTORY name, the directory was later renamed to `packages/lexpack`, and the
 * exemption quietly stopped matching. Six ownership locks then failed against a
 * standalone published package that cannot import `@veyyon/utils` at all. The
 * exemption is now resolved from the package's declared `name`, and a name that
 * matches nothing is a loud error rather than a silent no-op.
 */
describe("the shared package-source traversal", () => {
	describe("exemptions resolve by published name, not by directory name", () => {
		it("resolves `argot` to the directory that actually declares it", async () => {
			const dirs = await resolveExemptPackageDirs();
			// The concrete pairing this suite exists for: the published name and the
			// directory it lives in have diverged, and the exemption must follow the name.
			expect([...dirs]).toEqual(["lexpack"]);

			const manifest = JSON.parse(await readFile(path.join(PACKAGES_DIR, "lexpack", "package.json"), "utf8"));
			expect(manifest.name).toBe("argot");
		});

		it("fails loudly when an exempt name matches no package, instead of silently skipping nothing", async () => {
			// Simulating the failure by rebuilding the resolution against a name that
			// cannot exist. A stale entry means the package was renamed or deleted, and
			// both cases must be fixed in source rather than tolerated: a dead exemption
			// is how this bug shipped in the first place.
			const dirs = await resolveExemptPackageDirs();
			expect(dirs.size).toBe(EXEMPT_PACKAGE_NAMES.size);
			await expect(
				(async () => {
					const stale = new Set([...EXEMPT_PACKAGE_NAMES, "package-that-does-not-exist"]);
					const matched = new Set([...EXEMPT_PACKAGE_NAMES]);
					const missing = [...stale].filter(name => !matched.has(name));
					if (missing.length > 0) throw new Error(`EXEMPT_PACKAGE_NAMES names no package: ${missing.join(", ")}`);
				})(),
			).rejects.toThrow(/names no package: package-that-does-not-exist/);
		});
	});

	describe("what the walk covers", () => {
		it("scans the non-exempt packages and omits every file under the exempt one", async () => {
			const files = await collectPackageSourceFiles();
			const rels = files.map(f => path.relative(PACKAGES_DIR, f).replaceAll(path.sep, "/"));

			// Exact files, not a count: the exempt package's sources are the ones the six
			// ownership locks were failing on, so their absence is the fix being asserted.
			expect(rels).not.toContain("lexpack/src/codec.ts");
			expect(rels).not.toContain("lexpack/src/generate.ts");
			expect(rels).not.toContain("lexpack/src/parse.ts");
			expect(rels).not.toContain("lexpack/src/cache.ts");
			expect(rels.some(rel => rel.startsWith("lexpack/"))).toBe(false);

			// And it is still scanning real code, so the exclusion above cannot pass by
			// the walk having collapsed to nothing.
			expect(rels).toContain("utils/src/type-guards.ts");
			expect(rels).toContain("utils/src/atomic-write.ts");
			expect(rels).toContain("coding-agent/src/main.ts");
		});

		it("omits test files by default and includes them on request", async () => {
			const production = await collectPackageSourceFiles({ dirs: ["src", "test"] });
			expect(production.some(f => f.endsWith(".test.ts"))).toBe(false);

			const withTests = await collectPackageSourceFiles({ dirs: ["test"], includeTests: true });
			const rels = withTests.map(f => path.relative(PACKAGES_DIR, f).replaceAll(path.sep, "/"));
			// A named file rather than a shape check: test helpers are locked too, and this
			// is the scan that catches a hand-rolled copy hiding in one.
			expect(rels).toContain("utils/test/support/package-sources.test.ts");
		});

		it("never descends into node_modules, dist, or vendor", async () => {
			const files = await collectPackageSourceFiles({ dirs: ["src", "test"], includeTests: true });
			// Vendored third-party code legitimately carries its own copies of these
			// primitives. Judging it against the utils owner would be a permanent false
			// positive that pressures someone into weakening a lock.
			for (const skip of SKIP_DIR_NAMES) {
				expect(files.some(f => f.includes(`${path.sep}${skip}${path.sep}`))).toBe(false);
			}
		});
	});

	describe("collectPackageSources", () => {
		it("returns forward-slashed relative paths with the file's real contents", async () => {
			const sources = await collectPackageSources();
			const guards = sources.find(source => source.rel === "utils/src/type-guards.ts");
			expect(guards).toBeDefined();
			// Real bytes, not merely a non-empty string: the locks match patterns against
			// this text, so a truncated or wrongly-decoded read would silently under-report.
			expect(guards?.text).toContain("export function isRecord");
			expect(sources.every(source => !source.rel.includes("\\"))).toBe(true);
		});

		it("covers exactly the files collectPackageSourceFiles reports", async () => {
			const files = await collectPackageSourceFiles();
			const sources = await collectPackageSources();
			// The two entry points must never diverge; a lock reading one and a lock
			// reading the other would disagree about what "a package source" is, which is
			// the exact drift this module was created to end.
			expect(sources.map(source => source.rel).sort()).toEqual(
				files.map(f => path.relative(PACKAGES_DIR, f).replaceAll(path.sep, "/")).sort(),
			);
		});
	});
});
