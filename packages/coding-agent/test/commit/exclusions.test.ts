import { describe, expect, it } from "bun:test";
import { filterExcludedFiles, isExcludedFile } from "@veyyon/coding-agent/commit/utils/exclusions";

/**
 * Lockfiles and other machine-generated manifests are excluded from commit
 * analysis so they do not dominate the diff. Matching must key on the file's
 * BASENAME, not a full-path `endsWith`: a real source file whose name merely
 * ends with an excluded name (`service-go.sum`, `app-package-lock.json`) must
 * still be analyzed. These tests pin the exact match set, the case-insensitive
 * and nested-path behavior, and the false-positive guard that a whole-path
 * `endsWith` regressed.
 */

describe("isExcludedFile true positives", () => {
	it("excludes each known lockfile by exact basename", () => {
		for (const name of [
			"Cargo.lock",
			"package-lock.json",
			"yarn.lock",
			"pnpm-lock.yaml",
			"bun.lock",
			"go.sum",
			"poetry.lock",
			"flake.lock",
			"Packages.resolved",
			"packages.lock.json",
		]) {
			expect(isExcludedFile(name)).toBe(true);
		}
	});

	it("excludes gradle.lockfile (present in the split-commit manifest set, once missing here)", () => {
		// Regression for BUG-GIT-OVERVIEW-NARROW-CASE-SENSITIVE-EXCLUSION: gradle.lockfile
		// lived only in the manifest-keyed EXCLUDED_LOCK_FILES set, so the canonical
		// analysis exclusion (and thus scope suggestion) failed to hide it.
		expect(isExcludedFile("gradle.lockfile")).toBe(true);
		expect(isExcludedFile("app/gradle.lockfile")).toBe(true);
		expect(isExcludedFile("GRADLE.LOCKFILE")).toBe(true);
	});

	it("excludes generated lockfiles git_overview once leaked to the model", () => {
		// These are in the canonical set but were NOT in the narrow EXCLUDED_LOCK_FILES
		// that git_overview used, so the overview showed them to the commit model.
		for (const name of [
			"deno.lock",
			"npm-shrinkwrap.json",
			"shrinkwrap.yaml",
			"pdm.lock",
			"Pipfile.lock",
			"composer.lock",
			"mix.lock",
		]) {
			expect(isExcludedFile(name)).toBe(true);
		}
	});

	it("excludes a lockfile that sits in a nested directory", () => {
		expect(isExcludedFile("packages/core/Cargo.lock")).toBe(true);
		expect(isExcludedFile("a/b/c/d/package-lock.json")).toBe(true);
	});

	it("matches case-insensitively", () => {
		expect(isExcludedFile("CARGO.LOCK")).toBe(true);
		expect(isExcludedFile("src/GO.SUM")).toBe(true);
	});

	it("excludes files matching an excluded suffix pattern", () => {
		expect(isExcludedFile("config/app.lock.yml")).toBe(true);
		expect(isExcludedFile("secrets.lock.yaml")).toBe(true);
		expect(isExcludedFile("db-lock.yml")).toBe(true);
		expect(isExcludedFile("service-lock.yaml")).toBe(true);
	});
});

describe("isExcludedFile false-positive guard", () => {
	it("does NOT exclude a source file whose basename merely ends with an excluded name", () => {
		// The bug this locks out: a whole-path `endsWith("go.sum")` excluded these.
		expect(isExcludedFile("service-go.sum")).toBe(false);
		expect(isExcludedFile("app-package-lock.json")).toBe(false);
		expect(isExcludedFile("src/mycargo.lock")).toBe(false);
		expect(isExcludedFile("notyarn.lock")).toBe(false);
	});

	it("does NOT exclude ordinary source files", () => {
		expect(isExcludedFile("src/index.ts")).toBe(false);
		expect(isExcludedFile("Cargo.toml")).toBe(false);
		expect(isExcludedFile("go.mod")).toBe(false);
		expect(isExcludedFile("README.md")).toBe(false);
	});

	it("does NOT treat a directory named like a lockfile as an excluded file", () => {
		expect(isExcludedFile("Cargo.lock/notes.txt")).toBe(false);
	});
});

describe("filterExcludedFiles", () => {
	it("drops only the excluded entries and preserves the rest in order", () => {
		const files = [
			{ filename: "src/a.ts" },
			{ filename: "bun.lock" },
			{ filename: "src/b.ts" },
			{ filename: "packages/x/Cargo.lock" },
			{ filename: "service-go.sum" },
		];
		expect(filterExcludedFiles(files)).toEqual([
			{ filename: "src/a.ts" },
			{ filename: "src/b.ts" },
			{ filename: "service-go.sum" },
		]);
	});
});
