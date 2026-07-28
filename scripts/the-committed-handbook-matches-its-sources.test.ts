/**
 * The committed handbook under `docs/handbook/book` still says what its sources say.
 *
 * WHY THIS SUITE EXISTS. `docs/handbook/book` is BUILT OUTPUT that is committed, so
 * editing a page under `docs/handbook/src` and not rebuilding leaves the published
 * handbook telling readers something the repository no longer believes. The only
 * thing checking that was the `docs.yml` workflow, which rebuilds with a pinned
 * mdbook and diffs, so the failure arrives after the push, on a commit somebody has
 * already moved on from, and typically on an unrelated release-bump sha. Nothing ran
 * locally, so `bun test` said the tree was fine right up to the point of pushing it.
 *
 * The first run of this suite found `repair/per-model.md` rewritten and its page
 * still carrying the previous wording, describing a section-ordering rule that had
 * changed.
 *
 * WHY IT DOES NOT RUN MDBOOK. A local gate that shells out to `mdbook build` needs
 * mdbook installed at the pinned version, takes seconds, and writes into the tree
 * while other tests read it. Worse, it would SKIP where mdbook is missing, and a
 * gate that silently skips is the thing it is trying to prevent. So this compares
 * the committed HTML against the sources directly: mdbook copies prose through
 * essentially verbatim, so every long plain-prose run in a source page must appear
 * in that page's HTML. That catches the case that actually happens, prose edited and
 * not rebuilt, without needing the renderer.
 *
 * WHAT IT DOES NOT CATCH, stated so nobody trusts it further than it goes: a change
 * only to a heading, a code block, a table cell, a link target, or the theme and
 * asset files. The workflow's full rebuild-and-diff is still the authority. This is
 * the fast local half that turns the common mistake into a red test before the push.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SRC = path.join(ROOT, "docs", "handbook", "src");
const BOOK = path.join(ROOT, "docs", "handbook", "book");

/** Every handbook page source, `SUMMARY.md` excluded: it renders into the nav, not a page. */
function sourcePages(dir: string = SRC, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) sourcePages(full, found);
		else if (entry.name.endsWith(".md") && entry.name !== "SUMMARY.md") found.push(full);
	}
	return found;
}

/** The built page for a source page. */
function bookPageFor(source: string): string {
	return path.join(BOOK, path.relative(SRC, source).replace(/\.md$/, ".html"));
}

/**
 * Readable text from a rendered page.
 *
 * A tag becomes a SPACE rather than nothing, because `<code>x</code>.` and `x.` are
 * different strings and collapsing the tag to nothing would silently join words that
 * the browser shows apart.
 */
function readableText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/g, " ")
		.replace(/<style[\s\S]*?<\/style>/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ");
}

/**
 * Fold the transformations mdbook applies to punctuation.
 *
 * Smart punctuation is on, so `'` arrives as `’`, `"` as `“ ”` and `--` as `–`. All
 * of them fold back to ASCII on BOTH sides, and dash runs collapse so a source `--`
 * matches a rendered en dash.
 */
function foldPunctuation(text: string): string {
	return text
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/[–—]/g, "-")
		.replace(/…/g, "...")
		.replace(/-+/g, "-");
}

/** How many words a run needs before a coincidental match stops being plausible. */
const RUN_WORDS = 8;

/**
 * Long runs of plain prose in a source page.
 *
 * Headings, list items, quotes, tables and fenced code are skipped: mdbook rewrites
 * or decorates all of them, and a rule that tried to match them would fail on pages
 * that are perfectly in sync. Within a paragraph the line is split on every inline
 * markdown marker, so what is compared is the prose BETWEEN the formatting, which
 * passes through untouched. A leading punctuation character is dropped because tag
 * removal leaves a space where the closing tag was.
 */
export function proseRuns(markdown: string): string[] {
	const runs: string[] = [];
	let insideFence = false;
	for (const raw of foldPunctuation(markdown).split("\n")) {
		const line = raw.trim();
		if (line.startsWith("```")) {
			insideFence = !insideFence;
			continue;
		}
		if (insideFence || !line) continue;
		if (/^[#>|]/.test(line) || /^[-*+]\s/.test(line) || /^\d+\.\s/.test(line)) continue;
		for (const chunk of line.split(/[`*_[\]()<>|~\\{}]+/)) {
			const words = chunk
				.replace(/^[^\p{L}\p{N}]+/u, "")
				.trim()
				.split(/\s+/)
				.filter(Boolean);
			if (words.length >= RUN_WORDS) runs.push(words.join(" "));
		}
	}
	return runs;
}

interface Stale {
	page: string;
	run: string;
}

function staleRuns(): { checked: number; stale: Stale[] } {
	const stale: Stale[] = [];
	let checked = 0;
	for (const source of sourcePages()) {
		const page = bookPageFor(source);
		const relative = path.relative(ROOT, page);
		if (!fs.existsSync(page)) {
			stale.push({ page: relative, run: "(no built page at all)" });
			continue;
		}
		const rendered = foldPunctuation(readableText(fs.readFileSync(page, "utf8")));
		for (const run of proseRuns(fs.readFileSync(source, "utf8"))) {
			checked += 1;
			if (!rendered.includes(run)) stale.push({ page: relative, run });
		}
	}
	return { checked, stale };
}

describe("the committed handbook matches its sources", () => {
	/**
	 * The scan reads both trees. A walk that found no pages, or an extractor that
	 * produced no runs, would satisfy the rule below while comparing nothing, which
	 * is the failure mode every source-scanning gate has.
	 */
	it("reads every handbook page and finds prose in it", () => {
		const pages = sourcePages();
		const { checked } = staleRuns();

		expect(pages.length).toBeGreaterThan(50);
		expect(checked).toBeGreaterThan(1000);
		expect(pages.some(page => path.basename(page) === "subagents.md")).toBe(true);
	});

	/**
	 * The rule. A failure names the page and quotes the sentence that is in the
	 * source and not in the book, and the fix is always the same one command:
	 * `mdbook build docs/handbook`, then commit what it wrote.
	 */
	it("has no page whose source says something the built page does not", () => {
		const { stale } = staleRuns();

		expect(
			stale.map(entry => `${entry.page}: ${entry.run.slice(0, 100)}`),
			"the committed book is behind its source. Run `mdbook build docs/handbook` (v0.5.2, pinned in docs.yml) and commit the result.",
		).toEqual([]);
	});

	/**
	 * Every source page has a built page. A source added without a rebuild produces
	 * no HTML at all, which the rule above reports but which is worth its own check
	 * because the cause and the message differ: nothing to compare rather than a
	 * comparison that failed.
	 */
	it("has a built page for every source page", () => {
		const missing = sourcePages()
			.filter(source => !fs.existsSync(bookPageFor(source)))
			.map(source => path.relative(ROOT, source));

		expect(missing).toEqual([]);
	});
});

describe("the extractor compares prose and not formatting", () => {
	/**
	 * Fenced code is skipped. mdbook wraps it, adds a copy button and syntax
	 * highlighting spans, so a rule that compared it would fail on pages that are
	 * perfectly in sync and the gate would be switched off within the week.
	 */
	it("takes no run out of a fenced code block", () => {
		const source = [
			"```ts",
			"const example = someFunction(withArguments, andMore, andEvenMore, plusOne);",
			"```",
			"This is ordinary prose with more than eight words in it.",
		].join("\n");

		expect(proseRuns(source)).toEqual(["This is ordinary prose with more than eight words in it."]);
	});

	/**
	 * Headings, list items and table rows are skipped for the same reason: mdbook
	 * decorates every one of them.
	 */
	it("takes no run out of a heading, a list item or a table row", () => {
		const source = [
			"# A heading long enough to have more than eight words in it",
			"- a list item long enough to have more than eight words",
			"| a table cell long enough to have more than eight words |",
			"> a quote long enough to have more than eight words in it",
		].join("\n");

		expect(proseRuns(source)).toEqual([]);
	});

	/**
	 * A run stops at an inline marker, so what is compared is the prose between the
	 * formatting. This is why the threshold is eight words rather than a whole
	 * sentence: a paragraph dense with `code spans` has short gaps between them.
	 */
	it("splits a paragraph on inline markdown and keeps the long pieces", () => {
		const source = "The setting `subagent.model` decides which model a spawned agent runs on by default.";

		expect(proseRuns(source)).toEqual(["decides which model a spawned agent runs on by default."]);
	});

	/**
	 * Smart punctuation folds on the source side, which is what makes an apostrophe
	 * match. Without this, every possessive in the handbook reads as stale: mdbook
	 * renders `project's` as `project’s`.
	 */
	it("folds smart punctuation so an apostrophe is not a difference", () => {
		const source = "A subagent inherits that project's configuration when it starts there.";

		expect(proseRuns(source)[0]).toContain("project's");
		expect(foldPunctuation("project’s")).toBe("project's");
		expect(foldPunctuation("gated on – your personality")).toBe("gated on - your personality");
	});

	/**
	 * And a tag becomes a space rather than nothing, so a word ending a code span
	 * does not get glued to the word after it.
	 */
	it("reads a tag as a separator", () => {
		expect(readableText("<p>one<code>two</code>three</p>")).toBe(" one two three ");
	});

	/**
	 * The non-vacuity twin for the whole comparison: a sentence that is NOT in a
	 * page really is reported. Without this, an extractor that returned nothing
	 * would make the rule above pass forever.
	 */
	it("reports a run the page does not contain", () => {
		const page = readableText(fs.readFileSync(bookPageFor(path.join(SRC, "features", "subagents.md")), "utf8"));

		expect(page).not.toContain("this sentence has never appeared in the handbook at all");
	});
});
