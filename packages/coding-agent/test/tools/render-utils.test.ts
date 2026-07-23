import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { getThemeByName, initTheme, type Theme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import {
	capParseErrors,
	capPreviewLines,
	dedupeParseErrors,
	expandKeyHint,
	formatCodeFrameLine,
	formatDiagnostics,
	formatErrorMessage,
	formatExpandHint,
	formatMoreItems,
	formatParseErrors,
	formatParseErrorsCountLabel,
	formatScreenshot,
	formatToolWorkingDirectory,
	getDiffStats,
	getDomain,
	getLspBatchRequest,
	getPreviewLines,
	previewLine,
	shortenPath,
	truncateDiffByHunk,
} from "@veyyon/coding-agent/tools/render-utils";
import { resetKeybindingsForTests, setKeybindings } from "@veyyon/tui";

describe("parse error formatting", () => {
	it("deduplicates parse errors while preserving order", () => {
		const errors = [
			"foo.ts: parse error (syntax tree contains error nodes)",
			"foo.ts: parse error (syntax tree contains error nodes)",
			"bar.ts: parse error (syntax tree contains error nodes)",
			"foo.ts: parse error (syntax tree contains error nodes)",
		];

		expect(dedupeParseErrors(errors)).toEqual([
			"foo.ts: parse error (syntax tree contains error nodes)",
			"bar.ts: parse error (syntax tree contains error nodes)",
		]);
	});

	it("formats deduplicated parse errors", () => {
		const formatted = formatParseErrors([
			"foo.ts: parse error (syntax tree contains error nodes)",
			"foo.ts: parse error (syntax tree contains error nodes)",
			"bar.ts: parse error (syntax tree contains error nodes)",
		]);

		expect(formatted).toEqual([
			"Parse issues:",
			"- foo.ts: parse error (syntax tree contains error nodes)",
			"- bar.ts: parse error (syntax tree contains error nodes)",
		]);
	});
});

describe("formatScreenshot", () => {
	function fakeResized(
		overrides?: Partial<{
			width: number;
			height: number;
			originalWidth: number;
			originalHeight: number;
			wasResized: boolean;
			buffer: Uint8Array;
			mimeType: string;
			decodeFailed: boolean;
		}>,
	): {
		buffer: Uint8Array;
		mimeType: string;
		originalWidth: number;
		originalHeight: number;
		width: number;
		height: number;
		wasResized: boolean;
		decodeFailed?: boolean;
		get data(): string;
	} {
		const buf = overrides?.buffer ?? new Uint8Array(2048);
		return {
			buffer: buf,
			mimeType: overrides?.mimeType ?? "image/webp",
			originalWidth: overrides?.originalWidth ?? 800,
			originalHeight: overrides?.originalHeight ?? 600,
			width: overrides?.width ?? 800,
			height: overrides?.height ?? 600,
			wasResized: overrides?.wasResized ?? false,
			decodeFailed: overrides?.decodeFailed,
			get data() {
				return Buffer.from(buf).toString("base64");
			},
		};
	}

	it("formats full-res save with home-relative path", () => {
		const filePath = path.join(os.homedir(), "screenshots", "capture.png");
		const resized = fakeResized({ mimeType: "image/webp", buffer: new Uint8Array(1024) });

		expect(
			formatScreenshot({
				saveFullRes: true,
				savedMimeType: "image/png",
				savedByteLength: 2048,
				dest: filePath,
				resized,
			}),
		).toEqual([
			"Screenshot captured",
			"Saved: image/png (2.00 KB) to ~/screenshots/capture.png",
			"Model: image/webp (1.00 KB, 800x600)",
		]);
	});

	it("uses forward slashes after a shortened Windows home", () => {
		const home = String.raw`C:\Users\me`;
		expect(shortenPath(String.raw`C:\Users\me\projects\demo`, home)).toBe("~/projects/demo");
	});

	it("does not shorten paths outside the home boundary", () => {
		const home = String.raw`C:\Users\me`;
		const sibling = String.raw`C:\Users\me2\projects\demo`;
		expect(shortenPath(sibling, home)).toBe(sibling);
	});

	it("formats non-home path without tilde", () => {
		const filePath = path.join(path.parse(os.homedir()).root, "veyyon-render-utils", "capture.png");
		const resized = fakeResized({ mimeType: "image/webp", buffer: new Uint8Array(1024) });

		expect(
			formatScreenshot({
				saveFullRes: true,
				savedMimeType: "image/png",
				savedByteLength: 2048,
				dest: filePath,
				resized,
			}),
		).toEqual([
			"Screenshot captured",
			`Saved: image/png (2.00 KB) to ${filePath}`,
			"Model: image/webp (1.00 KB, 800x600)",
		]);
	});

	it("formats temp-only screenshot without save line", () => {
		const resized = fakeResized({ mimeType: "image/webp", buffer: new Uint8Array(3072) });

		expect(
			formatScreenshot({
				saveFullRes: false,
				savedMimeType: "image/webp",
				savedByteLength: 3072,
				dest: path.join(os.tmpdir(), "veyyon-sshots-123.png"),
				resized,
			}),
		).toEqual(["Screenshot captured", "Format: image/webp (3.00 KB)", "Dimensions: 800x600"]);
	});

	it("surfaces screenshots that could not be resized", () => {
		const resized = fakeResized({ decodeFailed: true, mimeType: "image/png", buffer: new Uint8Array(4096) });

		expect(
			formatScreenshot({
				saveFullRes: false,
				savedMimeType: "image/png",
				savedByteLength: 4096,
				dest: path.join(os.tmpdir(), "veyyon-sshots-123.png"),
				resized,
			}),
		).toContain("Resize: image decoder failed; using original image bytes");
	});

	it("appends dimension note when image was resized", () => {
		const resized = fakeResized({
			wasResized: true,
			originalWidth: 1600,
			originalHeight: 1200,
			width: 800,
			height: 600,
		});

		const lines = formatScreenshot({
			saveFullRes: false,
			savedMimeType: "image/webp",
			savedByteLength: 2048,
			dest: path.join(os.tmpdir(), "shot.png"),
			resized,
		});

		expect(lines).toContain(
			"[Image: original 1600x1200, displayed at 800x600. Multiply coordinates by 2.00 to map to original image.]",
		);
	});
});

describe("formatDiagnostics", () => {
	it("replaces tabs in rendered diagnostic text", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const formatted = formatDiagnostics(
			{
				errored: true,
				summary: "1\terror(s)",
				messages: [
					"src/example.go:183:41 [error] [compiler] too many\targuments in call (WrongArgCount)",
					"\tunparsed diagnostic\tmessage",
				],
			},
			true,
			theme!,
			() => "go",
		);

		expect(formatted).not.toContain("\t");
		expect(formatted.replace(/\s+/g, " ")).toContain("too many arguments in call");
		expect(formatted.replace(/\s+/g, " ")).toContain("unparsed diagnostic message");
		expect(formatted.replace(/\s+/g, " ")).toContain("1 error(s)");
	});
});

describe("formatCodeFrameLine", () => {
	it("pads markers as part of the gutter", () => {
		expect(formatCodeFrameLine(" ", 447, "context", 3)).toBe(" 447│context");
		expect(formatCodeFrameLine("*", 448, "match", 3)).toBe("*448│match");
		expect(formatCodeFrameLine("+", 11, "added", 3)).toBe(" +11│added");
		expect(formatCodeFrameLine("+", 235, "added", 3)).toBe("+235│added");
	});
});

describe("truncateDiffByHunk", () => {
	function makeHunk(prefix: "-" | "+", line: number, count: number): string[] {
		return Array.from({ length: count }, (_, i) => `${prefix} ${prefix === "-" ? "old" : "new"} ${line + i}`);
	}

	function buildDiff(hunkCount: number, linesPerHunk: number): string {
		const lines: string[] = [];
		for (let h = 0; h < hunkCount; h++) {
			lines.push(`@@ hunk ${h} @@`);
			lines.push(...makeHunk("-", h * 100, linesPerHunk));
			lines.push(...makeHunk("+", h * 100, linesPerHunk));
			lines.push(" ctx");
		}
		return lines.join("\n");
	}

	it("keeps trailing hunks when fromTail is set", () => {
		// 6 hunks total, 2 +/- lines per hunk → 4 change lines per hunk plus
		// header/context. Cap budget tight enough to force truncation.
		const diff = buildDiff(6, 2);
		const head = truncateDiffByHunk(diff, 2, 8);
		const tail = truncateDiffByHunk(diff, 2, 8, { fromTail: true });

		// Both modes drop the same number of hunks/lines.
		expect(tail.hiddenHunks).toBe(head.hiddenHunks);
		expect(tail.hiddenLines).toBe(head.hiddenLines);

		// Head shows the first hunk markers; tail shows the last hunk markers.
		expect(head.text).toContain("- old 0");
		expect(head.text).not.toContain("- old 500");
		expect(tail.text).toContain("- old 500");
		expect(tail.text).not.toContain("- old 0");
	});

	it("returns the full diff unchanged when within budget regardless of fromTail", () => {
		const diff = buildDiff(1, 1);
		const head = truncateDiffByHunk(diff, 4, 32);
		const tail = truncateDiffByHunk(diff, 4, 32, { fromTail: true });
		expect(head.text).toBe(diff);
		expect(tail.text).toBe(diff);
		expect(tail.hiddenHunks).toBe(0);
		expect(tail.hiddenLines).toBe(0);
	});

	it("preserves change/context line order within a kept hunk under fromTail", () => {
		// Single hunk with intra-segment context: leading context, change, trailing context.
		const diff = [
			"@@ only @@",
			" leading-ctx-a",
			" leading-ctx-b",
			"- old line",
			"+ new line",
			" trailing-ctx-a",
			" trailing-ctx-b",
		].join("\n");
		const { text } = truncateDiffByHunk(diff, 4, 32, { fromTail: true });
		const idxOld = text.indexOf("- old line");
		const idxNew = text.indexOf("+ new line");
		const idxLeading = text.indexOf("leading-ctx-a");
		const idxTrailing = text.indexOf("trailing-ctx-b");
		// In-order: leading context appears before change which appears before trailing context.
		expect(idxLeading).toBeLessThan(idxOld);
		expect(idxOld).toBeLessThan(idxNew);
		expect(idxNew).toBeLessThan(idxTrailing);
	});

	it("drops whole hunks (not context) when the change lines alone exceed the line budget", () => {
		// changeLineCount (6) > maxLines (4), so the context-preserving path is
		// skipped and the function keeps segments head-first until the line budget
		// fills, mid-hunk. This pins that budget-fill branch: it stops after the
		// second hunk header (the 4th kept line), reporting the two dropped hunks
		// and the five dropped lines exactly.
		const diff = ["@@ h0 @@", "-a0", "+b0", "@@ h1 @@", "-a1", "+b1", "@@ h2 @@", "-a2", "+b2"].join("\n");
		const r = truncateDiffByHunk(diff, 10, 4);
		expect(r.text).toBe("@@ h0 @@\n-a0\n+b0\n@@ h1 @@");
		expect(r.hiddenHunks).toBe(2);
		expect(r.hiddenLines).toBe(5);
	});

	it("proportionally trims a between-changes context block, keeping its head and tail around a gap", () => {
		// changeLineCount (2) fits, but the 7 context lines exceed the 4-line
		// context budget, so the ratio path trims. The 6-line block sandwiched
		// between two changes is split: first two lines, a blank gap marker, last
		// two lines, dropping the middle. Pins the isBeforeChange && isAfterChange
		// split branch and its exact kept text and hidden-line count.
		const diff = ["@@ h @@", "-a", "c1", "c2", "c3", "c4", "c5", "c6", "+b"].join("\n");
		const r = truncateDiffByHunk(diff, 10, 6);
		expect(r.text).toBe("@@ h @@\n-a\nc1\nc2\n\nc5\nc6\n+b");
		// c3 and c4 (the middle of the block) are gone; the head/tail survive.
		expect(r.text).not.toContain("c3");
		expect(r.text).not.toContain("c4");
		expect(r.hiddenHunks).toBe(0);
		expect(r.hiddenLines).toBe(1);
	});
});

describe("formatErrorMessage (F4 sanitization)", () => {
	beforeAll(async () => {
		await initTheme();
	});
	it("replaces tabs in error content with spaces", () => {
		const out = formatErrorMessage("apply_patch failed:\n@@\n-old\tindented\n+new", theme);
		expect(out).not.toContain("\t");
	});

	it("truncates very long error messages to keep TUI from overflowing", () => {
		const longTail = "x".repeat(500);
		const out = formatErrorMessage(`crash: ${longTail}`, theme);
		// Strip ANSI escape sequences so we can measure the user-visible length.
		const ESC = String.fromCharCode(0x1b);
		const visible = out
			.split(ESC)
			.map((s, i) => (i === 0 ? s : s.replace(/^\[[0-9;]*m/, "")))
			.join("");
		// LINE truncation cap is 110 chars; account for the "Error: " prefix and
		// the leading symbol+space.
		expect(visible.length).toBeLessThan(180);
	});

	it("falls back to 'Unknown error' for empty/missing input", () => {
		const out = formatErrorMessage(undefined, theme);
		expect(out).toContain("Unknown error");
	});
});

describe("formatExpandHint / expandKeyHint", () => {
	// Plain stub: `fg` is a passthrough and brackets are literal `[`/`]`, so the
	// rendered hint is deterministic regardless of the active theme's bracket glyphs.
	const plainTheme = {
		fg: (_color: unknown, text: string) => text,
		format: { bracketLeft: "[", bracketRight: "]" },
	} as unknown as Theme;

	afterEach(() => {
		resetKeybindingsForTests();
	});

	it("reports the default tool-output expand key with fold glyph", () => {
		setKeybindings(KeybindingsManager.inMemory());
		expect(expandKeyHint()).toBe("Ctrl+O");
		// Same fold dialect as settings/ModalShell (chevron + key + expand).
		expect(formatExpandHint(plainTheme, false, true)).toBe("▸ Ctrl+O expand");
	});

	it("tracks a user remap of the expand binding", () => {
		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "alt+e" }));
		expect(expandKeyHint()).toBe("Alt+E");
		expect(formatExpandHint(plainTheme, false, true)).toBe("▸ Alt+E expand");
	});

	it("renders nothing when expanded or there is no more content", () => {
		setKeybindings(KeybindingsManager.inMemory());
		expect(formatExpandHint(plainTheme, true, true)).toBe("");
		expect(formatExpandHint(plainTheme, false, false)).toBe("");
	});
});

/**
 * The pure, theme-free helpers in render-utils had no direct coverage even though every
 * tool renderer depends on them. These pin their exact data behavior so a refactor of the
 * (heavily theme-coupled) module cannot silently change how diffs are counted, domains are
 * shortened, previews are collapsed, parse errors are capped, or LSP batches are flushed.
 */
describe("getDomain", () => {
	it("returns the hostname with a leading www. stripped, and echoes an unparseable input", () => {
		expect(getDomain("https://www.example.com/x")).toBe("example.com");
		expect(getDomain("http://sub.foo.io")).toBe("sub.foo.io");
		expect(getDomain("not-a-url")).toBe("not-a-url");
	});
});

describe("getDiffStats", () => {
	it("counts added/removed lines and contiguous change runs as hunks", () => {
		// + and - both present, split by a context line -> two separate hunks.
		expect(getDiffStats("+a\n-b\n c\n+d")).toEqual({ added: 2, removed: 1, hunks: 2, lines: 4 });
		expect(getDiffStats("")).toEqual({ added: 0, removed: 0, hunks: 0, lines: 0 });
	});

	it("counts unified-diff file headers as add/remove lines (they start with +++/---)", () => {
		// Documents a known quirk: `--- a` and `+++ b` are counted, so header-bearing
		// diffs report two extra changed lines. The @@ hunk marker breaks the run.
		expect(getDiffStats("--- a\n+++ b\n@@ -1 +1 @@\n+x\n-y")).toEqual({
			added: 2,
			removed: 2,
			hunks: 2,
			lines: 5,
		});
	});
});

describe("previewLine / getPreviewLines", () => {
	it("collapses whitespace (including newlines and tabs) into a single spaced line", () => {
		expect(previewLine("a\n\tb   c", 20)).toBe("a b c");
	});

	it("keeps only the first maxLines non-blank lines, trimmed", () => {
		expect(getPreviewLines("  one  \n\n  two  \nthree", 2, 10)).toEqual(["one", "two"]);
	});
});

describe("capParseErrors / formatParseErrorsCountLabel", () => {
	it("dedupes then caps to the limit, reporting the pre-cap total", () => {
		expect(capParseErrors(["e1", "e1", "e2"])).toEqual({ errors: ["e1", "e2"], total: 2 });
		expect(capParseErrors(["e1", "e2", "e3"], 1)).toEqual({ errors: ["e1"], total: 3 });
		expect(capParseErrors(undefined)).toEqual({ errors: [], total: 0 });
	});

	it("labels a within-limit count directly and a capped count as N / total", () => {
		expect(formatParseErrorsCountLabel(["a", "b", "c"])).toBe("3 parse issues");
		expect(formatParseErrorsCountLabel(["a"])).toBe("1 parse issue");
		expect(formatParseErrorsCountLabel([], 25)).toBe("20 / 25 parse issues");
	});
});

describe("formatToolWorkingDirectory", () => {
	it("hides an unset workdir or one equal to the project dir, shows an in-project relative path", () => {
		const cwd = process.cwd();
		expect(formatToolWorkingDirectory(undefined, cwd)).toBeUndefined();
		expect(formatToolWorkingDirectory(".", cwd)).toBeUndefined();
		expect(formatToolWorkingDirectory("src/tools", cwd)).toBe("src/tools");
	});

	it("shows an absolute (home-shortened) path when the workdir escapes the project dir", () => {
		expect(formatToolWorkingDirectory("/etc", process.cwd())).toBe("/etc");
	});
});

describe("getLspBatchRequest", () => {
	// Minimal structural stand-in for ToolCallContext: only index/batchId/toolCalls[].name are read.
	const ctx = (index: number, names: string[], batchId = "b1") =>
		({
			index,
			batchId,
			toolCalls: names.map(name => ({ name })),
		}) as unknown as Parameters<typeof getLspBatchRequest>[0];

	it("returns undefined without a context or when no other call in the batch is a write", () => {
		expect(getLspBatchRequest(undefined)).toBeUndefined();
		expect(getLspBatchRequest(ctx(0, ["read", "search"]))).toBeUndefined();
	});

	it("requests a batch, flushing only when no later call in the batch is a write", () => {
		// A later write exists -> defer the flush.
		expect(getLspBatchRequest(ctx(0, ["edit", "write"]))).toEqual({ id: "b1", flush: false });
		// This is the last write in the batch -> flush now.
		expect(getLspBatchRequest(ctx(1, ["edit", "write"]))).toEqual({ id: "b1", flush: true });
	});
});

/**
 * `capPreviewLines` collapses a streaming command/code preview to a tail window:
 * the LAST lines stay visible (the live edge while args stream) behind a single
 * "… N earlier lines" marker on top. The index math is the part that breaks
 * silently, so these pin every branch with exact strings and counts. A
 * passthrough `fg` and literal brackets make the marker deterministic; the
 * expand-hint suffix is a separate concern already covered above, so most cases
 * suppress it with `expandHint: false`.
 */
describe("capPreviewLines", () => {
	// fg is a passthrough so the marker text is exactly what capPreviewLines builds.
	const plainTheme = {
		fg: (_color: unknown, text: string) => text,
		nav: { expand: "▸" },
		format: { bracketLeft: "[", bracketRight: "]" },
	} as unknown as Theme;

	const lines = (n: number) => Array.from({ length: n }, (_, i) => `L${i + 1}`);

	it("returns the input unchanged when it already fits within max", () => {
		const input = lines(3);
		expect(capPreviewLines(input, plainTheme, { max: 5, expandHint: false })).toEqual(input);
		// Exactly at the window is still a full show, no marker.
		expect(capPreviewLines(input, plainTheme, { max: 3, expandHint: false })).toEqual(input);
	});

	it("returns everything untouched when expanded, regardless of length or max", () => {
		const input = lines(50);
		expect(capPreviewLines(input, plainTheme, { max: 4, expanded: true })).toBe(input);
	});

	it("caps to exactly max output rows: one marker plus the last (max-1) lines", () => {
		const out = capPreviewLines(lines(10), plainTheme, { max: 4, expandHint: false });
		expect(out).toHaveLength(4); // 1 marker + 3 visible == max
		// The tail (live edge) is kept, in order.
		expect(out.slice(1)).toEqual(["L8", "L9", "L10"]);
		// 10 total - 3 shown == 7 hidden, plural.
		expect(out[0]).toBe("… 7 earlier lines");
	});

	it("keeps the newest lines, never the oldest (streaming live edge stays visible)", () => {
		const out = capPreviewLines(lines(100), plainTheme, { max: 6, expandHint: false });
		expect(out).toHaveLength(6);
		expect(out.slice(1)).toEqual(["L96", "L97", "L98", "L99", "L100"]);
		expect(out[0]).toBe("… 95 earlier lines");
	});

	it("prepends a raw prefix to the marker line only, leaving visible lines ungutter-ed", () => {
		const out = capPreviewLines(lines(5), plainTheme, { max: 3, prefix: "│ ", expandHint: false });
		expect(out[0]).toBe("│ … 3 earlier lines");
		expect(out.slice(1)).toEqual(["L4", "L5"]);
	});

	it("hidden count is always >= 2 once the cap triggers for any real window (max >= 2)", () => {
		// Property: cap requires length > max, and visible == max-1, so
		// hidden == length-(max-1) == length-max+1 >= 2. The singular
		// "1 earlier line" marker is therefore unreachable at any real window
		// size (the floor is 6). Sweep a range to lock the invariant.
		for (let max = 2; max <= 8; max++) {
			for (let len = max + 1; len <= max + 5; len++) {
				const out = capPreviewLines(lines(len), plainTheme, { max, expandHint: false });
				const hidden = len - (out.length - 1);
				expect(hidden).toBeGreaterThanOrEqual(2);
				expect(out[0]).toBe(`… ${hidden} earlier lines`);
			}
		}
	});

	it("degrades to a marker-only row when max <= 1 (no room for any content line)", () => {
		// max == 1: visible is empty, the whole preview collapses to the marker.
		const one = capPreviewLines(lines(5), plainTheme, { max: 1, expandHint: false });
		expect(one).toEqual(["… 5 earlier lines"]);
		// max == 0 with a single line is the only way to reach the singular marker.
		const singular = capPreviewLines(["only"], plainTheme, { max: 0, expandHint: false });
		expect(singular).toEqual(["… 1 earlier line"]);
	});
});

/**
 * `formatMoreItems` builds the "… N more <things>" suffix for truncated lists.
 * It guards against a non-finite count (NaN/Infinity from bad arithmetic) by
 * flooring to 0, and pluralizes the item label. These pin both.
 */
describe("formatMoreItems", () => {
	it("pluralizes the item label by count and keeps singular at exactly 1", () => {
		expect(formatMoreItems(3, "match")).toBe("… 3 more matches");
		expect(formatMoreItems(1, "item")).toBe("… 1 more item");
		expect(formatMoreItems(2, "entry")).toBe("… 2 more entries");
	});

	it("floors a non-finite count to 0 rather than rendering NaN/Infinity", () => {
		expect(formatMoreItems(Number.NaN, "file")).toBe("… 0 more files");
		expect(formatMoreItems(Number.POSITIVE_INFINITY, "row")).toBe("… 0 more rows");
	});
});
