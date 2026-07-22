import { describe, expect, it } from "bun:test";
import { decodeHNText } from "../../src/web/scrapers/hackernews";

/**
 * decodeHNText turns the HTML that the Hacker News Firebase API returns for a
 * comment or story body into the Markdown the agent reads. Its anchor handling
 * is the sharp edge: HN comments routinely link to URLs that carry `(`/`)`
 * (Wikipedia disambiguation pages) and use label text with `[`/`]`, and the
 * href arrives HTML-entity-encoded (`&amp;`). A naive `[$2]($1)` rewrite
 * truncated the link at the first `)` and broke on a bracketed label. These
 * lock that the rewrite now routes both halves through markdownLink so the link
 * stays whole and still resolves after the trailing entity-decode pass, and
 * that the surrounding paragraph/code/italic transforms are unaffected.
 */

describe("decodeHNText anchor conversion", () => {
	it("percent-encodes parentheses in the href so a Wikipedia link is not truncated", () => {
		// A bare `[Foo](.../Foo_(bar))` closes at the first `)`, leaving `_(bar)`
		// as stray text. The parens must become %28/%29 so the whole URL is the
		// destination, and it must round-trip back to the original resource.
		const out = decodeHNText('<a href="https://en.wikipedia.org/wiki/Foo_(bar)" rel="nofollow">Foo</a>');
		expect(out).toBe("[Foo](https://en.wikipedia.org/wiki/Foo_%28bar%29)");
		const url = out.slice(out.indexOf("(") + 1, -1);
		expect(decodeURIComponent(url)).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
	});

	it("preserves an &amp; in the href through the trailing entity decode", () => {
		// The href is entity-encoded when the anchor is rewritten; markdownLinkUrl
		// never touches `&`, so the later decodeHtmlEntities pass turns `&amp;`
		// back into `&` and the query string stays valid.
		const out = decodeHNText('<a href="https://x.example/?a=1&amp;b=2" rel="nofollow">link</a>');
		expect(out).toBe("[link](https://x.example/?a=1&b=2)");
	});

	it("escapes square brackets in the label so they cannot close it early", () => {
		// `[[draft] notes](url)` would parse the label as `[draft`; escaping the
		// brackets keeps the intended label intact.
		const out = decodeHNText('<a href="https://x.example" rel="nofollow">[draft] notes</a>');
		expect(out).toBe("[\\[draft\\] notes](https://x.example)");
	});
});

describe("decodeHNText block formatting", () => {
	it("maps paragraphs, italics, and inline code and decodes entities", () => {
		// Locks the non-anchor transforms alongside the anchor fix: <p> becomes a
		// blank-line gap, <i>/<code> become * / `, and &gt; decodes last.
		const out = decodeHNText("<p>Hello <i>world</i> and <code>x&gt;y</code></p><p>Second</p>");
		expect(out).toBe("Hello *world* and `x>y`\n\nSecond");
	});
});
