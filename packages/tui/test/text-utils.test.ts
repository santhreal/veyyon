import { describe, expect, it } from "bun:test";
import {
	clamp,
	encodeTextSized,
	extractSegments,
	sanitizeSingleLine,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui/utils";
import { Glob } from "bun";

describe("text utils", () => {
	it("computes visible width for ANSI and tabs", () => {
		const text = `\x1b[31mhi\tthere\x1b[0m`;
		expect(visibleWidth(text)).toBe(2 + 3 + 5);
	});

	it("does not double-count pure ASCII tabs", () => {
		expect(visibleWidth("a\tb")).toBe(1 + 3 + 1);
	});

	it("ignores OSC hyperlinks in visible width", () => {
		const text = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
		expect(visibleWidth(text)).toBe(4);
	});

	it("counts a styled ZWJ emoji the same as the unstyled emoji (ANSI is zero-width)", () => {
		// Family emoji built from ZWJ-joined code points renders as a single
		// 2-cell grapheme. Wrapping it in SGR styling must not change its width:
		// the grapheme fallback splits ANSI into separate segments, and the
		// native scanner only skips ANSI when handed the complete escape — so
		// the SGR bytes (`[`, `3`, `1`, `m`, …) must be excised before
		// segmentation, not counted as visible cells.
		const emoji = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
		const styled = `\x1b[31m${emoji}\x1b[0m`;
		expect(visibleWidth(emoji)).toBe(2);
		expect(visibleWidth(styled)).toBe(visibleWidth(emoji));
		// Styling around only part of a ZWJ-containing span is also zero-width.
		expect(visibleWidth(`a\x1b[1m${emoji}\x1b[22mb`)).toBe(1 + 2 + 1);
		// Plain styled ASCII is unaffected — ANSI strips to its visible text.
		expect(visibleWidth("\x1b[31mhello\x1b[0m")).toBe(visibleWidth("hello"));
	});

	it("counts a VS16 emoji-presentation symbol as 2 cells", () => {
		// A default-text-presentation symbol followed by variation-selector-16
		// (U+FE0F) renders in emoji presentation = 2 cells. The native scanner
		// must apply UnicodeWidthStr's VS16 promotion, not a per-char sum that
		// drops the selector — otherwise `⚠️` measures 1 and pads one column
		// short, shifting markdown table borders. Regression for the offset
		// seen with the ⚠️ keyword in a rendered table row.
		expect(visibleWidth("\u26a0\ufe0f")).toBe(2); // ⚠️
		expect(visibleWidth("\u2139\ufe0f")).toBe(2); // ℹ️
		expect(visibleWidth("\u2764\ufe0f")).toBe(2); // ❤️
		expect(visibleWidth("0\ufe0f\u20e3")).toBe(2); // 0️⃣
		// Bare symbol without VS16 keeps its text-presentation width.
		expect(visibleWidth("\u26a0")).toBe(1);
		// Intrinsically wide emoji are unaffected by the change.
		expect(visibleWidth("\u2705")).toBe(2); // ✅
		expect(visibleWidth("\u274c")).toBe(2); // ❌
		// Padding math the table renderer relies on stays exact.
		expect(visibleWidth("\u26a0\ufe0f now")).toBe(6);
	});

	it("truncates ANSI text with ellipsis", () => {
		const text = "\x1b[31mhello world\x1b[0m";
		const result = truncateToWidth(text, 6);
		expect(result.includes("\x1b[0m…")).toBe(true);
		expect(visibleWidth(result)).toBe(6);
	});

	it("slices visible columns while preserving ANSI", () => {
		const text = "\x1b[31mhello\x1b[0m world";
		const result = sliceWithWidth(text, 1, 4, true);
		expect(result.text.startsWith("\x1b[31mello")).toBe(true);
		expect(result.width).toBe(4);
	});

	it("extracts segments with inherited styling", () => {
		const text = "\x1b[31mhello world\x1b[0m";
		const result = extractSegments(text, 3, 6, 5, true);
		expect(result.before).toContain("hel");
		expect(result.after.startsWith("\x1b[31m")).toBe(true);
		expect(result.afterWidth).toBeGreaterThan(0);
	});

	it("encodes OSC 66 text sizing spans with ST terminators", () => {
		const encoded = encodeTextSized("Hi", {
			scale: 2,
			widthCells: 3,
			verticalAlign: "center",
			horizontalAlign: "right",
		});
		expect(encoded).toBe("\x1b]66;s=2:w=3:v=2:h=1;Hi\x1b\\");
		expect(visibleWidth(encoded)).toBe(6);
		expect(encodeTextSized("A\nB", { scale: 1 })).toBe("\x1b]66;s=1;A B\x1b\\");
	});

	it("counts OSC 66 text-sizing spans as visible text", () => {
		expect(visibleWidth("\x1b]66;s=2;Hi\x1b\\")).toBe(4);
		expect(visibleWidth("\x1b]66;w=5;Hi\x1b\\")).toBe(5);
		expect(visibleWidth("\x1b]66;s=3:w=4;X\x1b\\")).toBe(12);
		expect(visibleWidth("\x1b]66;;abc\x1b\\")).toBe(3);
		expect(visibleWidth(`A${"\x1b]66;s=2;Hi\x1b\\"}Z`)).toBe(1 + 4 + 1);
		const family = "👨‍👩‍👧‍👦";
		expect(visibleWidth(encodeTextSized(family, { scale: 2, widthCells: 2 }))).toBe(4);
	});

	it("slices and truncates OSC 66 spans atomically", () => {
		const osc66 = "\x1b]66;s=2;Hi\x1b\\";

		const fullSlice = sliceWithWidth(`A${osc66}Z`, 1, 4, true);
		expect(fullSlice.text).toBe(osc66);
		expect(fullSlice.width).toBe(4);
		expect(visibleWidth(fullSlice.text)).toBe(4);

		const fullTruncate = truncateToWidth(osc66, 4);
		expect(fullTruncate).toBe(osc66);
		expect(visibleWidth(fullTruncate)).toBe(4);

		const partialSlice = sliceWithWidth(osc66, 0, 2, true);
		expect(partialSlice.text).toBe("H");
		expect(partialSlice.width).toBe(1);
		expect(partialSlice.text.includes("\x1b]66")).toBe(false);

		const trailingSlice = sliceWithWidth(osc66, 2, 2, true);
		expect(trailingSlice.text).toBe("i");
		expect(trailingSlice.width).toBe(1);
		expect(trailingSlice.text.includes("\x1b]66")).toBe(false);

		const partialTruncate = truncateToWidth(osc66, 3);
		expect(partialTruncate.includes("\x1b]66")).toBe(false);
		expect(partialTruncate.includes("\x1b]")).toBe(false);
		expect(visibleWidth(partialTruncate)).toBe(3);
	});

	it("extracts OSC 66 spans without emitting partial wrappers", () => {
		const osc66 = "\x1b]66;s=2;Hi\x1b\\";
		const result = extractSegments(`A${osc66}Z`, 1, 1, 2, true);

		expect(result.before).toBe("A");
		expect(result.beforeWidth).toBe(1);
		expect(result.after).toBe("H");
		expect(result.afterWidth).toBe(1);
		expect(result.after.includes("\x1b]66")).toBe(false);
	});
});

describe("sanitizeSingleLine", () => {
	it("collapses newlines, tabs, and whitespace runs to single spaces and trims", () => {
		expect(sanitizeSingleLine("  a\tb\n\nc  \r\n d  ")).toBe("a b c d");
	});

	it("flattens an embedded newline so a list row cannot break", () => {
		expect(sanitizeSingleLine("line one\nline two")).toBe("line one line two");
		expect(sanitizeSingleLine("")).toBe("");
	});

	// ONE-PLACE lock: this helper was copy-pasted byte-for-byte into select-list
	// and settings-list. It now lives only in utils.ts — a second definition must
	// re-import, not re-declare, or copies drift.
	it("is defined in exactly one source file", async () => {
		const root = `${import.meta.dir}/../..`;
		const definitions: string[] = [];
		for (const pkg of ["tui/src", "coding-agent/src"]) {
			const glob = new Glob("**/*.ts");
			for await (const rel of glob.scan({ cwd: `${root}/${pkg}` })) {
				const src = await Bun.file(`${root}/${pkg}/${rel}`).text();
				if (/function\s+sanitizeSingleLine\b/.test(src)) definitions.push(`${pkg}/${rel}`);
			}
		}
		expect(definitions).toEqual(["tui/src/utils.ts"]);
	});
});

describe("clamp", () => {
	it("returns the value untouched inside the range", () => {
		expect(clamp(5, 0, 10)).toBe(5);
		expect(clamp(0, 0, 10)).toBe(0);
		expect(clamp(10, 0, 10)).toBe(10);
	});

	it("clamps below min and above max", () => {
		expect(clamp(-3, 0, 10)).toBe(0);
		expect(clamp(42, 0, 10)).toBe(10);
	});

	it("preserves the historical inline idiom on an inverted range (min wins)", () => {
		// The inlined `Math.max(min, Math.min(value, max))` returns min when min > max
		// regardless of value; the extracted helper must match byte-for-byte.
		expect(clamp(5, 10, 0)).toBe(10);
		expect(clamp(-5, 10, 0)).toBe(10);
		expect(clamp(Math.max(10, Math.min(5, 0)), 0, 20)).toBe(10);
	});

	it("propagates NaN value (same as the idiom) so callers sanitize first", () => {
		expect(clamp(Number.NaN, 0, 10)).toBeNaN();
	});

	it("passes Infinity bounds through unchanged", () => {
		expect(clamp(1e9, 0, Number.POSITIVE_INFINITY)).toBe(1e9);
		expect(clamp(Number.NEGATIVE_INFINITY, 0, 10)).toBe(0);
	});

	// ONE-PLACE lock: the clamp idiom was inlined across select-list, settings-list,
	// scroll-view, spacer, and tab-bar (and a local `const clamp` lived in
	// select-list). It now has a single owner in utils.ts — a re-declared `clamp`
	// (function or const) anywhere in tui/src must re-import instead, or copies drift.
	it("is defined in exactly one source file", async () => {
		const root = `${import.meta.dir}/../..`;
		const definitions: string[] = [];
		const glob = new Glob("**/*.ts");
		for await (const rel of glob.scan({ cwd: `${root}/tui/src` })) {
			const src = await Bun.file(`${root}/tui/src/${rel}`).text();
			if (/(?:function\s+clamp\b|(?:const|let)\s+clamp\s*=)/.test(src)) definitions.push(`tui/src/${rel}`);
		}
		expect(definitions).toEqual(["tui/src/utils.ts"]);
	});
});
