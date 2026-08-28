import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	getAllSettingDefs,
	invalidateSettingDefsCache,
} from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-defs";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { SearchTool } from "@veyyon/coding-agent/tools/search";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

/**
 * WHY THIS SUITE EXISTS (Contract & Regression Suite):
 *
 * A tool result is not paid for once. It stays in the transcript, so every line
 * a text search returns is sent again on every later request of the session,
 * and a context window that is one line too wide is billed once per remaining
 * request. `search.contextAfter` arrived at 3 from the retired `grep` tool,
 * where the number sized a terminal code frame rather than a token bill, and
 * nothing observed the window: every existing suite sets both context settings
 * explicitly, so the declared default could widen with no test failing.
 *
 * The class this closes is wider than the one default: a context setting whose
 * declared value is not the window the tool emits. Both settings are swept over
 * the option values they declare, read from the setting definitions at run time,
 * so a new option value is exercised the moment it is declared and an option
 * the engine cannot honor fails here.
 *
 * What this suite does NOT catch: the byte budget that compacts a broad
 * multi-file result (`text-search-progressive-disclosure.test.ts` owns that),
 * the TUI code frame built from the same match set, and column truncation of a
 * long line (`text-search-seen-lines-and-scope-provenance.test.ts` owns that).
 */

/** A match row is `*<line>:<body>`; a context row is ` <line>:<body>`. */
const MATCH_ROW = /^\*(\d+):/;
const CONTEXT_ROW = /^ (\d+):/;

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
}

interface Window {
	before: number[];
	match: number;
	after: number[];
}

/**
 * Group the emitted rows into per-match windows. Leading context rows attach to
 * the match that follows them, trailing rows to the match that precedes them.
 */
function windowsOf(text: string): Window[] {
	const windows: Window[] = [];
	let pending: number[] = [];
	for (const row of text.split("\n")) {
		const match = MATCH_ROW.exec(row);
		if (match) {
			windows.push({ before: pending, match: Number(match[1]), after: [] });
			pending = [];
			continue;
		}
		const context = CONTEXT_ROW.exec(row);
		if (!context) continue;
		const lineNumber = Number(context[1]);
		const current = windows.at(-1);
		// A context row belongs to the preceding match while it is still adjacent
		// to what that match already emitted; otherwise it leads the next match.
		if (current && lineNumber > current.match && lineNumber <= current.match + current.after.length + 1) {
			current.after.push(lineNumber);
			continue;
		}
		pending.push(lineNumber);
	}
	return windows;
}

/**
 * The option values the setting declares, read at run time. A number setting
 * with a picker is a `submenu` def, so a new option value joins the sweep the
 * moment it is declared.
 */
function declaredOptions(settingPath: string): number[] {
	invalidateSettingDefsCache();
	const def = getAllSettingDefs().find(entry => entry.path === settingPath);
	if (!def) throw new Error(`setting ${settingPath} is not declared`);
	if (!("options" in def)) throw new Error(`setting ${settingPath} declares no option values`);
	const options: number[] = [];
	for (const option of def.options) {
		const value = Number(option.value);
		if (Number.isFinite(value)) options.push(value);
	}
	if (options.length === 0) throw new Error(`setting ${settingPath} declares no numeric option values`);
	return options;
}

/** The default in effect, taken from a settings instance with no overrides. */
function declaredDefault(settingPath: "search.contextBefore" | "search.contextAfter"): number {
	return Settings.isolated().get(settingPath);
}

describe("a search result shows one line of trailing context", () => {
	let tmpDir = "";
	// 40 numbered lines, one needle far enough from both edges that any declared
	// window fits without clamping.
	const LINE_COUNT = 40;
	const NEEDLE_LINE = 20;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-context-window-"));
		const lines: string[] = [];
		for (let lineNumber = 1; lineNumber <= LINE_COUNT; lineNumber++) {
			lines.push(lineNumber === NEEDLE_LINE ? "context-window-needle" : `filler line ${lineNumber}`);
		}
		await fs.writeFile(path.join(tmpDir, "ctx.txt"), `${lines.join("\n")}\n`, "utf-8");
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function sessionWith(overrides: Record<string, unknown> = {}): ToolSession {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getTurnIndex: () => 0,
			getSessionFile: () => null,
			settings: Settings.isolated(overrides),
		});
	}

	async function search(session: ToolSession, args: Record<string, unknown>): Promise<string> {
		const tool = new SearchTool(session);
		return extractText(await tool.execute("search-window", args as never));
	}

	it("emits one leading and one trailing context line per match at the declared defaults", async () => {
		const text = await search(sessionWith(), { type: "text", input: "context-window-needle", path: "ctx.txt" });
		const windows = windowsOf(text);

		expect(windows).toEqual([{ before: [NEEDLE_LINE - 1], match: NEEDLE_LINE, after: [NEEDLE_LINE + 1] }]);
	});

	it("keeps both declared defaults at one line, so a wider window is a recorded decision", () => {
		// Exact equality, not an upper bound: widening either default re-prices
		// every later request of every session and belongs in a commit that says so.
		expect(declaredDefault("search.contextBefore")).toBe(1);
		expect(declaredDefault("search.contextAfter")).toBe(1);
	});

	it("emits exactly the number of leading lines the setting declares, for every declared option", async () => {
		const options = declaredOptions("search.contextBefore");
		for (const before of options) {
			const text = await search(sessionWith({ "search.contextBefore": before, "search.contextAfter": 0 }), {
				type: "text",
				input: "context-window-needle",
				path: "ctx.txt",
			});
			const windows = windowsOf(text);
			const expected: number[] = [];
			for (let offset = before; offset >= 1; offset--) expected.push(NEEDLE_LINE - offset);

			expect(windows).toEqual([{ before: expected, match: NEEDLE_LINE, after: [] }]);
		}
	});

	it("emits exactly the number of trailing lines the setting declares, for every declared option", async () => {
		const options = declaredOptions("search.contextAfter");
		for (const after of options) {
			const text = await search(sessionWith({ "search.contextBefore": 0, "search.contextAfter": after }), {
				type: "text",
				input: "context-window-needle",
				path: "ctx.txt",
			});
			const windows = windowsOf(text);
			const expected: number[] = [];
			for (let offset = 1; offset <= after; offset++) expected.push(NEEDLE_LINE + offset);

			expect(windows).toEqual([{ before: [], match: NEEDLE_LINE, after: expected }]);
		}
	});

	it("never emits a shared line twice when two match windows overlap", async () => {
		// Needles two lines apart: at 1/1 the line between them is the trailing
		// context of the first match and the leading context of the second.
		const lines: string[] = [];
		for (let lineNumber = 1; lineNumber <= LINE_COUNT; lineNumber++) {
			lines.push(
				lineNumber === NEEDLE_LINE || lineNumber === NEEDLE_LINE + 2
					? "context-window-needle"
					: `filler line ${lineNumber}`,
			);
		}
		await fs.writeFile(path.join(tmpDir, "ctx.txt"), `${lines.join("\n")}\n`, "utf-8");

		const text = await search(sessionWith(), { type: "text", input: "context-window-needle", path: "ctx.txt" });
		const emitted: number[] = [];
		for (const row of text.split("\n")) {
			const row1 = MATCH_ROW.exec(row);
			const row2 = CONTEXT_ROW.exec(row);
			if (row1) emitted.push(Number(row1[1]));
			else if (row2) emitted.push(Number(row2[1]));
		}

		expect(emitted).toEqual([NEEDLE_LINE - 1, NEEDLE_LINE, NEEDLE_LINE + 1, NEEDLE_LINE + 2, NEEDLE_LINE + 3]);
	});
});
