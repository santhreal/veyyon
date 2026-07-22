import { describe, expect, it } from "bun:test";
import {
	decodeHtmlEntities,
	finalizeOutput,
	formatIsoDate,
	getLocalizedText,
	loadFailure,
	looksLikeHtml,
} from "../../src/web/scrapers/types";

/**
 * Pure text helpers shared by the web-fetch scrapers. Several had no test. These
 * shape what the agent actually sees from a scraped page, so their edge behavior
 * is pinned here:
 *   - decodeHtmlEntities decodes the common named/numeric entities in a single
 *     left-to-right pass, so an encoded literal like `&amp;quot;` (or the numeric
 *     `&#38;lt;`) decodes to one level instead of being double-decoded, and an
 *     astral ref like `&#128512;` resolves via fromCodePoint, not fromCharCode;
 *   - formatIsoDate returns the leading YYYY-MM-DD of an ISO-ish string verbatim,
 *     converts numbers/Dates through UTC, and returns "" for nullish or unparseable
 *     input rather than throwing on Invalid Date;
 *   - getLocalizedText prefers an explicit locale, then en-US / en_US / en, then the
 *     first string value, skipping null-valued locales, and returns undefined for
 *     nullish input;
 *   - looksLikeHtml recognizes a leading doctype/html/head/body tag case- and
 *     whitespace-insensitively, and is not fooled by a tag later in the text;
 *   - finalizeOutput collapses 3+ blank lines to one gap and trims;
 *   - loadFailure prefers an HTTP status, then an error string, then a default.
 * A regression would double-decode entities, throw on a bad date, pick the wrong
 * localized string, or misclassify page content.
 */

describe("decodeHtmlEntities", () => {
	it("decodes the common named and numeric entities", () => {
		expect(decodeHtmlEntities("a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#039; &#x27;e &#x2F; &nbsp;f")).toBe(
			"a <b> & \"c\" 'd' 'e /  f",
		);
	});

	it("decodes each entity exactly one level so an encoded literal is not double-decoded", () => {
		// `&amp;X;` is the encoding of the literal text `&X;`; each must decode
		// exactly one level. REGRESSION: a multi-pass decoder ran `&amp;` before the
		// other entities, so `&amp;quot;` became `"` instead of `&quot;`. The
		// single-pass decoder replaces each `&...;` from the original text and never
		// re-scans its own output, so every doubly-encoded entity stops at one level.
		expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
		expect(decodeHtmlEntities("&amp;gt;")).toBe("&gt;");
		expect(decodeHtmlEntities("&amp;quot;")).toBe("&quot;");
		expect(decodeHtmlEntities("&amp;#39;")).toBe("&#39;");
		expect(decodeHtmlEntities("&amp;#x27;")).toBe("&#x27;");
		expect(decodeHtmlEntities("&amp;#x2F;")).toBe("&#x2F;");
		expect(decodeHtmlEntities("&amp;nbsp;")).toBe("&nbsp;");
		// A bare `&amp;` still decodes to a single `&`, and a doubly-encoded
		// ampersand `&amp;amp;` decodes one level to `&amp;`.
		expect(decodeHtmlEntities("a &amp; b")).toBe("a & b");
		expect(decodeHtmlEntities("&amp;amp;")).toBe("&amp;");
		// The numeric encoding of `&` is `&#38;`/`&#x26;`; it is `&` just like
		// `&amp;`, so `&#38;lt;` must also stop at one level. A multi-pass decoder
		// that expanded numeric refs and then re-scanned would double-decode this.
		expect(decodeHtmlEntities("&#38;lt;")).toBe("&lt;");
		expect(decodeHtmlEntities("&#x26;quot;")).toBe("&quot;");
	});

	it("decodes arbitrary decimal and hex character references, including astral code points", () => {
		// The named set is tiny; real pages carry arbitrary numeric refs. A decimal
		// (`&#233;` = é) and a hex ref (`&#xE9;`) both resolve, case-insensitively on
		// the `x`. REGRESSION: an astral ref like the emoji `&#128512;` must use
		// fromCodePoint, not fromCharCode; fromCharCode would emit a broken surrogate.
		expect(decodeHtmlEntities("caf&#233;")).toBe("café");
		expect(decodeHtmlEntities("caf&#xE9;")).toBe("café");
		expect(decodeHtmlEntities("caf&#Xe9;")).toBe("café");
		expect(decodeHtmlEntities("&#128512;")).toBe("😀");
		expect(decodeHtmlEntities("&#x1F600;")).toBe("😀");
	});

	it("leaves an unknown entity, a lone surrogate, and a bare ampersand untouched", () => {
		// Only the known named set decodes; `&copy;` is not in it, so it stays. A
		// numeric ref outside the Unicode scalar range (a lone surrogate `&#xD800;`
		// or beyond `&#x110000;`) is not a character, so the original text is kept
		// rather than emitting replacement junk. A bare `&` is not an entity.
		expect(decodeHtmlEntities("A &copy; B")).toBe("A &copy; B");
		expect(decodeHtmlEntities("&apos;quoted&apos;")).toBe("'quoted'");
		expect(decodeHtmlEntities("&#xD800;")).toBe("&#xD800;");
		expect(decodeHtmlEntities("&#1114112;")).toBe("&#1114112;");
		expect(decodeHtmlEntities("Tom & Jerry")).toBe("Tom & Jerry");
	});
});

describe("formatIsoDate", () => {
	it("returns the leading YYYY-MM-DD of an ISO string verbatim", () => {
		expect(formatIsoDate("2021-06-15T23:00:00Z and trailing text")).toBe("2021-06-15");
	});

	it("converts a Date and a numeric timestamp through UTC", () => {
		expect(formatIsoDate(new Date(Date.UTC(2020, 0, 2)))).toBe("2020-01-02");
		expect(formatIsoDate(0)).toBe("1970-01-01");
	});

	it("returns an empty string for nullish, empty, or unparseable input", () => {
		expect(formatIsoDate(undefined)).toBe("");
		expect(formatIsoDate("")).toBe("");
		expect(formatIsoDate("not a date")).toBe("");
	});
});

describe("getLocalizedText", () => {
	it("returns a plain string value and undefined for nullish input", () => {
		expect(getLocalizedText("hi")).toBe("hi");
		expect(getLocalizedText(null)).toBeUndefined();
		expect(getLocalizedText(undefined)).toBeUndefined();
	});

	it("prefers an explicit defaultLocale over the en-US chain", () => {
		expect(getLocalizedText({ de: "DE", "en-US": "US" }, "de")).toBe("DE");
	});

	it("falls back through en-US, en_US, en, then the first string value", () => {
		expect(getLocalizedText({ "en-US": "US", en: "EN", fr: "FR" })).toBe("US");
		expect(getLocalizedText({ en_US: "US2", fr: "FR" })).toBe("US2");
		expect(getLocalizedText({ en: "EN", fr: "FR" })).toBe("EN");
		expect(getLocalizedText({ fr: "FR", de: "DE" })).toBe("FR");
	});

	it("skips a null-valued preferred locale and uses the next available string", () => {
		expect(getLocalizedText({ "en-US": null, fr: "FR" })).toBe("FR");
	});
});

describe("looksLikeHtml", () => {
	it("recognizes a leading html-ish tag case- and whitespace-insensitively", () => {
		expect(looksLikeHtml("  <!DOCTYPE html>")).toBe(true);
		expect(looksLikeHtml("<HTML>")).toBe(true);
		expect(looksLikeHtml("<head>")).toBe(true);
		expect(looksLikeHtml("<body>")).toBe(true);
	});

	it("is not fooled by a tag that appears later in the text", () => {
		expect(looksLikeHtml("hello <html>")).toBe(false);
		expect(looksLikeHtml("plain text")).toBe(false);
	});
});

describe("finalizeOutput", () => {
	it("collapses runs of 3+ newlines to a single blank line and trims", () => {
		expect(finalizeOutput("a\n\n\n\nb\n\n\n")).toEqual({ content: "a\n\nb", truncated: false });
	});
});

describe("loadFailure", () => {
	it("prefers an HTTP status, then an error string, then a default", () => {
		expect(loadFailure({ status: 404 })).toBe("HTTP 404");
		expect(loadFailure({ error: "boom" })).toBe("boom");
		expect(loadFailure({})).toBe("fetch failed");
	});
});
