import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { globPaths, loadGitignorePatterns } from "../src/glob";

// Real filesystem fixtures — glob.ts drives Bun's `Glob.scan` against actual
// directory trees, so a meaningful test needs actual files, not mocks.
//
//   base/
//     a.ts
//     b.js
//     keep.ts
//     build/out.ts        (gitignored dir)
//     sub/c.ts
//     node_modules/dep/index.ts
//     .git/HEAD
//     .gitignore
let base = "";

beforeAll(async () => {
	base = await mkdtemp(path.join(tmpdir(), "veyyon-glob-"));
	await mkdir(path.join(base, "build"), { recursive: true });
	await mkdir(path.join(base, "sub"), { recursive: true });
	await mkdir(path.join(base, "node_modules", "dep"), { recursive: true });
	await mkdir(path.join(base, ".git"), { recursive: true });
	await writeFile(path.join(base, "a.ts"), "export const a = 1;\n");
	await writeFile(path.join(base, "b.js"), "module.exports = 2;\n");
	await writeFile(path.join(base, "keep.ts"), "export const keep = 3;\n");
	await writeFile(path.join(base, "build", "out.ts"), "export const out = 4;\n");
	await writeFile(path.join(base, "sub", "c.ts"), "export const c = 5;\n");
	await writeFile(path.join(base, "node_modules", "dep", "index.ts"), "export const dep = 6;\n");
	await writeFile(path.join(base, ".git", "HEAD"), "ref: refs/heads/main\n");
	await writeFile(
		path.join(base, ".gitignore"),
		["# a comment", "", "b.js", "build/", "/keep.ts", "/dist/", "src/foo", "!keep.ts"].join("\n"),
	);
});

afterAll(async () => {
	if (base) await rm(base, { recursive: true, force: true });
});

describe("globPaths", () => {
	it("returns matching files relative to cwd, sorted for a stable assertion", async () => {
		const found = (await globPaths("**/*.ts", { cwd: base })).sort();
		// a.ts, keep.ts, sub/c.ts, build/out.ts — node_modules and .git excluded by default.
		expect(found).toEqual(["a.ts", "build/out.ts", "keep.ts", "sub/c.ts"]);
	});

	it("excludes node_modules by default when no pattern references it", async () => {
		const found = await globPaths("**/*.ts", { cwd: base });
		expect(found).not.toContain("node_modules/dep/index.ts");
	});

	it("includes node_modules when the pattern explicitly references it", async () => {
		const found = await globPaths("node_modules/**/*.ts", { cwd: base });
		expect(found).toEqual(["node_modules/dep/index.ts"]);
	});

	it("never returns .git contents", async () => {
		const found = await globPaths("**/*", { cwd: base, dot: true });
		expect(found.some(p => p.startsWith(".git/"))).toBe(false);
	});

	it("applies caller-provided exclude globs on top of the defaults", async () => {
		const found = (await globPaths("**/*.ts", { cwd: base, exclude: ["sub/**", "build/**"] })).sort();
		expect(found).toEqual(["a.ts", "keep.ts"]);
	});

	it("respects .gitignore when gitignore is enabled", async () => {
		const found = (await globPaths("**/*.{ts,js}", { cwd: base, gitignore: true })).sort();
		// .gitignore removes b.js, build/, and the rooted /keep.ts. The trailing `!keep.ts`
		// negation is *skipped* (unsupported), not honored — so the earlier ignore stands.
		expect(found).toEqual(["a.ts", "sub/c.ts"]);
	});

	it("throws the abort reason when the signal is already aborted", async () => {
		const signal = AbortSignal.abort(new Error("caller cancelled"));
		await expect(globPaths("**/*.ts", { cwd: base, signal })).rejects.toThrow("caller cancelled");
	});
});

describe("loadGitignorePatterns", () => {
	it("transforms each .gitignore rule into glob-compatible exclude patterns", async () => {
		const patterns = await loadGitignorePatterns(base);
		// Unrooted, no slash → match anywhere.
		expect(patterns).toContain("**/b.js");
		// Directory-only, unrooted → the dir and its contents.
		expect(patterns).toContain("**/build");
		expect(patterns).toContain("**/build/**");
		// Rooted file → relativized to the base, matched from the root only.
		expect(patterns).toContain("keep.ts");
		// Rooted directory → relativized dir and its contents.
		expect(patterns).toContain("dist");
		expect(patterns).toContain("dist/**");
		// Unrooted with an internal slash → still anchored with **/.
		expect(patterns).toContain("**/src/foo");
	});

	it("skips comments, blank lines, and negation rules", async () => {
		const patterns = await loadGitignorePatterns(base);
		expect(patterns).not.toContain("!keep.ts");
		expect(patterns).not.toContain("# a comment");
		expect(patterns).not.toContain("");
	});

	it("returns an empty list for a directory with no .gitignore in the tree", async () => {
		const empty = await mkdtemp(path.join(tmpdir(), "veyyon-glob-empty-"));
		try {
			// A fresh tmp dir with no .gitignore anywhere up to the filesystem root.
			const patterns = await loadGitignorePatterns(empty);
			expect(patterns).toEqual([]);
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	});
});
