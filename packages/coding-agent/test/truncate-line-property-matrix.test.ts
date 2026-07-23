/**
 * truncateLine: when length > maxChars, text is slice(0,maxChars)+'…' and
 * wasTruncated true; otherwise identity. Default max is DEFAULT_MAX_COLUMN (512).
 */
import { describe, expect, it } from "bun:test";
import { DEFAULT_MAX_COLUMN, truncateLine } from "@veyyon/coding-agent/session/streaming-output";

describe("truncateLine property matrix", () => {
	it("identity under max", () => {
		expect(truncateLine("hello", 10)).toEqual({ text: "hello", wasTruncated: false });
		expect(truncateLine("", 0)).toEqual({ text: "", wasTruncated: false });
		expect(truncateLine("abc", 3)).toEqual({ text: "abc", wasTruncated: false });
	});

	for (const max of [1, 2, 5, 10, 50, 100]) {
		it(`truncates at maxChars=${max}`, () => {
			const line = "x".repeat(max + 5);
			const r = truncateLine(line, max);
			expect(r.wasTruncated).toBe(true);
			expect(r.text).toBe(`${"x".repeat(max)}…`);
			expect(r.text.length).toBe(max + 1); // chars + ellipsis
		});
	}

	it("default max column is 512", () => {
		expect(DEFAULT_MAX_COLUMN).toBe(512);
		const short = "a".repeat(512);
		expect(truncateLine(short).wasTruncated).toBe(false);
		const long = "a".repeat(513);
		const r = truncateLine(long);
		expect(r.wasTruncated).toBe(true);
		expect(r.text).toBe(`${"a".repeat(512)}…`);
	});

	it("unicode: counts JS string length (code units), not graphemes", () => {
		// snowman is one code unit in BMP
		const line = "☃".repeat(5);
		expect(truncateLine(line, 3)).toEqual({ text: "☃☃☃…", wasTruncated: true });
	});

	it("maxChars 0 truncates entire line to ellipsis only", () => {
		expect(truncateLine("abc", 0)).toEqual({ text: "…", wasTruncated: true });
	});
});
