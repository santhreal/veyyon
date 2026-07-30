import { describe, expect, it } from "bun:test";
import { bumpVersion, parseVersion, rewriteCargoWorkspaceVersion, rewritePackageVersion } from "./release.ts";

// The version-bump arithmetic decides the number of EVERY release cut by
// release.ts. A regression here does not fail loudly — it silently publishes the
// wrong version (a minor that forgets to reset patch, a bump that reads the
// wrong current version), which then poisons the tag, the changelog section, the
// native sentinel, and `veyyon update`'s "is there a newer version" comparison.
// These lock the exact next-version output and the parse boundaries so that
// class is caught in CI before a bad number ever reaches a tag.

describe("parseVersion", () => {
	it("splits a clean semver into numeric major/minor/patch", () => {
		expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
	});

	it("tolerates a leading v", () => {
		expect(parseVersion("v10.0.42")).toEqual([10, 0, 42]);
	});

	it("reads multi-digit components numerically, not lexically", () => {
		// 1.0.22 must parse patch as 22, not "22" mis-ordered against "9".
		expect(parseVersion("1.0.22")).toEqual([1, 0, 22]);
		expect(parseVersion("2.13.100")).toEqual([2, 13, 100]);
	});

	it("ignores a trailing prerelease/build suffix after the semver core", () => {
		// The regex anchors the X.Y.Z core and lets anything follow, so an rc tag
		// still yields its base numbers rather than throwing.
		expect(parseVersion("1.2.3-rc.1")).toEqual([1, 2, 3]);
		expect(parseVersion("v1.2.3+build.5")).toEqual([1, 2, 3]);
	});

	it("throws with the offending value on a non-semver string", () => {
		// A garbage current version must fail loudly at cut time, never be coerced to
		// a default that would mint 0.0.1 or similar.
		expect(() => parseVersion("not-a-version")).toThrow("Invalid version: not-a-version");
		expect(() => parseVersion("1.2")).toThrow("Invalid version: 1.2");
	});
});

describe("bumpVersion", () => {
	it("increments the patch component for a patch bump, leaving major/minor", () => {
		expect(bumpVersion("1.0.22", "patch")).toBe("1.0.23");
		expect(bumpVersion("2.13.9", "patch")).toBe("2.13.10");
	});

	it("increments minor and RESETS patch to 0 for a minor bump", () => {
		// The classic bug: a minor bump that carries the old patch forward
		// (1.2.3 -> 1.3.3). Assert the reset explicitly.
		expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
		expect(bumpVersion("1.0.22", "minor")).toBe("1.1.0");
	});

	it("increments major and RESETS minor and patch to 0 for a major bump", () => {
		expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
		expect(bumpVersion("9.9.9", "major")).toBe("10.0.0");
	});

	it("accepts a leading v on the current version but emits a bare number", () => {
		// release.ts tags with an added `v`; the bump output must not double it.
		expect(bumpVersion("v1.0.22", "patch")).toBe("1.0.23");
		expect(bumpVersion("v1.0.22", "patch").startsWith("v")).toBe(false);
	});

	it("carries across a 9 boundary without lexical surprises", () => {
		expect(bumpVersion("1.0.9", "patch")).toBe("1.0.10");
		expect(bumpVersion("1.9.9", "minor")).toBe("1.10.0");
	});
});

describe("release metadata rewriting", () => {
	/** A package bump changes its own version without touching dependency ranges or formatting. */
	it("rewrites only the manifest version field", () => {
		const before =
			'{\n  "name": "@veyyon/example",\n  "version": "1.2.3",\n  "dependencies": { "other": "1.2.3" }\n}\n';

		expect(rewritePackageVersion(before, "1.2.4")).toBe(
			'{\n  "name": "@veyyon/example",\n  "version": "1.2.4",\n  "dependencies": { "other": "1.2.3" }\n}\n',
		);
	});

	/** A malformed public manifest must stop a cut instead of silently retaining its old version. */
	it("refuses a package manifest without a version", () => {
		expect(() => rewritePackageVersion('{"name":"@veyyon/broken"}', "1.2.4")).toThrow(
			'Package manifest has no top-level "version" field.',
		);
	});

	/** The Rust bump targets workspace.package even when another version appears earlier. */
	it("rewrites only the Cargo workspace version", () => {
		const before =
			'[package]\nname = "decoy"\nversion = "9.9.9"\n\n[workspace.package]\nversion = "1.2.3"\nedition = "2024"\n';

		expect(rewriteCargoWorkspaceVersion(before, "1.2.4")).toBe(
			'[package]\nname = "decoy"\nversion = "9.9.9"\n\n[workspace.package]\nversion = "1.2.4"\nedition = "2024"\n',
		);
	});

	/** A missing workspace package section cannot produce a partially versioned release. */
	it("refuses Cargo metadata without a workspace version", () => {
		expect(() => rewriteCargoWorkspaceVersion("[workspace]\nmembers = []\n", "1.2.4")).toThrow(
			"Cargo.toml has no [workspace.package] version.",
		);
	});
});
