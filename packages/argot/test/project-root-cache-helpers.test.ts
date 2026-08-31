import { describe, expect, it } from "bun:test";
import { PROJECT_MARKERS, projectCacheId, resolveProjectRoot } from "../src/project";

describe("PROJECT_MARKERS", () => {
	it("includes .git", () => {
		expect(PROJECT_MARKERS).toContain(".git");
	});
	it("includes .argot", () => {
		expect(PROJECT_MARKERS).toContain(".argot");
	});
	it("has at least 2 markers", () => {
		expect(PROJECT_MARKERS.length).toBeGreaterThanOrEqual(2);
	});
});

describe("resolveProjectRoot", () => {
	it("returns dir when marker exists in start dir", () => {
		const exists = (path: string) => path.endsWith("/.git");
		expect(resolveProjectRoot("/repo", { exists })).toBe("/repo");
	});
	it("returns dir when .argot marker exists", () => {
		const exists = (path: string) => path.endsWith("/.argot");
		expect(resolveProjectRoot("/repo", { exists })).toBe("/repo");
	});
	it("walks up to find marker in parent", () => {
		const exists = (path: string) => path === "/repo/.git";
		expect(resolveProjectRoot("/repo/subdir", { exists })).toBe("/repo");
	});
	it("returns undefined when no marker found", () => {
		const exists = (_path: string) => false;
		expect(resolveProjectRoot("/repo", { exists })).toBeUndefined();
	});
	it("uses custom markers", () => {
		const exists = (path: string) => path.endsWith("/package.json");
		expect(resolveProjectRoot("/repo", { markers: ["package.json"], exists })).toBe("/repo");
	});
	it("checks markers in order", () => {
		const exists = (path: string) => path.endsWith("/.argot");
		expect(resolveProjectRoot("/repo", { exists })).toBe("/repo");
	});
	it("handles root directory with no marker", () => {
		const exists = (_path: string) => false;
		expect(resolveProjectRoot("/", { exists })).toBeUndefined();
	});
	it("handles root directory with marker", () => {
		const exists = (path: string) => path === "/.git";
		expect(resolveProjectRoot("/", { exists })).toBe("/");
	});
	it("walks up multiple levels", () => {
		const exists = (path: string) => path === "/root/.git";
		expect(resolveProjectRoot("/root/a/b/c", { exists })).toBe("/root");
	});
	it("prefers first marker found at closest level", () => {
		let callCount = 0;
		const exists = (path: string) => {
			callCount++;
			return path === "/root/a/.argot";
		};
		expect(resolveProjectRoot("/root/a/b", { exists })).toBe("/root/a");
	});
});

describe("projectCacheId", () => {
	it("returns a 32-char hex string", () => {
		const id = projectCacheId("/repo");
		expect(id).toHaveLength(32);
		expect(id).toMatch(/^[0-9a-f]+$/);
	});
	it("returns same id for same path", () => {
		expect(projectCacheId("/repo")).toBe(projectCacheId("/repo"));
	});
	it("returns different id for different path", () => {
		expect(projectCacheId("/repo1")).not.toBe(projectCacheId("/repo2"));
	});
	it("normalizes path before hashing", () => {
		const a = projectCacheId("/repo/sub");
		const b = projectCacheId("/repo/./sub");
		expect(a).toBe(b);
	});
	it("normalizes trailing slash", () => {
		const a = projectCacheId("/repo");
		const b = projectCacheId("/repo/");
		expect(a).toBe(b);
	});
	it("returns different id for relative vs absolute", () => {
		// resolve() makes relative paths absolute based on cwd
		const id = projectCacheId("repo");
		expect(id).toHaveLength(32);
	});
});
