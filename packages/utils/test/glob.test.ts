import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { globPaths, loadGitignorePatterns, parseGitignorePatterns } from "../src/glob";

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
		// Unrooted with an internal slash → anchored to the .gitignore's directory,
		// NOT match-anywhere. The .gitignore sits at the search base, so `src/foo`
		// relativizes to `src/foo` with no `**/` prefix. Locks
		// FINDING-GITIGNORE-MIDSLASH-PATTERN-OVERMATCH.
		expect(patterns).toContain("src/foo");
		expect(patterns).not.toContain("**/src/foo");
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

/**
 * These lock FINDING-GITIGNORE-MIDSLASH-PATTERN-OVERMATCH. gitignore anchors any
 * pattern that carries a slash other than a trailing one to the directory of the
 * .gitignore itself; only a slash-free name matches at any depth. The parser used
 * to emit `**\/src/generated` for an unrooted mid-slash pattern, which wrongly
 * excluded a nested `pkg/src/generated`. These assert the exact emitted globs so a
 * regression to match-anywhere fails loudly.
 */
describe("parseGitignorePatterns mid-slash anchoring", () => {
	// Absolute so path.join/relative behave like real .gitignore resolution; on
	// Windows path.relative yields backslashes, which the parser normalizes to "/".
	const dir = path.resolve("/veyyon-gitignore-fixture");

	it("expands a slash-free name to a match-anywhere name plus its directory contents", () => {
		// The contents variant (FINDING-GITIGNORE-DIR-NO-TRAILING-SLASH-CONTENTS-LEAK)
		// is what excludes files under a directory ignored without a trailing slash.
		expect(parseGitignorePatterns("node_modules\n", dir, dir)).toEqual(["**/node_modules", "**/node_modules/**"]);
	});

	it("treats a slash-free directory-only rule the same as the bare name", () => {
		expect(parseGitignorePatterns("dist/\n", dir, dir)).toEqual(["**/dist", "**/dist/**"]);
	});

	it("anchors a mid-slash pattern to the .gitignore dir and still excludes its contents", () => {
		expect(parseGitignorePatterns("src/generated\n", dir, dir)).toEqual(["src/generated", "src/generated/**"]);
	});

	it("anchors a mid-slash directory-only pattern together with its contents", () => {
		expect(parseGitignorePatterns("src/gen/\n", dir, dir)).toEqual(["src/gen", "src/gen/**"]);
	});

	it("relativizes a rooted pattern to the search base with its contents", () => {
		expect(parseGitignorePatterns("/build\n", dir, dir)).toEqual(["build", "build/**"]);
	});

	it("drops a mid-slash pattern whose target lies outside the search base", () => {
		// .gitignore in an ancestor, base is a subdir: `foo/bar` points to
		// <ancestor>/foo/bar, which is not under <ancestor>/sub, so it is dropped.
		const sub = path.join(dir, "sub");
		expect(parseGitignorePatterns("foo/bar\n", dir, sub)).toEqual([]);
	});

	it("relativizes a rooted ancestor pattern that points into the search base", () => {
		const sub = path.join(dir, "sub");
		expect(parseGitignorePatterns("/sub/secret\n", dir, sub)).toEqual(["secret", "secret/**"]);
	});

	it("skips comments, blank lines, and negation rules", () => {
		expect(parseGitignorePatterns("# comment\n\n!keep\n", dir, dir)).toEqual([]);
	});
});

describe("globPaths mid-slash gitignore anchoring end-to-end", () => {
	let root = "";
	beforeAll(async () => {
		root = await mkdtemp(path.join(tmpdir(), "veyyon-glob-anchor-"));
		await mkdir(path.join(root, "src"), { recursive: true });
		await mkdir(path.join(root, "pkg", "src"), { recursive: true });
		await writeFile(path.join(root, "src", "secret.ts"), "export const a = 1;\n");
		await writeFile(path.join(root, "pkg", "src", "secret.ts"), "export const b = 2;\n");
		await writeFile(path.join(root, "keep.ts"), "export const c = 3;\n");
		await writeFile(path.join(root, ".gitignore"), "src/secret.ts\n");
	});

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});

	it("excludes only the anchored root src/secret.ts, keeping the nested pkg/src/secret.ts", async () => {
		const found = (await globPaths("**/*.ts", { cwd: root, gitignore: true })).sort();
		// `src/secret.ts` is anchored to the repo root. Before the fix it became
		// `**/src/secret.ts` and wrongly dropped pkg/src/secret.ts as well.
		expect(found).toEqual(["keep.ts", "pkg/src/secret.ts"]);
	});
});

describe("globPaths excludes a gitignored directory named without a trailing slash", () => {
	let root = "";
	beforeAll(async () => {
		root = await mkdtemp(path.join(tmpdir(), "veyyon-glob-dir-"));
		await mkdir(path.join(root, "cache"), { recursive: true });
		await writeFile(path.join(root, "cache", "data.ts"), "export const a = 1;\n");
		await writeFile(path.join(root, "keep.ts"), "export const b = 2;\n");
		// `cache` names a directory but carries no trailing slash.
		await writeFile(path.join(root, ".gitignore"), "cache\n");
	});

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});

	it("excludes the directory's files even though the rule has no trailing slash", async () => {
		const found = (await globPaths("**/*.ts", { cwd: root, gitignore: true })).sort();
		// Locks FINDING-GITIGNORE-DIR-NO-TRAILING-SLASH-CONTENTS-LEAK: before the fix
		// only `**/cache` was emitted, which does not match `cache/data.ts`, so the
		// ignored directory's file leaked into the results.
		expect(found).toEqual(["keep.ts"]);
	});
});
