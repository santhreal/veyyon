/**
 * A surface holding content back says so in one voice.
 *
 * THE DEFECT. One fact — there is more, and here is how much — was written out at
 * forty sites and no two agreed. The advisor note card said `… +3 more notes`, the
 * subagent comms view `… 3 more lines · e expand`, the hook picker
 * `[…3 more lines…]`, the rule-injection notice `… +3 more (e to expand)` in
 * italic muted, the LSP hover and the tree lists the same count in `muted` while
 * the block directly above them used `dim`, and the todo reminder invented
 * `… 3 more in todo state`. Four decorations, three weights, two ways of naming
 * the key that expands it, and one hand-rolled plural per site.
 *
 * THE CLASS IT CLOSES. A fold row whose sentence or weight is composed at the
 * call site. `foldText` owns the sentence and `foldRow` owns the sentence plus
 * the one weight it is drawn in; the expand hint is `expandHintFor`, which is the
 * spelling the tool blocks already used. A forty-first site that writes the
 * sentence by hand, or paints the owner's sentence `muted`, turns the sweep below
 * red rather than shipping a second dialect.
 *
 * WHAT IT DOES NOT CATCH.
 * - The chevron chip `▸ ctrl+o expand` from `formatExpandHint`. That is the fold
 *   dialect shared with settings and `ModalShell` — a chip beside the row rather
 *   than a hint inside it — and it is deliberately a separate shape.
 * - The dropped row (`… 12 earlier lines dropped (streaming)`). Dropped is not
 *   hidden: expanding cannot bring those lines back, so it must not read like a
 *   fold. It has its own owner and its own class, next door in
 *   `a-dropped-row-says-what-is-gone-in-one-voice.test.ts`.
 * - `export/html/template.js`, which renders `... (N more lines)` in HTML from its
 *   own template and shares no code with the terminal renderers.
 * - The error message in `config/config-file.ts`, allowlisted below with its
 *   reason.
 * - Whether the row is legible at a given contrast, which is a capture's job.
 */

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { buildStatusFooter } from "@veyyon/coding-agent/modes/components/execution-shared";
import { foldRow, foldText } from "@veyyon/coding-agent/modes/components/fold-row";
import { renderTodoBoardLines, type TodoBoardOptions } from "@veyyon/coding-agent/modes/components/todo-board";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { Theme } from "@veyyon/coding-agent/modes/theme/theme-class";
import { actionKeyHint } from "@veyyon/coding-agent/modes/utils/key-hint";
import type { TodoItem, TodoPhase } from "@veyyon/coding-agent/tools/todo";
import { renderFileList } from "@veyyon/coding-agent/tui/file-list";
import { renderTreeList } from "@veyyon/coding-agent/tui/tree-list";
import { resetKeybindingsForTests, setKeybindings } from "@veyyon/tui";

const SRC = path.resolve(import.meta.dir, "../../../src");

/** The owner, and the two files that define the phrase and the hint it composes. */
const OWNER = "modes/components/fold-row.ts";

/**
 * An error message, not a row: it states a total (`… 4 more of 30 problems not
 * shown`) that a fold row has no place for, and `ConfigFileError` lives in
 * `config/`, which must not reach a painter to report a bad settings file.
 */
const PROSE_EXEMPT = ["config/config-file.ts"];

/** Every `.ts` under `src`, vendored trees and tests excluded. */
function sources(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "vendor") sources(full, found);
			continue;
		}
		if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(full);
	}
	return found;
}

/** Source lines, comments dropped, as `[line number, text]`. */
function codeLines(source: string): Array<[number, string]> {
	return source
		.split("\n")
		.map((line, index): [number, string] => [index + 1, line])
		.filter(([, line]) => {
			const start = line.trimStart();
			return !start.startsWith("*") && !start.startsWith("//") && !start.startsWith("/*");
		});
}

/**
 * A fold sentence composed at the call site: an ellipsis, a count, and `more`.
 * The count is either interpolated or a literal, and `+3` is matched too because
 * that was one of the shapes.
 */
const HAND_WRITTEN_FOLD = /(?:…|\.\.\.)\s*(?:\$\{[^}]*\}|\+?\d+)\s*more\b/;

/** The owner's sentence painted in the weight the class does not use. */
const WRONG_WEIGHT = /fg\(\s*"muted"\s*,\s*fold(?:Text|Row)\(/;

function offenders(pattern: RegExp, perFile = false): string[] {
	return sources(SRC).flatMap(file => {
		const relative = path.relative(SRC, file);
		if (relative === OWNER) return [];
		const source = fs.readFileSync(file, "utf8");
		if (perFile) return pattern.test(source) ? [relative] : [];
		return codeLines(source)
			.filter(([, line]) => pattern.test(line))
			.map(([number]) => `${relative}:${number}`);
	});
}

describe("the fold row's owner", () => {
	beforeAll(() => {
		initTheme();
	});

	/**
	 * The plural, which is the whole reason the phrase has an owner: every one of
	 * the forty sites rolled its own, and several said "1 more lines".
	 */
	it("keeps the noun singular at exactly one", () => {
		expect(foldText(1)).toBe("… 1 more line");
		expect(foldText(3)).toBe("… 3 more lines");
		expect(foldText(1, { noun: "entry" })).toBe("… 1 more entry");
		expect(foldText(2, { noun: "entry" })).toBe("… 2 more entries");
		expect(foldText(4, { noun: "note" })).toBe("… 4 more notes");
	});

	/**
	 * A count from bad arithmetic reads as zero rather than `NaN` or `Infinity`.
	 * Every fold count in the product is a subtraction of two lengths.
	 */
	it("floors a non-finite count instead of printing it", () => {
		expect(foldText(Number.NaN)).toBe("… 0 more lines");
		expect(foldText(Number.POSITIVE_INFINITY, { noun: "file" })).toBe("… 0 more files");
	});

	/**
	 * The hint, in the product's one spelling. A surface with nothing bound to the
	 * gesture states the count alone: a hint naming no key is worse than none.
	 */
	it("names the expand key in one shape, and omits it when there is none", () => {
		expect(foldText(8, { expandKey: "ctrl+o" })).toBe("… 8 more lines (ctrl+o to expand)");
		expect(foldText(8, { expandKey: "" })).toBe("… 8 more lines");
		expect(foldText(8)).toBe("… 8 more lines");
	});

	/** The row is the sentence in one weight, and nothing else. */
	it("draws the sentence dim", () => {
		expect(foldRow(3, { noun: "note" })).toBe(theme.fg("dim", "… 3 more notes"));
	});

	/**
	 * A renderer handed a theme paints with THAT theme. The HTML export renders a
	 * transcript in a theme that is not the session's, so a row reading the active
	 * singleton would come out in the wrong palette.
	 */
	it("paints with the theme it was handed rather than the active one", () => {
		const stub = { fg: (color: unknown, text: string) => `<${String(color)}>${text}` } as unknown as Theme;

		expect(foldRow(2, { theme: stub })).toBe("<dim>… 2 more lines");
	});
});

describe("every surface that folds reaches the owner", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		resetKeybindingsForTests();
	});

	/**
	 * The execution block, which is the fold a user meets most often and the only
	 * one whose key comes from the remappable `app.tools.expand`.
	 */
	it("states the hidden line count under a tool block", () => {
		setKeybindings(KeybindingsManager.inMemory());
		const expandKey = actionKeyHint("app.tools.expand");
		// Non-vacuity: with nothing bound, the row below equals the row without a
		// hint and the assertion would pass while the hint was gone.
		expect(expandKey).not.toBe("");

		const footer = buildStatusFooter({
			status: "complete",
			exitCode: 0,
			truncation: undefined,
			hiddenLineCount: 80,
		});

		expect(footer?.getText() ?? "").toContain(foldRow(80, { expandKey }));
	});

	/** The anchored todo board, whose fold counts stages rather than lines. */
	it("counts the stages the board could not draw", () => {
		const phases: TodoPhase[] = Array.from({ length: 8 }, (_unused, index) => ({
			name: `Phase ${index}`,
			tasks: [{ content: `task ${index}`, status: "pending" } satisfies TodoItem],
		}));
		const options: TodoBoardOptions = {
			columns: 100,
			maxRows: 6,
			expanded: false,
			owned: new Set<string>(),
			frame: 0,
			animate: false,
			live: false,
		};

		const lines = renderTodoBoardLines(phases, options).map(line => Bun.stripANSI(line));
		const fold = lines.find(line => line.includes(" more stage"));
		const hidden = Number(/… (\d+) more stages?\b/.exec(fold ?? "")?.[1] ?? "0");

		expect(hidden).toBeGreaterThan(0);
		expect(fold).toContain(foldText(hidden, { noun: "stage" }));
	});

	/** A collapsed file list, which is a tool block's list rather than a card's. */
	it("counts the files a collapsed list withheld", () => {
		const files = Array.from({ length: 7 }, (_unused, index) => ({ path: `src/file-${index}.ts` }));

		const lines = renderFileList({ files, maxCollapsed: 3, showIcons: false }, theme);

		expect(lines.at(-1)).toBe(foldRow(4, { noun: "file", theme }));
	});

	/**
	 * A collapsed tree list, whose row used `muted` while the block above it used
	 * `dim`. It also carries the caller's own noun, so the sweep cannot be green
	 * because every site happens to say "line".
	 */
	it("counts the tree rows it withheld, in the same weight", () => {
		const items = Array.from({ length: 9 }, (_unused, index) => `item ${index}`);

		const lines = renderTreeList({ items, maxCollapsed: 4, itemType: "match", renderItem: item => item }, theme);

		expect(lines.at(-1)).toContain(foldRow(5, { noun: "match", theme }));
	});
});

describe("no surface composes a fold row by hand", () => {
	/**
	 * The scan reads a real tree and can see the owner's callers. A walk that found
	 * nothing would satisfy both rules below while checking nothing, which is the
	 * failure mode of every gate built on a source scan.
	 */
	it("reads the whole source tree", () => {
		const files = sources(SRC);

		expect(files.length).toBeGreaterThan(500);
		expect(files.some(file => file.endsWith(path.join("modes", "components", "fold-row.ts")))).toBe(true);
	});

	/**
	 * The rule. A failure names the file and line; the fix is `foldRow(n, { noun })`
	 * for a row the surface paints, or `foldText` when the caller measures or
	 * envelopes it.
	 */
	it("has no fold sentence written at a call site", () => {
		const found = offenders(HAND_WRITTEN_FOLD).filter(
			entry => !PROSE_EXEMPT.includes(entry.slice(0, entry.lastIndexOf(":"))),
		);

		expect(
			found.sort(),
			"this composes the fold sentence inline. Use foldRow/foldText from modes/components/fold-row",
		).toEqual([]);
	});

	/**
	 * The exemption is pinned by exact equality rather than by count, so a second
	 * file cannot join it silently.
	 */
	it("exempts only the config error message", () => {
		const found = offenders(HAND_WRITTEN_FOLD).map(entry => entry.slice(0, entry.lastIndexOf(":")));

		expect([...new Set(found)].sort()).toEqual(PROSE_EXEMPT);
	});

	/**
	 * The second half: the sentence can come from the owner and still be drawn in
	 * the wrong weight, which is how eight of the forty sites read. `muted` around
	 * the owner's sentence is the shape that regressed.
	 */
	it("never paints the owner's sentence muted", () => {
		expect(
			offenders(WRONG_WEIGHT, true).sort(),
			"a fold row is dim. Call foldRow instead of painting foldText muted",
		).toEqual([]);
	});

	/**
	 * And both patterns really match what they forbid, so neither rule is green
	 * because of a typo in a regex.
	 */
	it("recognizes the shapes it forbids", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: source-text fixtures for the banned shapes
		expect(HAND_WRITTEN_FOLD.test("push(`… ${hidden} more notes`)")).toBe(true);
		expect(HAND_WRITTEN_FOLD.test("push(`… +3 more lines`)")).toBe(true);
		expect(HAND_WRITTEN_FOLD.test('out += "... 3 more items"')).toBe(true);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: source-text fixture for the accepted call
		expect(HAND_WRITTEN_FOLD.test('push(`${foldText(hidden, { noun: "note" })}`)')).toBe(false);
		expect(WRONG_WEIGHT.test('push(theme.fg("muted", foldText(remaining, { noun: "file" })))')).toBe(true);
		expect(WRONG_WEIGHT.test('push(theme.fg("dim", foldText(remaining, { noun: "file" })))')).toBe(false);
	});
});
