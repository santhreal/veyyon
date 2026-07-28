/**
 * `docs/internal/` is tracked, and exactly one file in it is not.
 *
 * WHY THIS SUITE EXISTS. "Internal docs are gitignored" was written down as a
 * ground rule and was false: `git check-ignore docs/internal` exits 1, and the
 * tree holds dozens of tracked pages (onboarding, testing, releasing, the
 * natives set, the runbooks). Only `design.md` is ignored, because it carries the
 * unpublished brand and design contract and stays on maintainer machines.
 *
 * The stale claim mattered in both directions. Believing it, a contributor writes
 * an internal doc expecting it to stay local and commits it instead. Acting on
 * it, someone "restores consistency" by ignoring the whole tree and untracking
 * every page, which deletes the contributor documentation from the repo.
 *
 * So the arrangement is asserted against git itself rather than against prose:
 * the tree is not ignored, the pages are tracked, and the ignore list still
 * covers `design.md` alone. `docs/internal/README.md` is the tracked place that
 * states this, and the last test holds its wording to the same facts.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

/** The one file in the tree that is deliberately local-only. */
const LOCAL_ONLY = "docs/internal/design.md";

function git(...argv: string[]): { status: number; lines: string[] } {
	const run = spawnSync("git", argv, { cwd: ROOT, encoding: "utf8" });
	return {
		status: run.status ?? 1,
		lines: run.stdout.split("\n").filter(line => line !== ""),
	};
}

describe("docs/internal tracking", () => {
	/**
	 * The directory itself is not ignored.
	 *
	 * `check-ignore` exits 0 when a path IS ignored, so this is the exact command
	 * that disproved the ground rule, kept as the assertion.
	 */
	it("is not an ignored directory", () => {
		expect(git("check-ignore", "docs/internal").status).not.toBe(0);
		expect(git("check-ignore", "docs/internal/README.md").status).not.toBe(0);
	});

	/**
	 * The pages are really in the index, with names asserted rather than a count
	 * alone: a count survives someone untracking the documentation and adding
	 * unrelated files.
	 */
	it("tracks the internal documentation", () => {
		const tracked = git("ls-files", "docs/internal").lines;

		expect(tracked.length).toBeGreaterThanOrEqual(60);
		for (const page of [
			"docs/internal/README.md",
			"docs/internal/onboarding.md",
			"docs/internal/testing.md",
			"docs/internal/releasing.md",
			"docs/internal/native-crates.md",
		]) {
			expect(tracked, `${page} is contributor documentation and belongs in the repo`).toContain(page);
		}
	});

	/**
	 * `design.md` is the only ignored path in the tree.
	 *
	 * It is absent from a fresh clone, so the rule is stated as a subset: whatever
	 * ignored files the tree holds can only be that one. A second ignored internal
	 * doc is either a deliberate decision that belongs in the README table, or a
	 * page someone lost.
	 */
	it("ignores design.md and nothing else in the tree", () => {
		const ignored = git("ls-files", "--others", "--ignored", "--exclude-standard", "docs/internal").lines;

		expect(ignored.filter(entry => entry !== LOCAL_ONLY)).toEqual([]);
		expect(git("check-ignore", LOCAL_ONLY).status, `${LOCAL_ONLY} should stay local-only`).toBe(0);
		expect(git("ls-files", LOCAL_ONLY).lines, "an ignored doc must not also be tracked").toEqual([]);
	});

	/**
	 * And the ignore list names that one file rather than the directory.
	 *
	 * The blanket pattern is the mistake this guards: `docs/internal/` in
	 * `.gitignore` is one line to write and it hides sixty tracked pages from
	 * every future `git add`.
	 */
	it("has no blanket ignore for the directory", async () => {
		const patterns = (await Bun.file(path.join(ROOT, ".gitignore")).text())
			.split("\n")
			.map(line => line.trim())
			.filter(line => line !== "" && !line.startsWith("#") && line.includes("docs/internal"));

		expect(patterns).toEqual([LOCAL_ONLY]);
	});

	/**
	 * The tracked README says what git does.
	 *
	 * This is the page a contributor reads before adding an internal doc, and it is
	 * where the correct statement lives now that the claim has been fixed.
	 */
	it("is described accurately by docs/internal/README.md", async () => {
		const readme = await Bun.file(path.join(ROOT, "docs", "internal", "README.md")).text();

		expect(readme).toContain("design.md _(local-only, gitignored)_");
		expect(readme, "the README must not claim the whole tree is ignored").not.toMatch(
			/docs\/internal\/?[^\n]*\bgitignored\b/,
		);
	});
});
