/**
 * A doc gate survives a file that git tracks but the working tree no longer has.
 *
 * WHY THIS SUITE EXISTS. `git ls-files` reports the INDEX. A file deleted (or
 * renamed away) in the working tree but not yet committed is still listed, so
 * every gate that lists tracked docs and then reads each one dies on an
 * ordinary, intended state: a refactor mid-flight, a branch that removes a doc,
 * a shared worktree. It happened here — `install-methods-coverage.test.ts`
 * failed with a raw
 * `ENOENT: ... packages/agent/src/compaction/prompts/auto-handoff-threshold-focus.md`
 * while a concurrent refactor had that directory staged for deletion. The
 * failure named a file whose absence was the intended change and said nothing
 * about install instructions, which is the rule it was checking.
 *
 * Four listers had this shape and only `check-doc-freshness.ts` handled it, so
 * this was one defect surfacing in three places. `existingOnly` is now the one
 * owner and the other listers go through it.
 *
 * The asymmetry with `check-doc-freshness.ts` is deliberate and is asserted
 * below, because it is the kind of thing a later cleanup would "unify" away:
 * that gate REPORTS a missing file rather than skipping it, since it asks
 * whether docs are being maintained and a vanished doc is exactly what it should
 * say out loud. The link/import/install gates ask whether a document's CONTENT
 * breaks a rule, and a document that does not exist has no content to break one.
 * Different questions, different right answers.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { checkFreshness } from "./check-doc-freshness";
import { existingOnly } from "./check-doc-links";

let root: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "veyyon-tracked-deleted-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function write(rel: string, text: string): void {
	const abs = path.join(root, rel);
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, text);
}

describe("existingOnly", () => {
	it("drops a listed path that is not on disk and keeps the rest, in order", () => {
		// The defect. The deleted entry is removed; nothing else moves, because a
		// lister's order is meaningful to the gates that report per-file results.
		write("docs/a.md", "a");
		write("docs/c.md", "c");
		expect(existingOnly(root, ["docs/a.md", "docs/gone.md", "docs/c.md"])).toEqual(["docs/a.md", "docs/c.md"]);
	});

	it("returns everything when nothing is missing", () => {
		write("docs/a.md", "a");
		write("README.md", "r");
		expect(existingOnly(root, ["docs/a.md", "README.md"])).toEqual(["docs/a.md", "README.md"]);
	});

	it("returns empty when the whole listing is gone, rather than throwing", () => {
		// A branch that deletes a docs tree wholesale must produce a clean empty
		// run, not a crash.
		expect(existingOnly(root, ["docs/a.md", "docs/b.md"])).toEqual([]);
	});

	it("keeps a directory that exists at the listed path", () => {
		// `existsSync` is the question being asked; the caller decides what to do
		// with a non-file. Pinned so a later change to `statSync().isFile()` is a
		// deliberate decision rather than a silent narrowing.
		mkdirSync(path.join(root, "docs", "nested"), { recursive: true });
		expect(existingOnly(root, ["docs/nested"])).toEqual(["docs/nested"]);
	});

	it("handles an empty listing", () => {
		expect(existingOnly(root, [])).toEqual([]);
	});

	it("resolves against the given root, not the process cwd", () => {
		// The gates run from the repo root and pass repo-relative paths; resolving
		// against cwd would make the guard depend on where bun was invoked.
		write("docs/a.md", "a");
		expect(existingOnly(root, ["docs/a.md"])).toEqual(["docs/a.md"]);
		expect(existingOnly(path.join(root, "docs"), ["docs/a.md"])).toEqual([]);
	});
});

describe("check-doc-freshness keeps the other answer on purpose", () => {
	it("reports a tracked-but-deleted doc instead of skipping it", () => {
		// The deliberate asymmetry. If this ever starts skipping, a doc that
		// disappeared stops being reported by the gate whose whole subject is
		// whether docs are being kept up to date.
		write("docs/internal/kept.md", "# Kept\n\n_Last reviewed: 2026-07-25_\n");
		const result = checkFreshness(root, ["docs/internal/kept.md", "docs/internal/vanished.md"]);
		expect(result.missing).toEqual(["docs/internal/vanished.md"]);
		expect(result.filesChecked).toBe(1);
	});
});
