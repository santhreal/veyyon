// WHY: four display truncators cut text with `String.prototype.slice`, which
// counts UTF-16 code units. A cut that lands between the high and low half of
// an astral character (emoji, rare CJK, musical symbols) emits a lone
// surrogate: invalid text that renders as U+FFFD in the terminal and reaches
// the model as a broken token. The class is "cut a display budget without
// going through a code-point-safe helper", and it was live in
// `tools/core/approval.ts` (approval card), `tools/search/ast-edit.ts` (diff preview),
// `tools/shell/eval.ts` (display() value) and `hashline/src/patcher.ts` (covered by
// the sibling suite in that package).
//
// Each site now routes through `truncate` from `@veyyon/utils`, which cuts by
// code point. This suite sweeps an astral character across every offset in a
// window straddling each site's budget, so the exact off-by-one that splits a
// pair cannot survive at any of them.
//
// What this does NOT catch: a NEW truncator added elsewhere that hand-rolls a
// code-unit slice. There is no registry of display truncators to enumerate, so
// the site list here is maintained by hand.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { truncateForPrompt } from "@veyyon/coding-agent/tools/core/approval";
import { AstEditTool } from "@veyyon/coding-agent/tools/search/ast-edit";
import { formatDisplayJsonForText } from "@veyyon/coding-agent/tools/shell/eval";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

/** U+1F600, two UTF-16 code units. Splitting it yields a lone surrogate. */
const ASTRAL = "\u{1F600}";

/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function loneSurrogateOffset(value: string): number {
	return value.search(LONE_SURROGATE);
}

/** Filler that can never itself be mistaken for a surrogate half. */
function filler(count: number): string {
	return "a".repeat(count);
}

/**
 * Offsets to try for the astral character, straddling `budget`. A code-unit
 * cut splits the pair when the astral character starts at exactly
 * `budget - 1`; the window proves neighbours stay intact too.
 */
function offsetsAround(budget: number): number[] {
	return [budget - 3, budget - 2, budget - 1, budget, budget + 1];
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map(block => block.text)
		.join("\n");
}

describe("a truncated preview never splits an astral character", () => {
	describe("the approval card truncator", () => {
		// truncateForPrompt's default budget, mirrored from DEFAULT_PROMPT_TRUNCATE_CHARS.
		const BUDGET = 2000;

		it("keeps every astral character whole across the budget boundary", () => {
			for (const offset of offsetsAround(BUDGET)) {
				const value = `${filler(offset)}${ASTRAL}${filler(BUDGET)}`;
				const out = truncateForPrompt(value);
				expect({ offset, at: loneSurrogateOffset(out) }).toEqual({ offset, at: -1 });
			}
		});

		it("still truncates, and reports the elided count in code points", () => {
			const value = `${filler(BUDGET - 1)}${ASTRAL}${filler(100)}`;
			const out = truncateForPrompt(value);
			// 2100 code points in, 2000 kept, so 100 elided — not 101, which is
			// what counting the astral character as two units would report.
			expect(out).toContain("[…100ch elided…]");
			expect(out.startsWith(filler(BUDGET - 1))).toBe(true);
		});

		it("returns a short astral string untouched even when its code-unit length exceeds the budget", () => {
			// 1500 astral characters = 3000 code units but only 1500 code points,
			// so it fits a 2000-character budget and must not be cut at all.
			const value = ASTRAL.repeat(1500);
			expect(truncateForPrompt(value)).toBe(value);
		});
	});

	describe("the eval display() truncator", () => {
		// MAX_DISPLAY_TEXT_CHARS, mirrored from tools/eval.ts.
		const BUDGET = 8000;

		it("keeps every astral character whole across the budget boundary", () => {
			for (const offset of offsetsAround(BUDGET)) {
				const value = `${filler(offset)}${ASTRAL}${filler(BUDGET)}`;
				const out = formatDisplayJsonForText(value);
				expect({ offset, at: loneSurrogateOffset(out) }).toEqual({ offset, at: -1 });
			}
		});

		it("truncates a long value and leaves a short one alone", () => {
			const short = formatDisplayJsonForText("hello");
			expect(short).toBe('"hello"');
			const long = formatDisplayJsonForText(filler(BUDGET + 50));
			expect(long).toContain("ch elided…]");
		});
	});

	describe("the ast_edit diff preview truncator", () => {
		// DIFF_PREVIEW_MAX_CHARS, mirrored from tools/ast-edit.ts.
		const BUDGET = 120;
		// `oldApi("` — the matched node's prefix before the swept filler starts.
		const PREFIX = 8;

		let settingsState: SettingsTestState | undefined;
		let tmpDir: string;

		beforeAll(async () => {
			settingsState = beginSettingsTest();
			await Settings.init({ inMemory: true });
		});

		afterAll(() => {
			restoreSettingsTestState(settingsState);
			settingsState = undefined;
		});

		beforeEach(async () => {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "astedit-astral-"));
		});

		afterEach(async () => {
			await removeWithRetries(tmpDir);
		});

		function session() {
			return makeToolSession({
				cwd: tmpDir,
				hasUI: false,
				getSessionFile: () => path.join(tmpDir, "s.jsonl"),
				getSessionSpawns: () => "*",
				getArtifactsDir: () => path.join(tmpDir, "artifacts"),
				settings: Settings.isolated({
					"read.summarize.enabled": false,
					"lsp.formatOnWrite": false,
					"lsp.diagnosticsOnWrite": false,
				}),
				enableLsp: false,
			});
		}

		it("keeps every astral character whole across the preview boundary", async () => {
			for (const offset of offsetsAround(BUDGET - PREFIX)) {
				const file = path.join(tmpDir, `case-${offset}.ts`);
				const literal = `${filler(offset)}${ASTRAL}${filler(BUDGET)}`;
				await fs.writeFile(file, `oldApi("${literal}");\n`, "utf8");

				const tool = new AstEditTool(session());
				const result = await tool.execute(
					"call-1",
					{ ops: [{ pat: "oldApi($A)", out: "newApi($A)" }], paths: [file] },
					new AbortController().signal,
				);
				const out = textOf(result);
				expect({ offset, at: loneSurrogateOffset(out) }).toEqual({ offset, at: -1 });
				// The preview really was cut, so the sweep is exercising the boundary.
				expect(out).not.toContain(literal);
			}
		});
	});
});
