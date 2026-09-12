import { describe, expect, it } from "bun:test";
import { formatBorderRule, frameBorderLines } from "../src/utils/border";
import { HoverController } from "../src/utils/hover-controller";
import { computeThumbRange, handleStandardScrollKey } from "../src/utils/scroll-layout";
import { formatSearchStatus, handleSearchKeyInput } from "../src/utils/search-filter";
import { applyLineBackground, dropLastCodePoint, firstGrapheme, lastGrapheme } from "../src/utils/text-layout";

describe("engine-utils", () => {
	describe("border", () => {
		it("formats horizontal border rule with exact widths", () => {
			const rule = formatBorderRule("┌", "─", 8, "┐");
			expect(rule).toBe("┌────────┐");
		});

		it("formats border rule with colorizer", () => {
			const color = (s: string) => `\x1b[31m${s}\x1b[0m`;
			const rule = formatBorderRule("┌", "─", 3, "┐", color);
			expect(rule).toBe("\x1b[31m┌───┐\x1b[0m");
		});

		it("frames interior lines with vertical borders", () => {
			const framed = frameBorderLines(["hello", "world"], "│");
			expect(framed).toEqual(["│hello│", "│world│"]);
		});
	});

	describe("hover-controller", () => {
		it("tracks hover target and provides strength", () => {
			const controller = new HoverController<string>();
			expect(controller.key).toBeNull();
			expect(controller.strength("item-1")).toBe(0);

			controller.set("item-1");
			expect(controller.key).toBe("item-1");
			expect(controller.strength("item-1")).toBe(1);
			expect(controller.strength("item-2")).toBe(0);

			controller.set(null);
			expect(controller.key).toBeNull();
			expect(controller.strength("item-1")).toBe(0);
			controller.dispose();
		});
	});

	describe("scroll-layout", () => {
		it("computes thumb range correctly across viewports and bounds", () => {
			expect(computeThumbRange(0, 100, 0)).toEqual({ start: 0, end: 0 });
			expect(computeThumbRange(10, 5, 0)).toEqual({ start: 0, end: 10 });
			const range = computeThumbRange(10, 20, 5);
			expect(range.start).toBeGreaterThanOrEqual(0);
			expect(range.end).toBeLessThanOrEqual(10);
			expect(range.end).toBeGreaterThan(range.start);
		});

		it("handles standard scroll keys with callback routing", () => {
			let scrolled = 0;
			let paged = 0;
			let toTop = false;
			let toBottom = false;

			const scroll = (d: number) => {
				scrolled += d;
			};
			const page = (d: number) => {
				paged += d;
			};
			const scrollToTop = () => {
				toTop = true;
			};
			const scrollToBottom = () => {
				toBottom = true;
			};

			expect(handleStandardScrollKey("\x1b[A", scroll, page, scrollToTop, scrollToBottom)).toBe(true);
			expect(scrolled).toBe(-1);

			expect(handleStandardScrollKey("\x1b[B", scroll, page, scrollToTop, scrollToBottom)).toBe(true);
			expect(scrolled).toBe(0);

			expect(handleStandardScrollKey("\x1b[5~", scroll, page, scrollToTop, scrollToBottom)).toBe(true);
			expect(paged).toBe(-1);

			expect(handleStandardScrollKey("\x1b[6~", scroll, page, scrollToTop, scrollToBottom)).toBe(true);
			expect(paged).toBe(0);

			expect(handleStandardScrollKey("\x1b[H", scroll, page, scrollToTop, scrollToBottom)).toBe(true);
			expect(toTop).toBe(true);

			expect(handleStandardScrollKey("\x1b[F", scroll, page, scrollToTop, scrollToBottom)).toBe(true);
			expect(toBottom).toBe(true);

			expect(handleStandardScrollKey("other-key", scroll, page, scrollToTop, scrollToBottom)).toBe(false);
		});
	});

	describe("search-filter", () => {
		it("formats search status accurately", () => {
			const hint = (s: string) => `[${s}]`;
			expect(formatSearchStatus("", 30, hint)).toBe("[  Type to search]");
			expect(formatSearchStatus("abc", 30, hint)).toBe("[  Search: abc]");
		});

		it("handles backspace and deletes one code point including unicode", () => {
			expect(handleSearchKeyInput("\x7f", "abc", true, true)).toBe("ab");
			expect(handleSearchKeyInput("\x7f", "a😊", true, true)).toBe("a");
			expect(handleSearchKeyInput("\x7f", "", true, true)).toBe("");
			expect(handleSearchKeyInput("x", "abc", true, true)).toBe("abcx");
			expect(handleSearchKeyInput("\x1b", "abc", true, true)).toBeNull();
		});
	});

	describe("text-layout", () => {
		it("extracts first and last graphemes across ascii, unicode, CRLF, combining and prepend sequences", () => {
			const cases: Array<{ input: string; first: string; last: string; label: string }> = [
				{ input: "", first: "", last: "", label: "empty string" },
				{ input: "a", first: "a", last: "a", label: "single ascii" },
				{ input: "hello", first: "h", last: "o", label: "pure ascii word" },
				{ input: "\n", first: "\n", last: "\n", label: "single newline" },
				{ input: "\t", first: "\t", last: "\t", label: "single tab" },
				{ input: "\r", first: "\r", last: "\r", label: "single carriage return" },
				{ input: "\r\n", first: "\r\n", last: "\r\n", label: "CRLF pair" },
				{ input: "\r\nhello", first: "\r\n", last: "o", label: "CRLF prefix" },
				{ input: "hello\r\n", first: "h", last: "\r\n", label: "CRLF suffix" },
				{ input: "\rhello", first: "\r", last: "o", label: "CR prefix without LF" },
				{ input: "hello\r", first: "h", last: "\r", label: "CR suffix without LF" },
				{ input: "a\u0301", first: "a\u0301", last: "a\u0301", label: "ascii with combining acute accent" },
				{ input: "a\u0301bc", first: "a\u0301", last: "c", label: "combining accent at start" },
				{ input: "hello a\u0301", first: "h", last: "a\u0301", label: "combining accent at end" },
				{ input: "e\u0301", first: "e\u0301", last: "e\u0301", label: "e with combining acute accent" },
				{ input: "o\u0308", first: "o\u0308", last: "o\u0308", label: "o with combining diaeresis" },
				{ input: "\u0600A", first: "\u0600A", last: "\u0600A", label: "unicode prepend character before ascii" },
				{ input: "\u0600AB", first: "\u0600A", last: "B", label: "unicode prepend followed by multiple ascii" },
				{ input: "hello\u0600A", first: "h", last: "\u0600A", label: "unicode prepend at end" },
				{ input: "🚀", first: "🚀", last: "🚀", label: "single surrogate pair emoji" },
				{ input: "🚀rocket", first: "🚀", last: "t", label: "emoji prefix" },
				{ input: "hello🚀", first: "h", last: "🚀", label: "emoji suffix" },
				{ input: "👍🏽", first: "👍🏽", last: "👍🏽", label: "emoji with skin tone modifier" },
				{ input: "👍🏽thumbs", first: "👍🏽", last: "s", label: "modifier emoji prefix" },
				{ input: "hello👍🏽", first: "h", last: "👍🏽", label: "modifier emoji suffix" },
				{ input: "👨‍👩‍👧‍👦", first: "👨‍👩‍👧‍👦", last: "👨‍👩‍👧‍👦", label: "ZWJ sequence family emoji" },
				{ input: "a".repeat(100) + "xyz", first: "a", last: "z", label: "long ascii string" },
				{
					input: "a".repeat(100) + "👨‍👩‍👧‍👦",
					first: "a",
					last: "👨‍👩‍👧‍👦",
					label: "long string with trailing ZWJ emoji",
				},
				{
					input: "a".repeat(100) + "a\u0301",
					first: "a",
					last: "a\u0301",
					label: "long string with trailing combining mark",
				},
				{
					input: "a".repeat(100) + "\u0600A",
					first: "a",
					last: "\u0600A",
					label: "long string with trailing prepend cluster",
				},
				{
					input: "👨‍👩‍👧‍👦" + "a".repeat(100),
					first: "👨‍👩‍👧‍👦",
					last: "a",
					label: "long string with leading ZWJ emoji",
				},
				{
					input: "a\u0301" + "a".repeat(100),
					first: "a\u0301",
					last: "a",
					label: "long string with leading combining mark",
				},
				{
					input: "\u0600A" + "a".repeat(100),
					first: "\u0600A",
					last: "a",
					label: "long string with leading prepend cluster",
				},
				{
					input: "a" + "\u0301".repeat(80),
					first: "a" + "\u0301".repeat(80),
					last: "a" + "\u0301".repeat(80),
					label: "combining cluster exceeding 64 code units",
				},
				{
					input: "prefix " + "a" + "\u0301".repeat(80),
					first: "p",
					last: "a" + "\u0301".repeat(80),
					label: "trailing combining cluster exceeding 64 code units after ascii prefix",
				},
				{
					input: "👩\u200D".repeat(40) + "👩",
					first: "👩\u200D".repeat(40) + "👩",
					last: "👩\u200D".repeat(40) + "👩",
					label: "ZWJ sequence exceeding 64 code units",
				},
				{
					input: "prefix " + "👩\u200D".repeat(40) + "👩",
					first: "p",
					last: "👩\u200D".repeat(40) + "👩",
					label: "trailing ZWJ sequence exceeding 64 code units after ascii prefix",
				},
				{
					input: "\uD83C\uDDFA\uD83C\uDDF8".repeat(35),
					first: "\uD83C\uDDFA\uD83C\uDDF8",
					last: "\uD83C\uDDFA\uD83C\uDDF8",
					label: "regional indicator flag sequence exceeding 64 code units",
				},
				{
					input: "\uD83C\uDDFA\uD83C\uDDF8".repeat(30) + "\uD83C\uDDE8\uD83C\uDDE6",
					first: "\uD83C\uDDFA\uD83C\uDDF8",
					last: "\uD83C\uDDE8\uD83C\uDDE6",
					label: "long regional indicator stream with distinct trailing flag pair",
				},
			];

			for (const { input, first, last, label } of cases) {
				expect([label, firstGrapheme(input)]).toEqual([label, first]);
				expect([label, lastGrapheme(input)]).toEqual([label, last]);
			}
		});

		it("drops last code point handling surrogate pairs", () => {
			expect(dropLastCodePoint("hello")).toBe("hell");
			expect(dropLastCodePoint("test😊")).toBe("test");
			expect(dropLastCodePoint("")).toBe("");
		});

		it("applies line background color preserving SGR", () => {
			const res = applyLineBackground("hello", 10, s => `\x1b[44m${s}\x1b[0m`);
			expect(res).toContain("\x1b[44m");
			expect(res).toContain("hello");
		});
	});
});
