/**
 * The source-path gate for documentation.
 *
 * The gate exists because `prompt-blocks.ts` was split into two modules and
 * `docs/system-prompt-customization.md` went on naming the old file in three
 * places, one of them the line telling a contributor which file to edit. No gate
 * in the repo could see it: doc-links strips inline code spans on purpose,
 * doc-imports only reads `import` statements, and doc-freshness only knows
 * whether a verification stamp is stale.
 *
 * These tests are about the two things such a gate gets wrong. It can be too
 * eager -- flagging prose, globs, shell pipelines, and package-relative paths in
 * a package's own README -- which makes its failures usually wrong and gets it
 * switched off. Or it can be vacuous: a ratchet whose baseline quietly swallows
 * everything, or a matcher that finds nothing at all, both report a clean run.
 * So every rule below is pinned from BOTH sides, with real values.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listTrackedMarkdown } from "./check-doc-links";
import {
	baselineKey,
	checkDocPaths,
	DEAD_PATH_BASELINE,
	extractCodeSpanPaths,
	looksLikeSourcePath,
} from "./check-doc-paths";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "doc-paths-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function write(rel: string, content: string): void {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

describe("looksLikeSourcePath", () => {
	/**
	 * The positive half. Every form here appears in this repo's docs, and each one
	 * is a path a rename can break, so a gate that rejected any of them would have
	 * missed the rot it was built for.
	 */
	it("accepts repo-relative file paths, directories, and line locators", () => {
		expect(looksLikeSourcePath("packages/coding-agent/src/system-prompt.ts")).toBe(true);
		expect(looksLikeSourcePath("docs/internal/testing.md")).toBe(true);
		expect(looksLikeSourcePath("scripts/check-doc-links.ts")).toBe(true);
		expect(looksLikeSourcePath(".github/workflows/docs.yml")).toBe(true);
		// A directory, which has no extension to match on.
		expect(looksLikeSourcePath("packages/coding-agent/test/fixtures/")).toBe(true);
		// A `file:line` locator still names one real file.
		expect(looksLikeSourcePath("packages/utils/src/dirs.ts:1033")).toBe(true);
		expect(looksLikeSourcePath("packages/utils/src/dirs.ts:1033:7")).toBe(true);
	});

	/**
	 * The negative half, which is what decides whether anyone keeps the gate on.
	 * Each rejection below is a real span from this repo's docs that is NOT a path:
	 * a model selector, a home-relative config file, a glob, a placeholder, and a
	 * shell pipeline whose two halves both exist while the span as a whole does not.
	 */
	it("rejects prose, selectors, globs, placeholders, and shell fragments", () => {
		expect(looksLikeSourcePath("anthropic/claude-opus-4")).toBe(false);
		expect(looksLikeSourcePath("~/.veyyon/config.yml")).toBe(false);
		expect(looksLikeSourcePath("packages/*/test/fixtures/")).toBe(false);
		expect(looksLikeSourcePath("packages/coding-agent/src/tools/<name>.ts")).toBe(false);
		expect(looksLikeSourcePath("scripts/demos/render-rail.ts | scripts/demos/render-proof.ts")).toBe(false);
		// Extensionless and not a directory: far more likely a package name than a file.
		expect(looksLikeSourcePath("packages/coding-agent")).toBe(false);
		// Not under any source root, so not this repo's path to resolve.
		expect(looksLikeSourcePath("src/index.ts")).toBe(false);
	});

	/**
	 * `.veyyon/` is deliberately not a source root. It names a tracked directory
	 * (`.veyyon/skills/`) AND the config a USER writes in their own project
	 * (`.veyyon/mcp.json`), and every configuration doc teaches the second. Treating
	 * the prefix as a repo path turns a whole page of correct documentation red.
	 */
	it("does not treat project-config paths as repo paths", () => {
		expect(looksLikeSourcePath(".veyyon/mcp.json")).toBe(false);
		expect(looksLikeSourcePath(".veyyon/settings.json")).toBe(false);
		expect(looksLikeSourcePath(".veyyon/skills/ui/SKILL.md")).toBe(false);
	});
});

describe("extractCodeSpanPaths", () => {
	it("reports the line each span sits on, and only spans that look like paths", () => {
		const found = extractCodeSpanPaths("intro\nsee `packages/a/src/x.ts` and `not a path`\n\nalso `docs/y.md`\n");
		expect(found).toEqual([
			{ line: 2, target: "packages/a/src/x.ts", inFence: false },
			{ line: 4, target: "docs/y.md", inFence: false },
		]);
	});

	/**
	 * Fenced blocks hold examples, hypothetical trees, and other repos' layouts. A
	 * gate that failed on those would be wrong more often than right, so a span
	 * inside a fence is marked rather than resolved -- and marked, not deleted, so
	 * the runner can COUNT it. A category that is silently discarded cannot be told
	 * apart from a category that was empty.
	 */
	it("marks spans inside fenced blocks instead of dropping them", () => {
		const found = extractCodeSpanPaths("```\nrun `packages/a/src/x.ts`\n```\nreal `docs/y.md`\n");
		expect(found).toEqual([
			{ line: 2, target: "packages/a/src/x.ts", inFence: true },
			{ line: 4, target: "docs/y.md", inFence: false },
		]);
	});

	it("closes a fence only on a matching marker, so a nested block does not reopen the document", () => {
		const found = extractCodeSpanPaths("~~~\n`docs/inside.md`\n```\n`docs/still-inside.md`\n~~~\n`docs/out.md`\n");
		expect(found.filter(f => f.inFence).map(f => f.target)).toEqual(["docs/inside.md", "docs/still-inside.md"]);
		expect(found.filter(f => !f.inFence).map(f => f.target)).toEqual(["docs/out.md"]);
	});
});

describe("checkDocPaths", () => {
	it("passes a path that exists and fails one that does not, naming file, line, and span", () => {
		write("packages/a/src/real.ts", "export {};\n");
		write("docs/one.md", "first\nthe module is `packages/a/src/real.ts`\nand `packages/a/src/gone.ts` is not\n");

		const result = checkDocPaths(root, ["docs/one.md"]);
		expect(result.filesChecked).toBe(1);
		expect(result.pathsChecked).toBe(2);
		expect(result.dead).toEqual([
			{
				file: "docs/one.md",
				line: 3,
				target: "packages/a/src/gone.ts",
				reason: "no such file or directory in the working tree",
			},
		]);
	});

	/**
	 * A README inside a package writes its own paths package-relative, because that
	 * is how its reader runs them: `packages/catalog/README.md` says "regenerate
	 * with `scripts/generate-models.ts`" and the file is at
	 * `packages/catalog/scripts/generate-models.ts`. Judging those against the repo
	 * root alone reported every in-package README as broken, which was the
	 * false-positive class that would have made this gate unusable.
	 */
	it("resolves an in-package doc's paths against its own package as well as the root", () => {
		write("packages/b/scripts/gen.ts", "export {};\n");
		write("packages/b/README.md", "regenerate with `scripts/gen.ts`\n");
		expect(checkDocPaths(root, ["packages/b/README.md"]).dead).toEqual([]);

		// The same span in a doc OUTSIDE the package has no package to be relative to,
		// so its reader cannot follow it and it must fail.
		write("docs/two.md", "regenerate with `scripts/gen.ts`\n");
		expect(checkDocPaths(root, ["docs/two.md"]).dead).toHaveLength(1);
	});

	it("counts fenced spans as skipped rather than checking or discarding them", () => {
		write("docs/three.md", "```\n`packages/a/src/imaginary.ts`\n```\n");
		const result = checkDocPaths(root, ["docs/three.md"]);
		expect(result.skippedInFence).toBe(1);
		expect(result.pathsChecked).toBe(0);
		expect(result.dead).toEqual([]);
	});

	it("accepts a directory span and a line locator, resolving the file behind them", () => {
		write("packages/a/src/dir/keep.ts", "export {};\n");
		write("docs/four.md", "see `packages/a/src/dir/` and `packages/a/src/real.ts:12`\n");
		expect(checkDocPaths(root, ["docs/four.md"]).dead).toEqual([]);
	});
});

describe("the repository's own docs", () => {
	const repoRoot = path.resolve(import.meta.dir, "..");
	const result = checkDocPaths(repoRoot, listTrackedMarkdown(repoRoot));

	/**
	 * The gate binds the real tree. Anything dead and NOT in the baseline is rot
	 * that landed after the ratchet was set, and the message names it so the fix is
	 * obvious: either the doc points at the wrong path, or the path moved.
	 */
	it("names no dead source path outside the ratchet baseline", () => {
		const baseline = new Set(DEAD_PATH_BASELINE);
		const unexpected = result.dead.filter(d => !baseline.has(baselineKey(d)));
		expect(unexpected.map(d => `${d.file}:${d.line}: ${d.target}`)).toEqual([]);
	});

	/**
	 * Anti-vacuity, and the reason this suite is not just green paint. If the
	 * matcher stopped recognising paths, or `listTrackedMarkdown` returned nothing,
	 * the test above would pass while checking zero paths. Pinning a floor on the
	 * volume, plus one path this file knows exists, makes that failure loud.
	 */
	it("actually checks the docs it claims to, rather than passing on an empty set", () => {
		expect(result.filesChecked).toBeGreaterThan(300);
		expect(result.pathsChecked).toBeGreaterThan(1000);
		// The gate's own script, named in its own doc comment, is a path it must resolve.
		expect(fs.existsSync(path.join(repoRoot, "scripts/check-doc-paths.ts"))).toBe(true);
	});

	/**
	 * A ratchet whose baseline rots into a no-op has stopped ratcheting. Every entry
	 * must still match a live finding: once a doc is fixed, or edited so its line
	 * number moves, the entry is dead weight that silently widens the exemption.
	 * The message tells the reader to delete it rather than renumber it.
	 */
	it("carries no stale baseline entry", () => {
		const matched = new Set(result.dead.map(baselineKey));
		const stale = DEAD_PATH_BASELINE.filter(entry => !matched.has(entry));
		expect(stale).toEqual([]);
	});

	/**
	 * The baseline is a promise to remove debt, not a place to park it. Bounding its
	 * size makes "add an entry" a visible choice rather than the cheap way out of a
	 * red gate; it is deliberately just above the current count.
	 */
	it("keeps the baseline small enough that adding to it is a decision", () => {
		expect(DEAD_PATH_BASELINE.length).toBeLessThanOrEqual(15);
		expect(new Set(DEAD_PATH_BASELINE).size).toBe(DEAD_PATH_BASELINE.length);
	});
});
