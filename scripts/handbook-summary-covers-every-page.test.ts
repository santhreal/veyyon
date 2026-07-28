/**
 * Every handbook page is reachable from `SUMMARY.md`.
 *
 * WHY THIS SUITE EXISTS. mdbook renders only what `SUMMARY.md` lists. A page on
 * disk that nothing links is invisible: no chapter, no sidebar entry, no place in
 * the next/previous chain, and no build error either. Two hub pages sat like that
 * for long enough to go stale, `features/index.md` (the feature hub) and
 * `why/index.md` (the design hub), both written, both tracked, both unreachable.
 *
 * The link check (`scripts/check-doc-links.ts`) cannot catch this, because it
 * asks the opposite question: it proves every link resolves to a file, and an
 * orphan page has no link to resolve. So this suite walks the tree and requires
 * the reverse direction as well, which is the only way an unreferenced page ever
 * becomes visible.
 *
 * Deleting a page is a legitimate answer to a failure here. Leaving it on disk
 * unreferenced is not.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SRC = path.join(ROOT, "docs", "handbook", "src");
const SUMMARY = path.join(SRC, "SUMMARY.md");

/** Every `.md` file under `docs/handbook/src`, path relative to that directory. */
function pages(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".md")) found.push(path.relative(SRC, full));
		}
	};
	walk(SRC);
	return found.sort();
}

/**
 * The link targets `SUMMARY.md` names, normalized to the same relative form as
 * `pages()`.
 *
 * Only the `./`-prefixed targets count, which is how every entry in this SUMMARY
 * is written; an absolute or external URL is not a page in this tree.
 */
function summaryTargets(): string[] {
	const text = readFileSync(SUMMARY, "utf8");
	return [...text.matchAll(/\]\(\.\/([^)#]+\.md)(?:#[^)]*)?\)/g)].map(match => path.normalize(match[1])).sort();
}

describe("handbook SUMMARY coverage", () => {
	/**
	 * NON-VACUITY: the walk and the parse both found real content.
	 *
	 * Without this the rule below passes when the tree fails to load, which is the
	 * failure mode of every scan-based gate: zero pages are trivially all covered.
	 */
	it("finds the handbook tree and the SUMMARY entries", () => {
		expect(pages().length).toBeGreaterThanOrEqual(90);
		expect(pages()).toContain("SUMMARY.md");
		expect(pages()).toContain("introduction.md");
		expect(summaryTargets().length).toBeGreaterThanOrEqual(90);
		expect(summaryTargets()).toContain("introduction.md");
	});

	/**
	 * No page is on disk without a SUMMARY entry.
	 *
	 * `SUMMARY.md` itself is the table of contents rather than a chapter, so it is
	 * the one exemption.
	 */
	it("lists every page in the tree", () => {
		const targets = new Set(summaryTargets());
		const orphans = pages().filter(page => page !== "SUMMARY.md" && !targets.has(page));

		expect(
			orphans,
			"handbook pages nothing links: add them to docs/handbook/src/SUMMARY.md, or delete them. " +
				"mdbook renders only what SUMMARY lists, so an unreferenced page ships as nothing.",
		).toEqual([]);
	});

	/**
	 * And the other direction still holds: SUMMARY names no page that is gone.
	 *
	 * mdbook creates a missing file rather than failing, so a typo here shows up as
	 * an empty chapter in the built book rather than as a build error.
	 */
	it("names no page that is missing from the tree", () => {
		const present = new Set(pages());
		const dangling = summaryTargets().filter(target => !present.has(target));

		expect(dangling, "SUMMARY entries with no file behind them: mdbook renders these as empty chapters").toEqual([]);
	});

	/**
	 * The two hubs this suite was written for stay linked.
	 *
	 * Named explicitly, because the rule above passes just as well if both are
	 * deleted, and deleting them was not the fix: each is a chapter landing page
	 * that its section reads better for having.
	 */
	it("keeps the feature and design hubs linked", () => {
		const targets = summaryTargets();

		expect(targets).toContain(path.normalize("features/index.md"));
		expect(targets).toContain(path.normalize("why/index.md"));
	});
});
