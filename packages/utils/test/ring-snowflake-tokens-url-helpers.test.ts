import { describe, expect, it } from "bun:test";
import { collapseWhitespace } from "../src/collapse-whitespace";
import { contentText } from "../src/content-text";
import { RingBuffer } from "../src/ring";
import { Snowflake } from "../src/snowflake";
import { estimateTokensFromText } from "../src/tokens";
import {
	containsUrlScheme,
	hasUriScheme,
	hasUrlScheme,
	normalizeBaseUrl,
	trimTrailingSlashes,
	URI_SCHEME_PREFIX_RE,
	URL_SCHEME_ANYWHERE_RE,
	URL_SCHEME_PREFIX_RE,
	urlScheme,
} from "../src/url";

describe("collapseWhitespace", () => {
	it("returns empty string for null", () => {
		expect(collapseWhitespace(null)).toBe("");
	});

	it("returns empty string for undefined", () => {
		expect(collapseWhitespace(undefined)).toBe("");
	});

	it("returns single space string unchanged", () => {
		expect(collapseWhitespace("hello world")).toBe("hello world");
	});

	it("collapses multiple spaces", () => {
		expect(collapseWhitespace("hello   world")).toBe("hello world");
	});

	it("collapses tabs", () => {
		expect(collapseWhitespace("hello\t\tworld")).toBe("hello world");
	});

	it("collapses newlines", () => {
		expect(collapseWhitespace("hello\n\nworld")).toBe("hello world");
	});

	it("collapses mixed whitespace", () => {
		expect(collapseWhitespace("hello \t\n world")).toBe("hello world");
	});

	it("trims leading whitespace", () => {
		expect(collapseWhitespace("  hello")).toBe("hello");
	});

	it("trims trailing whitespace", () => {
		expect(collapseWhitespace("hello  ")).toBe("hello");
	});

	it("trims both leading and trailing", () => {
		expect(collapseWhitespace("  hello  ")).toBe("hello");
	});

	it("returns empty for whitespace-only input", () => {
		expect(collapseWhitespace("   \t\n  ")).toBe("");
	});

	it("returns empty for empty string", () => {
		expect(collapseWhitespace("")).toBe("");
	});
});

describe("contentText", () => {
	it("returns string content directly", () => {
		expect(contentText("hello")).toBe("hello");
	});

	it("returns empty for non-array non-string", () => {
		expect(contentText(42)).toBe("");
		expect(contentText(null)).toBe("");
		expect(contentText(undefined)).toBe("");
		expect(contentText({})).toBe("");
	});

	it("extracts text from text blocks", () => {
		expect(contentText([{ type: "text", text: "hello" }])).toBe("hello");
	});

	it("joins multiple text blocks with newline", () => {
		expect(
			contentText([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			]),
		).toBe("a\nb");
	});

	it("joins with custom separator", () => {
		expect(
			contentText(
				[
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
				" ",
			),
		).toBe("a b");
	});

	it("skips non-text blocks", () => {
		expect(
			contentText([
				{ type: "image", text: "skip" },
				{ type: "text", text: "keep" },
			]),
		).toBe("keep");
	});

	it("skips blocks without text property", () => {
		expect(contentText([{ type: "text" }, { type: "text", text: "keep" }])).toBe("keep");
	});

	it("skips blocks with non-string text", () => {
		expect(
			contentText([
				{ type: "text", text: 42 },
				{ type: "text", text: "keep" },
			]),
		).toBe("keep");
	});

	it("skips null entries", () => {
		expect(contentText([null, { type: "text", text: "keep" }])).toBe("keep");
	});

	it("skips non-object entries", () => {
		expect(contentText(["string", { type: "text", text: "keep" }])).toBe("keep");
	});

	it("returns empty for empty array", () => {
		expect(contentText([])).toBe("");
	});

	it("returns empty for array with no text blocks", () => {
		expect(contentText([{ type: "image", url: "x" }])).toBe("");
	});
});

describe("estimateTokensFromText", () => {
	it("returns 0 for empty string", () => {
		expect(estimateTokensFromText("")).toBe(0);
	});

	it("returns at least 1 for 1-4 bytes", () => {
		expect(estimateTokensFromText("a")).toBe(1);
		expect(estimateTokensFromText("ab")).toBe(1);
		expect(estimateTokensFromText("abc")).toBe(1);
		expect(estimateTokensFromText("abcd")).toBe(1);
	});

	it("returns 2 for 5-8 bytes", () => {
		expect(estimateTokensFromText("abcde")).toBe(2);
		expect(estimateTokensFromText("abcdefgh")).toBe(2);
	});

	it("counts UTF-8 bytes not chars", () => {
		// 你 = 3 bytes, 好 = 3 bytes = 6 bytes total → (6+3)>>2 = 2
		expect(estimateTokensFromText("你好")).toBe(2);
	});

	it("handles emoji correctly", () => {
		// 😀 = 4 bytes → (4+3)>>2 = 1
		expect(estimateTokensFromText("😀")).toBe(1);
	});

	it("scales linearly with byte count", () => {
		expect(estimateTokensFromText("a".repeat(100))).toBe(25);
	});
});

describe("trimTrailingSlashes", () => {
	it("removes trailing slashes", () => {
		expect(trimTrailingSlashes("http://example.com/")).toBe("http://example.com");
	});

	it("removes multiple trailing slashes", () => {
		expect(trimTrailingSlashes("http://example.com///")).toBe("http://example.com");
	});

	it("returns unchanged when no trailing slashes", () => {
		expect(trimTrailingSlashes("http://example.com")).toBe("http://example.com");
	});

	it("handles empty string", () => {
		expect(trimTrailingSlashes("")).toBe("");
	});

	it("handles only slashes", () => {
		expect(trimTrailingSlashes("///")).toBe("");
	});

	it("preserves internal slashes", () => {
		expect(trimTrailingSlashes("http://example.com/path/")).toBe("http://example.com/path");
	});
});

describe("normalizeBaseUrl", () => {
	it("returns trimmed base URL without trailing slashes", () => {
		expect(normalizeBaseUrl("http://example.com/")).toBe("http://example.com");
	});

	it("returns trimmed base URL with trailing whitespace removed", () => {
		expect(normalizeBaseUrl("  http://example.com  ")).toBe("http://example.com");
	});

	it("returns fallback when baseUrl is undefined", () => {
		expect(normalizeBaseUrl(undefined, "http://fallback.com")).toBe("http://fallback.com");
	});

	it("returns fallback when baseUrl is empty string", () => {
		expect(normalizeBaseUrl("", "http://fallback.com")).toBe("http://fallback.com");
	});

	it("returns fallback when baseUrl is whitespace only", () => {
		expect(normalizeBaseUrl("   ", "http://fallback.com")).toBe("http://fallback.com");
	});

	it("returns undefined when no fallback and baseUrl is empty", () => {
		expect(normalizeBaseUrl(undefined)).toBeUndefined();
	});

	it("returns undefined when no fallback and baseUrl is whitespace", () => {
		expect(normalizeBaseUrl("  ")).toBeUndefined();
	});

	it("returns trimmed URL when valid", () => {
		expect(normalizeBaseUrl("http://example.com/path/", "fallback")).toBe("http://example.com/path");
	});
});

describe("hasUrlScheme", () => {
	it("returns true for http://", () => {
		expect(hasUrlScheme("http://example.com")).toBe(true);
	});

	it("returns true for https://", () => {
		expect(hasUrlScheme("https://example.com")).toBe(true);
	});

	it("returns true for custom scheme", () => {
		expect(hasUrlScheme("myapp://path")).toBe(true);
	});

	it("returns false for bare path", () => {
		expect(hasUrlScheme("/path/to/file")).toBe(false);
	});

	it("returns false for relative URL", () => {
		expect(hasUrlScheme("path/to/file")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(hasUrlScheme("")).toBe(false);
	});

	it("URL_SCHEME_PREFIX_RE matches", () => {
		expect(URL_SCHEME_PREFIX_RE.test("ftp://host")).toBe(true);
	});
});

describe("urlScheme", () => {
	it("returns lowercase scheme for http", () => {
		expect(urlScheme("http://example.com")).toBe("http");
	});

	it("returns lowercase scheme for HTTPS", () => {
		expect(urlScheme("HTTPS://example.com")).toBe("https");
	});

	it("returns null for bare path", () => {
		expect(urlScheme("/path")).toBe(null);
	});

	it("returns null for empty string", () => {
		expect(urlScheme("")).toBe(null);
	});

	it("returns scheme for custom protocol", () => {
		expect(urlScheme("my-app+v1://path")).toBe("my-app+v1");
	});
});

describe("containsUrlScheme", () => {
	it("returns true when URL scheme is present at start", () => {
		expect(containsUrlScheme("http://example.com")).toBe(true);
	});

	it("returns true when URL scheme is embedded", () => {
		expect(containsUrlScheme("click http://example.com here")).toBe(true);
	});

	it("returns false when no scheme", () => {
		expect(containsUrlScheme("just text")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(containsUrlScheme("")).toBe(false);
	});

	it("URL_SCHEME_ANYWHERE_RE matches embedded scheme", () => {
		expect(URL_SCHEME_ANYWHERE_RE.test("see ftp://host now")).toBe(true);
	});
});

describe("hasUriScheme", () => {
	it("returns true for scheme: prefix", () => {
		expect(hasUriScheme("mailto:test@example.com")).toBe(true);
	});

	it("returns true for http://", () => {
		expect(hasUriScheme("http://example.com")).toBe(true);
	});

	it("returns false for bare path", () => {
		expect(hasUriScheme("/path/to/file")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(hasUriScheme("")).toBe(false);
	});

	it("URI_SCHEME_PREFIX_RE matches", () => {
		expect(URI_SCHEME_PREFIX_RE.test("urn:isbn:123")).toBe(true);
	});
});

describe("RingBuffer", () => {
	it("starts empty", () => {
		const r = new RingBuffer<number>(3);
		expect(r.isEmpty).toBe(true);
		expect(r.isFull).toBe(false);
		expect(r.length).toBe(0);
	});

	it("pushes items up to capacity", () => {
		const r = new RingBuffer<number>(3);
		r.push(1);
		r.push(2);
		r.push(3);
		expect(r.length).toBe(3);
		expect(r.isFull).toBe(true);
		expect(r.isEmpty).toBe(false);
	});

	it("overwrites oldest when full and returns it", () => {
		const r = new RingBuffer<number>(3);
		r.push(1);
		r.push(2);
		r.push(3);
		const overwritten = r.push(4);
		expect(overwritten).toBe(1);
		expect(r.length).toBe(3);
	});

	it("shifts items in FIFO order", () => {
		const r = new RingBuffer<number>(3);
		r.push(1);
		r.push(2);
		r.push(3);
		expect(r.shift()).toBe(1);
		expect(r.shift()).toBe(2);
		expect(r.shift()).toBe(3);
		expect(r.isEmpty).toBe(true);
	});

	it("returns undefined when shifting empty", () => {
		const r = new RingBuffer<number>(3);
		expect(r.shift()).toBeUndefined();
	});

	it("pops items in LIFO order", () => {
		const r = new RingBuffer<number>(3);
		r.push(1);
		r.push(2);
		r.push(3);
		expect(r.pop()).toBe(3);
		expect(r.pop()).toBe(2);
		expect(r.pop()).toBe(1);
		expect(r.isEmpty).toBe(true);
	});

	it("returns undefined when popping empty", () => {
		const r = new RingBuffer<number>(3);
		expect(r.pop()).toBeUndefined();
	});

	it("unshifts items at front", () => {
		const r = new RingBuffer<number>(3);
		r.push(1);
		r.unshift(0);
		expect(r.peek()).toBe(0);
		expect(r.peekBack()).toBe(1);
	});

	it("unshift overwrites when full and returns overwritten", () => {
		const r = new RingBuffer<number>(3);
		r.push(1);
		r.push(2);
		r.push(3);
		const overwritten = r.unshift(0);
		expect(overwritten).toBe(3);
		expect(r.length).toBe(3);
		expect(r.peek()).toBe(0);
	});

	it("accesses by index with at()", () => {
		const r = new RingBuffer<number>(3);
		r.push(10);
		r.push(20);
		r.push(30);
		expect(r.at(0)).toBe(10);
		expect(r.at(1)).toBe(20);
		expect(r.at(2)).toBe(30);
	});

	it("supports negative index in at()", () => {
		const r = new RingBuffer<number>(3);
		r.push(10);
		r.push(20);
		r.push(30);
		expect(r.at(-1)).toBe(30);
		expect(r.at(-2)).toBe(20);
	});

	it("returns undefined for out-of-bounds at()", () => {
		const r = new RingBuffer<number>(3);
		r.push(10);
		expect(r.at(5)).toBeUndefined();
		expect(r.at(-5)).toBeUndefined();
	});

	it("peek returns first item", () => {
		const r = new RingBuffer<number>(3);
		r.push(42);
		expect(r.peek()).toBe(42);
	});

	it("peek returns undefined when empty", () => {
		const r = new RingBuffer<number>(3);
		expect(r.peek()).toBeUndefined();
	});

	it("peekBack returns last item", () => {
		const r = new RingBuffer<number>(3);
		r.push(1);
		r.push(2);
		expect(r.peekBack()).toBe(2);
	});

	it("peekBack returns undefined when empty", () => {
		const r = new RingBuffer<number>(3);
		expect(r.peekBack()).toBeUndefined();
	});

	it("clears all items", () => {
		const r = new RingBuffer<number>(3);
		r.push(1);
		r.push(2);
		r.clear();
		expect(r.isEmpty).toBe(true);
		expect(r.length).toBe(0);
	});

	it("iterates in order", () => {
		const r = new RingBuffer<number>(3);
		r.push(1);
		r.push(2);
		r.push(3);
		expect([...r]).toEqual([1, 2, 3]);
	});

	it("iterates after wraparound", () => {
		const r = new RingBuffer<number>(3);
		r.push(1);
		r.push(2);
		r.push(3);
		r.push(4); // overwrites 1
		expect([...r]).toEqual([2, 3, 4]);
	});

	it("toArray returns items in order", () => {
		const r = new RingBuffer<number>(3);
		r.push(1);
		r.push(2);
		r.push(3);
		expect(r.toArray()).toEqual([1, 2, 3]);
	});

	it("toArray after wraparound", () => {
		const r = new RingBuffer<number>(3);
		r.push(1);
		r.push(2);
		r.push(3);
		r.push(4);
		r.push(5);
		expect(r.toArray()).toEqual([3, 4, 5]);
	});

	it("handles mixed push/shift operations", () => {
		const r = new RingBuffer<number>(3);
		r.push(1);
		r.push(2);
		r.shift();
		r.push(3);
		r.push(4);
		expect(r.toArray()).toEqual([2, 3, 4]);
	});

	it("handles capacity 1", () => {
		const r = new RingBuffer<number>(1);
		r.push(1);
		expect(r.isFull).toBe(true);
		expect(r.push(2)).toBe(1);
		expect(r.peek()).toBe(2);
	});

	it("handles string items", () => {
		const r = new RingBuffer<string>(2);
		r.push("a");
		r.push("b");
		expect([...r]).toEqual(["a", "b"]);
	});

	it("handles object items", () => {
		const r = new RingBuffer<{ id: number }>(2);
		r.push({ id: 1 });
		r.push({ id: 2 });
		expect(r.at(0)?.id).toBe(1);
		expect(r.at(1)?.id).toBe(2);
	});
});

describe("Snowflake", () => {
	it("PATTERN matches valid 16-char hex", () => {
		expect(Snowflake.PATTERN.test("0000000000000001")).toBe(true);
	});

	it("PATTERN rejects non-hex", () => {
		expect(Snowflake.PATTERN.test("gggggggggggggggg")).toBe(false);
	});

	it("PATTERN rejects wrong length", () => {
		expect(Snowflake.PATTERN.test("abc123")).toBe(false);
	});

	it("valid returns true for generated snowflake", () => {
		const sf = Snowflake.next(1_600_000_000_000);
		expect(Snowflake.valid(sf)).toBe(true);
	});

	it("valid returns false for invalid string", () => {
		expect(Snowflake.valid("invalid")).toBe(false);
	});

	it("valid returns false for empty string", () => {
		expect(Snowflake.valid("")).toBe(false);
	});

	it("formatParts produces valid snowflake", () => {
		const sf = Snowflake.formatParts(1000, 42);
		expect(Snowflake.valid(sf)).toBe(true);
	});

	it("formatParts encodes timestamp and sequence", () => {
		const sf = Snowflake.formatParts(1000, 42);
		expect(Snowflake.getTimestamp(sf)).toBe(1000 + Snowflake.EPOCH_TIMESTAMP);
		expect(Snowflake.getSequence(sf)).toBe(42);
	});

	it("getTimestamp extracts timestamp", () => {
		const ts = 1_600_000_000_000;
		const sf = Snowflake.next(ts);
		expect(Snowflake.getTimestamp(sf)).toBe(ts);
	});

	it("getDate returns Date close to timestamp", () => {
		const ts = 1_600_000_000_000;
		const sf = Snowflake.next(ts);
		expect(Snowflake.getDate(sf).getTime()).toBe(ts);
	});

	it("getSequence extracts sequence", () => {
		const src = new Snowflake.Source(0);
		const sf = src.generate(1_600_000_000_000);
		expect(Snowflake.getSequence(sf)).toBe(1);
	});

	it("Source.generate increments sequence", () => {
		const src = new Snowflake.Source(0);
		const sf1 = src.generate(1_600_000_000_000);
		const sf2 = src.generate(1_600_000_000_000);
		expect(Snowflake.getSequence(sf1)).toBe(1);
		expect(Snowflake.getSequence(sf2)).toBe(2);
	});

	it("Source.sequence getter/setter", () => {
		const src = new Snowflake.Source(0);
		src.sequence = 100;
		expect(src.sequence).toBe(100);
	});

	it("Source.reset sets sequence to 0", () => {
		const src = new Snowflake.Source(0);
		src.generate(1_600_000_000_000);
		src.reset();
		expect(src.sequence).toBe(0);
	});

	it("Source sequence wraps at MAX_SEQUENCE", () => {
		const src = new Snowflake.Source(Snowflake.MAX_SEQUENCE);
		src.generate(1_600_000_000_000);
		expect(src.sequence).toBe(0);
	});

	it("lowerbound from number", () => {
		const lb = Snowflake.lowerbound(1_600_000_000_000);
		expect(Snowflake.valid(lb)).toBe(true);
		expect(Snowflake.getSequence(lb)).toBe(0);
	});

	it("lowerbound from Date", () => {
		const date = new Date(1_600_000_000_000);
		const lb = Snowflake.lowerbound(date);
		expect(Snowflake.valid(lb)).toBe(true);
		expect(Snowflake.getSequence(lb)).toBe(0);
	});

	it("lowerbound from Snowflake returns same string", () => {
		const sf = Snowflake.next(1_600_000_000_000);
		expect(Snowflake.lowerbound(sf)).toBe(sf);
	});

	it("upperbound from number has MAX_SEQUENCE", () => {
		const ub = Snowflake.upperbound(1_600_000_000_000);
		expect(Snowflake.valid(ub)).toBe(true);
		expect(Snowflake.getSequence(ub)).toBe(Snowflake.MAX_SEQUENCE);
	});

	it("upperbound from Date has MAX_SEQUENCE", () => {
		const date = new Date(1_600_000_000_000);
		const ub = Snowflake.upperbound(date);
		expect(Snowflake.getSequence(ub)).toBe(Snowflake.MAX_SEQUENCE);
	});

	it("upperbound from Snowflake returns same string", () => {
		const sf = Snowflake.next(1_600_000_000_000);
		expect(Snowflake.upperbound(sf)).toBe(sf);
	});
});
