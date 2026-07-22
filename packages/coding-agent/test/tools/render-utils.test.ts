import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { getThemeByName, initTheme, type Theme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import {
	capParseErrors,
	dedupeParseErrors,
	expandKeyHint,
	formatCodeFrameLine,
	formatDiagnostics,
	formatErrorMessage,
	formatExpandHint,
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
