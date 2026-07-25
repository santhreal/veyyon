/**
 * Locating a project root and naming its cache. resolveProjectRoot is tested
 * with an injected existence predicate, so no real filesystem is touched; the
 * walk-up logic and the marker set are what matter. projectCacheId is a pure
 * function of the absolute path, so its tests assert determinism, separation,
 * and spelling-independence.
 */

import { describe, expect, test } from "bun:test";
import { PROJECT_MARKERS, projectCacheId, resolveProjectRoot } from "../src/project.js";

/** An `exists` predicate that is true only for the exact paths given. */
function existsSet(...present: string[]): (path: string) => boolean {
	const set = new Set(present);
	return path => set.has(path);
}

describe("resolveProjectRoot", () => {
	test("returns the starting directory when it holds a marker", () => {
		const root = resolveProjectRoot("/home/me/app", { exists: existsSet("/home/me/app/.git") });
		expect(root).toBe("/home/me/app");
	});

	test("walks up to the nearest ancestor that holds a marker", () => {
		const root = resolveProjectRoot("/home/me/app/src/database", {
			exists: existsSet("/home/me/app/.git"),
		});
		expect(root).toBe("/home/me/app");
	});

	test("returns the deepest marked directory when markers nest", () => {
		// A submodule with its own .git inside a parent repo: the nearest one wins.
		const root = resolveProjectRoot("/repo/vendor/sub/src", {
			exists: existsSet("/repo/.git", "/repo/vendor/sub/.git"),
		});
		expect(root).toBe("/repo/vendor/sub");
	});

	test("accepts the .argot opt-in marker for a project without git", () => {
		const root = resolveProjectRoot("/data/notes/chapter", {
			exists: existsSet("/data/notes/.argot"),
		});
		expect(root).toBe("/data/notes");
	});

	test("returns undefined when no ancestor holds any marker", () => {
		const root = resolveProjectRoot("/home/me/app/src", { exists: () => false });
		expect(root).toBeUndefined();
	});

	test("respects a custom marker set", () => {
		const root = resolveProjectRoot("/srv/thing/deep", {
			markers: ["package.json"],
			exists: existsSet("/srv/thing/package.json"),
		});
		expect(root).toBe("/srv/thing");
	});

	test("normalizes the starting path before walking", () => {
		const root = resolveProjectRoot("/home/me/app/src/../src/db", {
			exists: existsSet("/home/me/app/.git"),
		});
		expect(root).toBe("/home/me/app");
	});

	test("the default markers are .git and .argot", () => {
		expect([...PROJECT_MARKERS]).toEqual([".git", ".argot"]);
	});
});

describe("projectCacheId", () => {
	test("is deterministic for a given root", () => {
		expect(projectCacheId("/home/me/app")).toBe(projectCacheId("/home/me/app"));
	});

	test("is a lowercase hex string usable as a directory name", () => {
		const id = projectCacheId("/home/me/app");
		expect(id).toMatch(/^[0-9a-f]+$/);
		expect(id.length).toBeGreaterThanOrEqual(16);
	});

	test("differs for different roots", () => {
		expect(projectCacheId("/home/me/app")).not.toBe(projectCacheId("/home/me/other"));
	});

	test("is independent of equivalent spellings of the same path", () => {
		const canonical = projectCacheId("/home/me/app");
		expect(projectCacheId("/home/me/app/")).toBe(canonical);
		expect(projectCacheId("/home/me/./app")).toBe(canonical);
		expect(projectCacheId("/home/me/app/../app")).toBe(canonical);
	});
});
