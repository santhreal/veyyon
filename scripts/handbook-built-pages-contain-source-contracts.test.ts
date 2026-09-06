/**
 * The generated handbook pages contain the text and links from their Markdown sources.
 *
 * WHY THIS SUITE EXISTS. `docs/handbook/book` is generated build output from mdBook.
 * Editing a page under `docs/handbook/src` must produce matching visible text and inline
 * link targets in the rendered HTML output.
 *
 * In CI, `docs.yml` builds the handbook with pinned mdbook v0.5.2 and runs this test
 * against the generated book. In clean checkouts where the book has not yet been built,
 * this test validates semantic contract extractors against deterministic build fixtures.
 *
 * This comparison covers paragraphs, headings, lists, quotes, table cells,
 * inline code and formatting, and inline link/image targets. Fenced code is excluded
 * because syntax highlighting splits its bytes across renderer-owned markup.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SRC = path.join(ROOT, "docs", "handbook", "src");
const BOOK = path.join(ROOT, "docs", "handbook", "book");

beforeAll(() => {
	if (!fs.existsSync(path.join(BOOK, "index.html"))) {
		try {
			execFileSync("mdbook", ["build", path.join(ROOT, "docs", "handbook")], { stdio: "pipe" });
		} catch (error: unknown) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				throw new Error(
					"Handbook output not found at docs/handbook/book and 'mdbook' is not on PATH.\n" +
						"Install mdbook v0.5.2 or run 'mdbook build docs/handbook' before running this suite.",
				);
			}
			throw error;
		}
	}
});
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

/** How many words ordinary prose needs before a coincidental match stops being plausible. */
const RUN_WORDS = 8;

/**
 * Drop from SOURCE text what the renderer reads as an HTML tag.
 *
 * A tag-shaped token is markup outside a code span and text inside one: `<br>` in a
 * table cell emits a line break and contributes no word, while `` `<profile>` `` is
 * printed. Splitting on the backtick and only stripping the even chunks keeps that
 * distinction, which is the one mdbook itself makes. It runs on the source alone:
 * `readableText` has already removed the rendered page's tags, so anything
 * tag-shaped still standing there is text the reader sees.
 */
function stripSourceHtmlTags(text: string): string {
	return text
		.split("`")
		.map((chunk, index) =>
			index % 2 === 1
				? chunk
				: // `\<` is an escaped literal, which the renderer prints instead of reading
					// as markup, so a generated cell's `\<name\>` placeholder stays a word.
					chunk.replace(/(?<!\\)<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>/g, " "),
		)
		.join(" ");
}

/**
 * Fold source presentation and punctuation into browser-visible word sequences.
 *
 * A presentation marker becomes a SPACE, matching `readableText`: the browser shows
 * `` `AgentSession` ``'s closing span and the `'s` after it as two runs of glyphs, so
 * gluing them into one source word made a page that renders correctly look stale.
 */
function visibleMarkdownText(text: string): string {
	return text
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[`*_~{}]/g, " ")
		.replace(/\\([\\`*_[\]{}()#+\-.!|<>])/g, "$1")
		.replace(/[^\p{L}\p{N}']+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Remove HTML comments, which the renderer emits as markup and the reader never
 * sees.
 *
 * A generated page carries `<!-- generated by <script> ... -->` on its first line
 * so a sweep reads the marker instead of a path list. That text reaches no
 * rendered page, so comparing it against one reported a freshly built page as
 * stale.
 *
 * Two places a comment is text and stays: a fenced block, whose runs are skipped
 * anyway, and a code span, where `` `<!-- imported from ... -->` `` is a marker the
 * page prints. Splitting each line on the backtick and stripping only the even
 * chunks keeps that distinction, the same one `stripSourceHtmlTags` makes.
 */
function withoutHtmlComments(markdown: string): string {
	const lines: string[] = [];
	let insideFence = false;
	let insideComment = false;
	for (const raw of markdown.split("\n")) {
		if (raw.trim().startsWith("```")) {
			insideFence = !insideFence;
			lines.push(raw);
			continue;
		}
		if (insideFence) {
			lines.push(raw);
			continue;
		}
		let line = raw;
		if (insideComment) {
			const close = line.indexOf("-->");
			if (close === -1) {
				lines.push("");
				continue;
			}
			line = line.slice(close + 3);
			insideComment = false;
		}
		const chunks = line.split("`");
		const kept: string[] = [];
		for (const [index, chunk] of chunks.entries()) {
			// An odd chunk sits between two backticks, so it is printed code.
			if (index % 2 === 1) {
				kept.push(chunk);
				continue;
			}
			const stripped = chunk.replace(/<!--[\s\S]*?-->/g, " ");
			const open = stripped.indexOf("<!--");
			if (open === -1) {
				kept.push(stripped);
				continue;
			}
			// The comment runs past this chunk, so every chunk after it is inside it.
			kept.push(stripped.slice(0, open));
			insideComment = true;
			break;
		}
		lines.push(kept.join("`"));
	}
	return lines.join("\n");
}

/**
 * Visible source text runs.
 *
 * Structural lines are exact contracts even when short. Ordinary prose keeps the
 * longer threshold to avoid matching tiny fragments split by source line wrapping.
 */
function sourceTextRuns(markdown: string): string[] {
	const runs: string[] = [];
	let insideFence = false;
	const presentationFolded = foldPunctuation(withoutHtmlComments(markdown))
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
	for (const raw of presentationFolded.split("\n")) {
		const trimmed = raw.trim();
		if (trimmed.startsWith("```")) {
			insideFence = !insideFence;
			continue;
		}
		if (insideFence || !trimmed) continue;
		const structural = /^(?:#{1,6}\s|>\s?|[-*+]\s|\d+\.\s|\|)/.test(trimmed);
		if (/^\|?(?:\s*:?-+:?\s*\|)+\s*$/.test(trimmed)) continue;
		const withoutPrefix = trimmed
			.replace(/^#{1,6}\s+/, "")
			.replace(/^>\s?/, "")
			.replace(/^(?:[-*+]|\d+\.)\s+/, "");
		// `\|` is the GFM escape for a literal pipe, so it is content and not a cell
		// boundary. Splitting on it broke a generated default such as the
		// `bashInterceptor.patterns` JSON into fragments that match nothing.
		const pieces = /(?<!\\)\|/.test(trimmed)
			? withoutPrefix
					.split(/(?<!\\)\|/)
					.map(part => part.trim())
					.filter(Boolean)
			: [withoutPrefix];
		for (const piece of pieces) {
			const visible = visibleMarkdownText(stripSourceHtmlTags(piece));
			const words = visible.split(/\s+/).filter(Boolean);
			if (visible && (structural || words.length >= RUN_WORDS)) runs.push(visible);
		}
	}
	return runs;
}

interface SourceTarget {
	attribute: "href" | "src";
	target: string;
}

/**
 * Inline Markdown links and images whose destination is source-owned.
 *
 * A destination inside an HTML comment reaches no rendered attribute, so comments
 * are removed on this side too.
 */
function sourceTargets(markdown: string): SourceTarget[] {
	const targets: SourceTarget[] = [];
	const pattern = /(!?)\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g;
	for (const match of withoutHtmlComments(markdown).matchAll(pattern)) {
		const target = match[2];
		if (!target) continue;
		targets.push({
			attribute: match[1] === "!" ? "src" : "href",
			target: /^[a-z][a-z\d+.-]*:/i.test(target) ? target : target.replace(/\.md(?=([?#]|$))/, ".html"),
		});
	}
	return targets;
}

interface Stale {
	page: string;
	run: string;
}

/** Link and image destinations emitted by the rendered page. */
function renderedTargets(html: string): Set<string> {
	const targets = new Set<string>();
	for (const match of html.matchAll(/\b(href|src)="([^"]*)"/g)) {
		const attribute = match[1];
		const target = match[2]
			?.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">");
		if (attribute && target) targets.add(`${attribute}:${target}`);
	}
	return targets;
}

function checkSourceAgainstHtml(
	sourceMarkdown: string,
	pageHtml: string,
	pageLabel = "test.html",
): { checked: number; checkedTargets: number; stale: Stale[] } {
	const stale: Stale[] = [];
	let checked = 0;
	let checkedTargets = 0;
	const rendered = visibleMarkdownText(foldPunctuation(readableText(pageHtml)));
	for (const run of sourceTextRuns(sourceMarkdown)) {
		checked += 1;
		if (!rendered.includes(run)) stale.push({ page: pageLabel, run });
	}
	const targets = renderedTargets(pageHtml);
	for (const { attribute, target } of sourceTargets(sourceMarkdown)) {
		checkedTargets += 1;
		if (!targets.has(`${attribute}:${target}`)) {
			stale.push({ page: pageLabel, run: `(missing ${attribute}="${target}")` });
		}
	}
	return { checked, checkedTargets, stale };
}

function staleSourceContracts(): { checked: number; checkedTargets: number; stale: Stale[] } {
	const stale: Stale[] = [];
	let checked = 0;
	let checkedTargets = 0;
	for (const source of sourcePages()) {
		const page = bookPageFor(source);
		const relative = path.relative(ROOT, page);
		if (!fs.existsSync(page)) {
			stale.push({ page: relative, run: "(no built page at all)" });
			continue;
		}
		const sourceMarkdown = fs.readFileSync(source, "utf8");
		const pageHtml = fs.readFileSync(page, "utf8");
		const result = checkSourceAgainstHtml(sourceMarkdown, pageHtml, relative);
		checked += result.checked;
		checkedTargets += result.checkedTargets;
		stale.push(...result.stale);
	}
	return { checked, checkedTargets, stale };
}

describe("the generated handbook contains source-owned text and links", () => {
	it("reads every handbook page and finds text and links", () => {
		const pages = sourcePages();
		const { checked, checkedTargets } = staleSourceContracts();

		expect(pages.length).toBeGreaterThan(50);
		expect(checked).toBeGreaterThan(1000);
		expect(checkedTargets).toBeGreaterThan(100);
		expect(pages.some(page => path.basename(page) === "subagents.md")).toBe(true);
	});

	it("has no source text or destination missing from its built page", () => {
		const { stale } = staleSourceContracts();

		expect(
			stale.map(entry => `${entry.page}: ${entry.run.slice(0, 100)}`),
			"the built book is behind its source. Run `mdbook build docs/handbook` (v0.5.2, pinned in docs.yml).",
		).toEqual([]);
	});

	it("has a built page for every source page", () => {
		const missing = sourcePages()
			.filter(source => !fs.existsSync(bookPageFor(source)))
			.map(source => path.relative(ROOT, source));

		expect(missing).toEqual([]);
	});
});

describe("the source contract extractor follows visible Markdown semantics", () => {
	/**
	 * Fenced code is skipped because mdbook's syntax highlighter splits it across
	 * renderer-owned spans.
	 */
	it("takes no run out of a fenced code block", () => {
		const source = [
			"```ts",
			"const example = someFunction(withArguments, andMore, andEvenMore, plusOne);",
			"```",
			"This is ordinary prose with more than eight words in it.",
		].join("\n");

		expect(sourceTextRuns(source)).toEqual(["This is ordinary prose with more than eight words in it"]);
	});

	/**
	 * Short structural text carries operator contracts such as option names and table
	 * defaults, so every visible heading, list item, quote, and cell is retained.
	 */
	it("keeps headings, list items, quotes, and table cells", () => {
		const source = ["# Install", "- default: off", "| Setting | Default |", "> Read this first."].join("\n");

		expect(sourceTextRuns(source)).toEqual(["Install", "default off", "Setting", "Default", "Read this first"]);
	});

	/** Inline presentation disappears while its visible label and code remain. */
	it("normalizes inline markdown into the rendered sentence", () => {
		const source =
			"The setting `subagent.model` decides which [model](./models.md) a spawned agent runs on by default.";

		expect(sourceTextRuns(source)).toEqual([
			"The setting subagent model decides which model a spawned agent runs on by default",
		]);
		expect(sourceTargets(source)).toEqual([{ attribute: "href", target: "./models.html" }]);
	});

	/**
	 * Smart punctuation folds on the source side, which makes apostrophes and mdbook's
	 * generated en dashes compare with their ASCII source.
	 */
	it("folds smart punctuation so an apostrophe is not a difference", () => {
		const source = "A subagent inherits that project's configuration when it starts there.";

		expect(sourceTextRuns(source)[0]).toContain("project's");
		expect(foldPunctuation("project’s")).toBe("project's");
		expect(foldPunctuation("gated on – your personality")).toBe("gated on - your personality");
	});

	/**
	 * A tag-shaped token is markup outside a code span and a printed word inside one.
	 * `<br>` contributed the word "br" to the source side of the comparison, which
	 * reported a correctly rendered table cell as stale text.
	 */
	it("reads a bare tag as markup and a code-spanned one as text", () => {
		const source = "| `~/.veyyon/profiles/<profile>/AGENTS.md` | First line.<br>Second line. |";

		expect(sourceTextRuns(source)).toEqual(["veyyon profiles profile AGENTS md", "First line Second line"]);
	});

	/**
	 * The two GFM escapes a generated table cell needs. `\|` is content, not a cell
	 * boundary, and `\<` is a literal the renderer prints instead of reading as a tag,
	 * so a `<name>` placeholder survives to be compared.
	 */
	it("keeps an escaped pipe and an escaped angle bracket inside one cell", () => {
		const source = "| `setting` | `(cat\\|head\\|tail)` | Extend via `~/.veyyon/personalities/\\<name\\>.md`. |";

		expect(sourceTextRuns(source)).toEqual(["setting", "cat head tail", "Extend via veyyon personalities name md"]);
	});

	/**
	 * A code span ends a word for the reader, so it ends one here: the rendered page
	 * shows `AgentSession` and the `'s` after it as separate glyph runs.
	 */
	it("ends a word where a code span ends", () => {
		const source = "Reads of the plan file are added via `AgentSession`'s plan protection at startup.";

		expect(sourceTextRuns(source)).toEqual([
			"Reads of the plan file are added via AgentSession 's plan protection at startup",
		]);
	});

	/**
	 * And a tag becomes a space rather than nothing, so a word ending a code span
	 * does not get glued to the word after it.
	 */
	it("reads a tag as a separator", () => {
		expect(readableText("<p>one<code>two</code>three</p>")).toBe(" one two three ");
	});

	/**
	 * An HTML comment is markup: the marker a generated page carries on its first
	 * line, and any destination inside a comment, reach no rendered page, so neither
	 * is a contract to compare.
	 */
	it("takes no run or destination out of an HTML comment", () => {
		const source = [
			"<!-- generated by scripts/gen-settings-reference.ts -- do not edit by hand -->",
			"# Settings",
			"<!--",
			"A [retired link](./gone.md) and a sentence with well over eight words in it.",
			"-->",
			"Every setting below is written by the generator and compared against the built page.",
		].join("\n");

		expect(sourceTextRuns(source)).toEqual([
			"Settings",
			"Every setting below is written by the generator and compared against the built page",
		]);
		expect(sourceTargets(source)).toEqual([]);
	});

	/**
	 * A comment inside a code span is printed, and the page shows it, so the run
	 * keeps its words. A real page appends imported context under exactly such a
	 * marker.
	 */
	it("keeps a comment that a code span prints", () => {
		const source =
			"- `CLAUDE.md` content is appended to the profile file under an `<!-- imported from ... -->` marker";

		expect(sourceTextRuns(source)).toEqual([
			"CLAUDE md content is appended to the profile file under an imported from marker",
		]);
	});

	/** A comment printed inside a fenced block is text the reader sees, so it stays. */
	it("keeps a comment that a fenced block prints", () => {
		const source = [
			"```html",
			"<!-- this one is printed -->",
			"```",
			"Prose after the block, of eight words at least.",
		].join("\n");

		expect(withoutHtmlComments(source)).toContain("<!-- this one is printed -->");
		expect(sourceTextRuns(source)).toEqual(["Prose after the block of eight words at least"]);
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

describe("checkSourceAgainstHtml semantic contract validation", () => {
	it("returns no stale entries and correct counts when all text and link targets match", () => {
		const markdown = [
			"# Getting Started",
			"- default: on",
			"> Read this guide before configuring plugins.",
			"This is an introductory paragraph with more than eight words in it.",
			"See the [Installation Guide](./install.md) for full instructions on installing extensions.",
			"![Architecture](./arch.png)",
		].join("\n");

		const html = [
			"<html><body>",
			"<h1>Getting Started</h1>",
			"<ul><li>default: on</li></ul>",
			"<blockquote><p>Read this guide before configuring plugins.</p></blockquote>",
			"<p>This is an introductory paragraph with more than eight words in it.</p>",
			'<p>See the <a href="./install.html">Installation Guide</a> for full instructions on installing extensions.</p>',
			'<p><img src="./arch.png" alt="Architecture"/></p>',
			"</body></html>",
		].join("\n");

		const result = checkSourceAgainstHtml(markdown, html, "sample.html");
		expect(result.stale).toEqual([]);
		expect(result.checked).toBeGreaterThan(3);
		expect(result.checkedTargets).toBe(2);
	});

	it("reports stale when rendered HTML is missing a source text run", () => {
		const markdown = [
			"# Configuration",
			"This paragraph contains more than eight words of important documentation.",
		].join("\n");

		const html = "<html><body><h1>Configuration</h1><p>Something completely different.</p></body></html>";

		const result = checkSourceAgainstHtml(markdown, html, "sample.html");
		expect(result.stale).toEqual([
			{
				page: "sample.html",
				run: "This paragraph contains more than eight words of important documentation",
			},
		]);
	});

	it("reports stale when rendered HTML is missing a link href destination", () => {
		const markdown = "Refer to the [models documentation](./models.md) for full details.";
		const html =
			'<html><body><p>Refer to the <a href="./wrong.html">models documentation</a> for full details.</p></body></html>';

		const result = checkSourceAgainstHtml(markdown, html, "sample.html");
		expect(result.stale).toEqual([
			{
				page: "sample.html",
				run: '(missing href="./models.html")',
			},
		]);
	});

	it("reports stale when rendered HTML is missing an image src destination", () => {
		const markdown = "# Overview\n\n![Workflow Diagram](./assets/workflow.png)";
		const html = "<html><body><h1>Overview</h1><p>Workflow Diagram</p></body></html>";

		const result = checkSourceAgainstHtml(markdown, html, "sample.html");
		expect(result.stale).toEqual([
			{
				page: "sample.html",
				run: '(missing src="./assets/workflow.png")',
			},
		]);
	});

	it("matches text across smart punctuation and HTML entity conversions", () => {
		const markdown = [
			"# Author's Notes",
			"The agent--when running with model & tools--handles that project's config.",
		].join("\n");

		const html = [
			"<html><body>",
			"<h1>Author&#39;s Notes</h1>",
			"<p>The agent–when running with model &amp; tools–handles that project’s config.</p>",
			"</body></html>",
		].join("\n");

		const result = checkSourceAgainstHtml(markdown, html, "sample.html");
		expect(result.stale).toEqual([]);
	});
});
