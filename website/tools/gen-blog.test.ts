// Tests for the report → blog pipeline (website/tools/gen-blog.mjs).
//
// `website/blog/*.md` is the one source of truth for technical reports, and
// merging one to `main` deploys veyyon.dev (.github/workflows/site.yml). Nobody
// reviews the generated HTML, so every rule the generator enforces has to be
// pinned here: the contract is "a report that would publish wrong fails the
// build while it is still a pull request".

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
// @ts-expect-error — plain .mjs module, no types; imported for its exports.
import * as blog from "./gen-blog.mjs";

/** A fresh throwaway blog directory holding the given `name -> contents` files. */
function fixture(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "veyyon-blog-"));
	for (const [name, contents] of Object.entries(files)) {
		writeFileSync(join(dir, name), contents);
	}
	return dir;
}

const POST = `---
title: "Hashline: content-addressed edits"
slug: hashline
date: 2026-07-20
summary: "Anchors from a prior read, verified before the write."
---

Edits carry an anchor.
`;

describe("frontmatter parsing", () => {
	/** The whole pipeline keys off frontmatter, so an unterminated or absent block
	 *  must name the file it came from — a bare "cannot parse" in CI logs sent
	 *  people hunting through every post. */
	it("names the offending file when the block is missing or unclosed", () => {
		expect(() => blog.parseFrontmatter("# Just a heading\n", "reports/x.md")).toThrow(
			/reports\/x\.md: missing frontmatter/,
		);
		expect(() => blog.parseFrontmatter("---\ntitle: x\n", "reports/y.md")).toThrow(
			/reports\/y\.md: frontmatter is not closed/,
		);
	});

	/** `draft: true` is the one switch between "renders for a review link" and
	 *  "published to the world", so it has to arrive as a boolean, not the string
	 *  "true" (which is truthy either way and would publish nothing, ever). */
	it("reads draft as a real boolean and strips quotes from values", () => {
		const { data, body } = blog.parseFrontmatter(
			['---', 'title: "Quoted title"', "slug: a-slug", "draft: true", '---', "", "Body line.", ""].join("\n"),
			"t.md",
		);
		expect(data.draft).toBe(true);
		expect(data.title).toBe("Quoted title");
		expect(data.slug).toBe("a-slug");
		// The body keeps the blank line that followed the closing `---`; the
		// renderer treats blank lines as paragraph breaks, so it is not stripped here.
		expect(body).toBe("\nBody line.\n");
	});
});

describe("post validation", () => {
	/** Two reports resolving to one slug used to overwrite each other's HTML: the
	 *  second render won and the first report vanished from the site with a green
	 *  build. It must be a hard error naming both files. */
	it("rejects two posts that resolve to the same slug", () => {
		const dir = fixture({
			"a.md": POST,
			"b.md": POST.replace("Hashline: content-addressed edits", "A different report"),
		});
		// Both filenames must appear: the reader has to know which two files collided,
		// and readdir order decides which one is reported as the incumbent.
		let message = "";
		try {
			blog.readPosts(dir);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/slug "hashline" is already used by/);
		expect(message).toContain(join(dir, "a.md"));
		expect(message).toContain(join(dir, "b.md"));
	});

	/** The slug is pasted straight into the public URL and the sitemap, so an
	 *  uppercase, spaced, or slash-bearing slug would ship an unreachable post. */
	it.each([
		["Hashline", /not URL-safe/],
		["two words", /not URL-safe/],
		["nested/path", /not URL-safe/],
		["trailing-", /not URL-safe/],
	])("rejects the non-URL-safe slug %p", (slug, expected) => {
		const dir = fixture({ "p.md": POST.replace("slug: hashline", `slug: ${slug}`) });
		expect(() => blog.readPosts(dir)).toThrow(expected);
	});

	/** A published post with no date sorts unpredictably on the index and renders
	 *  a card with a blank meta line; a draft is allowed to be undated because it
	 *  is not listed anywhere yet. */
	it("requires an ISO date on published posts and allows drafts without one", () => {
		const undated = POST.replace("date: 2026-07-20\n", "");
		expect(() => blog.readPosts(fixture({ "p.md": undated }))).toThrow(/need an ISO date/);
		expect(() => blog.readPosts(fixture({ "p.md": `${undated.trimEnd()}\n` }))).toThrow(/need an ISO date/);

		const draft = blog.readPosts(fixture({ "p.md": undated.replace("---\n\n", "draft: true\n---\n\n") }));
		expect(draft).toHaveLength(1);
		expect(draft[0].draft).toBe(true);
		expect(draft[0].date).toBe("");
	});

	/** Loose dates ("July 2026", "2026-7-1") formatted as themselves and broke the
	 *  index's date sort, which is a plain string compare on the ISO form. */
	it("rejects a date that is not exactly YYYY-MM-DD", () => {
		const dir = fixture({ "p.md": POST.replace("date: 2026-07-20", "date: July 20 2026") });
		expect(() => blog.readPosts(dir)).toThrow(/need an ISO date/);
	});

	/** The summary is the only body text on the blog index card, so a published
	 *  post without one renders an empty card. */
	it("requires a summary on published posts", () => {
		const dir = fixture({ "p.md": POST.replace(/summary: .*\n/, "") });
		expect(() => blog.readPosts(dir)).toThrow(/need a summary/);
	});

	/** Reports are read newest-first on the index; the sort is the ISO date
	 *  descending, not filesystem order (which is alphabetical and meaningless). */
	it("returns posts newest first regardless of filename order", () => {
		const dir = fixture({
			"a-oldest.md": POST.replace("date: 2026-07-20", "date: 2026-01-02").replace("slug: hashline", "slug: old"),
			"z-newest.md": POST.replace("date: 2026-07-20", "date: 2026-09-09").replace("slug: hashline", "slug: new"),
			"m-middle.md": POST,
		});
		expect(blog.readPosts(dir).map((p: { slug: string }) => p.slug)).toEqual(["new", "hashline", "old"]);
	});

	/** The layout renders the frontmatter title as the page's single h1, so a
	 *  leading `# ...` in the body would print the title twice. */
	it("drops a leading body heading so the title is not rendered twice", () => {
		const dir = fixture({ "p.md": POST.replace("Edits carry", "# Hashline\n\nEdits carry") });
		expect(blog.readPosts(dir)[0].body).toBe("Edits carry an anchor.\n");
	});
});

describe("markdown rendering", () => {
	/** Reports are full of paths, flags, and config keys. Inline code must survive
	 *  verbatim, and it must be protected from the emphasis rules: `a*b*c` inside
	 *  backticks is code, not italics. */
	it("renders inline code verbatim and shields it from emphasis", () => {
		expect(blog.renderInline("set `argot.enabled` to true")).toBe(
			'set <code class="inline">argot.enabled</code> to true',
		);
		expect(blog.renderInline("glob `a*b*c` matches")).toBe('glob <code class="inline">a*b*c</code> matches');
	});

	/** A report that pastes a tool error or a JSON body must not be able to inject
	 *  markup into the page. */
	it("escapes HTML in prose and in code spans", () => {
		expect(blog.renderInline('<script>alert("x")</script>')).toBe(
			"&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
		);
		expect(blog.renderInline("`<b>&</b>`")).toBe('<code class="inline">&lt;b&gt;&amp;&lt;/b&gt;</code>');
	});

	/**
	 * The placeholder that shields code spans must not be forgeable from a post.
	 *
	 * The sentinel used to be a literal NUL byte, and prose containing one would be
	 * substituted as if it were an extracted code span: `\uE0000\uE000` in the source
	 * would come back as whatever the first real code span held, or as `undefined`
	 * when there was none. It is stripped from the input now, so the sentinel can
	 * only ever be one this function wrote itself.
	 */
	it("cannot have its code-span placeholder forged by a post", () => {
		const sentinel = "\uE000";

		expect(blog.renderInline(`${sentinel}0${sentinel} plain prose`)).toBe("0 plain prose");
		expect(blog.renderInline(`${sentinel}0${sentinel} and \`real\``)).toBe(
			'0 and <code class="inline">real</code>',
		);
		expect(blog.renderInline(`before ${sentinel} after`)).toBe("before  after");
	});

	/** The sentinel must not appear in the rendered output either, or the page
	 *  ships an invisible private-use character into the reader's HTML. */
	it("leaves no sentinel in the output", () => {
		const rendered = blog.renderInline("a `code` span, **bold**, and [a link](https://example.test/)");

		expect(rendered).not.toContain("\uE000");
		expect(rendered).not.toContain("\u0000");
		expect(rendered).toBe(
			'a <code class="inline">code</code> span, <strong>bold</strong>, and <a href="https://example.test/">a link</a>',
		);
	});

	/** Several code spans in one line must come back in order. The placeholder
	 *  carries an index, and an off-by-one there would silently swap two spans. */
	it("restores multiple code spans in order", () => {
		expect(blog.renderInline("`first` then `second` then `third`")).toBe(
			'<code class="inline">first</code> then <code class="inline">second</code> then <code class="inline">third</code>',
		);
	});

	it("renders links, bold, and italics", () => {
		expect(blog.renderInline("see [the handbook](https://veyyon.dev/docs/)")).toBe(
			'see <a href="https://veyyon.dev/docs/">the handbook</a>',
		);
		expect(blog.renderInline("**loud** and *quiet*")).toBe("<strong>loud</strong> and <em>quiet</em>");
	});

	/** Fenced blocks keep their language class (the site styles on it) and their
	 *  contents exactly, including blank lines and indentation. */
	it("renders a fenced code block with its language and exact contents", () => {
		const html = blog.renderMarkdown(["```yaml", "modelRoles:", "  default: openai/gpt-5", "```"].join("\n"));
		expect(html).toBe(
			'<pre class="code"><code class="language-yaml">modelRoles:\n  default: openai/gpt-5</code></pre>',
		);
	});

	it("renders headings at their level, and both list kinds", () => {
		expect(blog.renderMarkdown("## Findings")).toBe("<h2>Findings</h2>");
		expect(blog.renderMarkdown("#### Detail")).toBe("<h4>Detail</h4>");
		expect(blog.renderMarkdown("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
		expect(blog.renderMarkdown("1. first\n2. second")).toBe("<ol><li>first</li><li>second</li></ol>");
	});

	/** Wrapped source lines are one paragraph: reports are hard-wrapped at ~80
	 *  columns and must not render as one paragraph per line. */
	it("joins wrapped lines into one paragraph and splits on blank lines", () => {
		expect(blog.renderMarkdown("first line\nsecond line\n\nnew paragraph")).toBe(
			"<p>first line second line</p>\n<p>new paragraph</p>",
		);
	});
});

describe("date formatting", () => {
	/** The published date is what a reader uses to judge whether a report is
	 *  current, so the human form must match the ISO source exactly. */
	it("formats an ISO date and passes anything else through untouched", () => {
		expect(blog.formatDate("2026-07-20")).toBe("July 20, 2026");
		expect(blog.formatDate("2026-01-01")).toBe("January 1, 2026");
		expect(blog.formatDate("2026-12-31")).toBe("December 31, 2026");
		expect(blog.formatDate("")).toBe("");
	});
});
