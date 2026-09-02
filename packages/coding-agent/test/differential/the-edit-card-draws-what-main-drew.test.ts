/**
 * The `edit` card draws what main's renderer drew, for the change, the failure and every operation.
 *
 * The rows of a change are compared as terminal bytes -- the highlighter's colours, the marker
 * column, the line numbers and the inverse fill of an added run included -- and so are the failure
 * card, the delete row, the move row, the no-op sentence and the diagnostics group.
 *
 * TWELVE DIFFERENCES ARE PINNED AS EXCEPTION CELLS rather than waived in a normalizer:
 *
 *  - THE CHANGE COUNTS ARE THE ROW'S META. Main appended its own bracketed suffix to the header,
 *    `⟦+1/-1⟧`; the counts are two facts about the change rather than part of the file's name, so
 *    they are meta entries the host separates with its own dot. Same numbers, same colours, one
 *    column narrower, which makes every row of that card one column narrower with it. Every cell
 *    below therefore compares the counts through `sameRows`, which reduces both spellings to the
 *    coloured numbers in them and drops the trailing pad the width change moves.
 *  - THE HELD-BACK NOTE IS THE HOST'S SENTENCE, `… N more lines ▸ Ctrl+O expand`, where main wrote
 *    `… (6 more hunks, 16 more lines)` under a settled change and `… (10 more hunks, 30 more lines
 *    above)` over a streaming one. How many rows a change occupies is known only after it wraps, so
 *    the window and the note it hangs are the host's, and every card in the transcript now states a
 *    held-back count in one sentence.
 *  - THE NOTE IS ONE OF THE ROWS THE WINDOW MAY SPEND, so a streaming preview keeps one row fewer
 *    than main, which pushed its note above a window it had already measured. Both arms keep the
 *    same newest rows.
 *  - A CARD THAT IS STILL ARRIVING carries the host's `… (streaming)` row, where main wrote
 *    `(preview)` under a collapsed preview and nothing under an expanded one. The host moves the
 *    animation off the head row so a live preview cannot pin the scrollback boundary.
 *  - EXPANDING A CALL REVEALS THE WHOLE REPLACEMENT. Main held six lines back at every disclosure,
 *    so a reader who expanded the card was shown the same six.
 *  - AN EDIT SPANNING SEVERAL FILES IS ONE CARD whose sections are the files. Main stacked a framed
 *    card per file with a blank row between them, repeated the `Edit:` header per file, and wrote
 *    the pending-file count as a bare row outside every card. A card is what one tool call produced,
 *    and a call that edited four files produced one.
 *  - A MULTI-FILE PREVIEW LABELS ITS FILES, where main drew a `── path ──` rule with a blank row on
 *    either side. A label is what a section carries in every other card here.
 *  - A MOVE'S ARROW CARRIES THE DESCRIPTION'S TONE. Main toned the arrow between the two paths dim.
 *    The row states one description, so the glyph inside it is drawn in that description's colour.
 *  - THE PATH IS FITTED TO THE CARD'S OWN WIDTH. Main reserved room for a box border it stopped
 *    drawing, so a long path was middle-elided four columns earlier than it needed to be.
 *  - DIAGNOSTICS FOLLOW THE CHANGE with no blank row between them. Main pushed one row of air in
 *    front of the group; spacing between sections is the host's.
 *  - A CALL WHOSE PATH HAS NOT ARRIVED draws its ellipsis in one muted run, where main opened the
 *    muted colour twice around it. The same colour, and the same glyph.
 *  - THE ROW ABOVE A HELD-BACK NOTE ends where its last glyph does. Main appended the note to the
 *    string it had coloured the change into, so that row carried a colour opened and closed with
 *    nothing in it.
 *
 * WHAT THIS SUITE DOES NOT CATCH. Nothing here runs an edit: what a card CLAIMS is owned by
 * `test/edit/*` and `test/tools/edit-renderer.test.ts`, and a `details` shape that changed meaning
 * would be drawn identically by both arms. It compares one theme and one set of ANSI capabilities.
 * It says nothing about the transcript component around the card -- merging a call with its result,
 * and the streamed argument buffer a preview is decoded from, are the component's.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { settings } from "@veyyon/coding-agent/config/settings";
import { type EditViewArgs, type EditViewResult, editToolView } from "@veyyon/coding-agent/edit/edit-view";
import { renderDiff } from "@veyyon/coding-agent/modes/terminal/components/transcript/diff";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import type { ToolViewContext } from "@veyyon/view";
import * as editOracle from "../oracles/edit-main-renderer";
import { framedView, renderCompLines, useDifferentialTheme, WIDTH } from "./harness";

/** Every OSC 8 target the rows carry, in the order they are drawn. */
function linkTargets(rows: readonly string[]): string[] {
	return rows.flatMap(row => [...row.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1] ?? ""));
}

/**
 * `apply_patch` is compared here and nowhere else, because it draws this card: its registry entry
 * and `edit`'s are built from the same `editToolView`. The coverage gate records that sharing as a
 * row, and a row is a claim about two objects nobody re-checked -- give `apply_patch` a card of its
 * own and the sharing row silently makes this suite its proof. So the identity is asserted where the
 * comparison happens, and every cell below covers both tools for exactly as long as it holds.
 */
describe("the card apply_patch draws", () => {
	it("is the card compared in this file", () => {
		expect(toolRenderers.apply_patch?.view).toBeDefined();
		expect(toolRenderers.apply_patch?.view).toBe(toolRenderers.edit?.view);
		expect(toolRenderers.edit?.view as unknown).toBe(editToolView);
	});
});

useDifferentialTheme();

describe("edit tool differential", () => {
	const DIFF = " 10│ const a = 1;\n-11│ const b = 2;\n+11│ const b = 3;\n 12│ const c = 4;";
	const LONG_DIFF = Array.from({ length: 40 }, (_, i) => `${i % 3 === 0 ? "+" : " "}${10 + i}│ line ${i}`).join("\n");
	/**
	 * Three small changes buried in long runs of unchanged lines, so the line bound is what cuts the
	 * collapsed card: a change of forty lines in eight hunks is cut by its hunk count instead, and one
	 * unbroken hunk is never cut at all.
	 */
	const CONTEXT_HEAVY_DIFF = Array.from({ length: 3 }, (_, hunk) =>
		[
			...Array.from({ length: 20 }, (_, i) => ` ${100 * hunk + i}│ context ${hunk}.${i}`),
			`-${100 * hunk + 20}│ before ${hunk}`,
			`+${100 * hunk + 20}│ after ${hunk}`,
		].join("\n"),
	).join("\n");
	/** A change whose rows are not next to each other in the file, in all three spellings. */
	const GAPPED_DIFF = " 10│ a\n+11│ b\n...\n 40│ c\n…\n\n 80│ d";
	const HOME = process.env.HOME ?? "/home/user";
	const LONG_PATH = "packages/coding-agent/src/modes/terminal/components/transcript/tool-execution.ts";

	/**
	 * The render context the terminal host built for an edit, which is the only shape the oracle ever
	 * saw in production: the resolved mode, the change computed for the call before the tool ran, the
	 * per-file changes of a multi-file call, and the transcript's own diff highlighter.
	 *
	 * The view reads all four off the call's arguments instead, so both arms are handed one set of
	 * values under the shape each one declares.
	 */
	function hostContext(args: EditViewArgs): editOracle.EditRenderContext {
		const files = args.previewFiles;
		return {
			...(args.editMode ? { editMode: args.editMode } : {}),
			...(args.preview ? { editDiffPreview: args.preview } : {}),
			...(files && files.length > 1 ? { perFileDiffPreview: files } : {}),
			renderDiff,
		};
	}

	const oracleArgs = (args: EditViewArgs): editOracle.EditRenderArgs => args as editOracle.EditRenderArgs;

	function oracleResult(
		result: EditViewResult,
		args: EditViewArgs,
		{ expanded = false, partial = false }: { expanded?: boolean; partial?: boolean } = {},
		width = WIDTH,
	): string[] {
		const options: RenderResultOptions & { renderContext?: editOracle.EditRenderContext } = {
			expanded,
			isPartial: partial,
			renderContext: hostContext(args),
		};
		return renderCompLines(
			editOracle.editToolRenderer.renderResult(
				result as editOracle.EditRenderResult,
				options,
				theme,
				oracleArgs(args),
			),
			width,
		);
	}

	function viewResult(
		result: EditViewResult,
		args: EditViewArgs,
		{ expanded = false, partial = false }: { expanded?: boolean; partial?: boolean } = {},
		width = WIDTH,
	): string[] {
		const context: ToolViewContext = { expanded, partial };
		return renderCompLines(drawToolView(editToolView.renderResult(result, context, args), theme), width);
	}

	function oracleCall(args: EditViewArgs, expanded = false, width = WIDTH, partial = true): string[] {
		return renderCompLines(
			editOracle.editToolRenderer.renderCall(
				oracleArgs(args),
				{ expanded, isPartial: partial, renderContext: hostContext(args) },
				theme,
			),
			width,
		);
	}

	function viewCall(args: EditViewArgs, expanded = false, width = WIDTH, partial = true): string[] {
		return renderCompLines(drawToolView(editToolView.renderCall(args, { expanded, partial }), theme), width);
	}

	const updated = (diff: string, path = "src/demo.ts", extra: Record<string, unknown> = {}): EditViewResult => ({
		content: [{ type: "text", text: `Updated ${path}` }],
		details: { diff, path, ...extra },
	});

	const plain = (rows: readonly string[]): string[] => rows.map(row => stripVTControlCharacters(row));

	/** A row's own text, with the card's rail and the pad around it taken off. */
	const body = (rows: readonly string[]): string[] => plain(rows).map(row => row.replace(/^▏\s?/, "").trimEnd());

	/** The pad a row carries between its last glyph and the reset that closes it. */
	const TRAILING_PAD = / +(?=(?:\u001b\[[0-9;]*m)*$)/;

	/** Main's bracketed stats suffix: a dim `⟦`, the coloured counts, a dim `/` between them, a dim `⟧`. */
	const MAIN_STATS =
		/\u001b\[[0-9;]+m⟦\u001b\[39m((?:\u001b\[[0-9;]+m[+-]\d+\u001b\[39m|\u001b\[[0-9;]+m\/\u001b\[39m)+)\u001b\[[0-9;]+m⟧\u001b\[39m/;

	/** The host's meta run for the same counts: one dim run holding the coloured counts and its own dot. */
	const VIEW_STATS =
		/\u001b\[[0-9;]+m((?:\u001b\[[0-9;]+m[+-]\d+\u001b\[39m)(?: · \u001b\[[0-9;]+m[+-]\d+\u001b\[39m)*)\u001b\[39m/;

	/** The dim `/` main wrote between two counts. */
	const MAIN_STATS_SEPARATOR = /\u001b\[[0-9;]+m\/\u001b\[39m/g;

	/**
	 * A row with the change counts reduced to the coloured numbers in them, and the trailing pad off.
	 *
	 * Both arms state the same two numbers in the same two colours; main bracketed them and separated
	 * them with a dim slash, and the host writes them as meta entries with its own dot between. The
	 * punctuation is one column wider in main, which widens the whole card, so the pad the change
	 * moves comes off with it. Everything else -- the icon, the title, the path, its link, the
	 * language glyph and every body row -- is compared byte for byte.
	 */
	const canonicalStats = (row: string): string =>
		row
			.replace(MAIN_STATS, (_match, counts: string) => `«${counts.replace(MAIN_STATS_SEPARATOR, "")}»`)
			.replace(VIEW_STATS, (_match, counts: string) => `«${counts.replaceAll(" · ", "")}»`)
			.replace(TRAILING_PAD, "");

	/** The two arms compared with the counts canonicalized, and nothing else moved. */
	const sameRows = (view: readonly string[], oracle: readonly string[], label?: string): void => {
		expect(view.map(canonicalStats), label).toEqual(oracle.map(canonicalStats));
	};

	/** The row each arm ends a still-arriving card with, which the cell below pins and no other reads. */
	const STREAMING_ROW = /^\s*(?:… )?\((?:streaming|preview)\)\s*$/;

	const withoutStreamingRow = (rows: readonly string[]): string[] =>
		rows.filter(row => !STREAMING_ROW.test(stripVTControlCharacters(row).replace(/^▏/, "")));

	/**
	 * The colour main opened for a held-back note on the row above it, closed with no glyph in it.
	 *
	 * Main appended the note to the same string it had coloured the change into, so the change's last
	 * row ends on an opened-and-closed muted run that draws nothing. The host writes the note as its
	 * own row, so the change's last row ends where its last glyph does.
	 */
	const NOTE_COLOUR_RESIDUE = /\u001b\[39m\u001b\[38;2;\d+;\d+;\d+m(?=(?:\u001b\[[0-9;]*m| )*$)/;

	/** The row a cut section ends on, whose wording is the host's and is pinned in an exception cell. */
	const NOTE_ROW = /(?:more|earlier) lines/;

	const withoutNoteRow = (rows: readonly string[]): string[] =>
		rows.filter(row => !NOTE_ROW.test(stripVTControlCharacters(row)));

	/** The two arms of a still-arriving card, compared without the row that says it is arriving. */
	const sameLiveRows = (view: readonly string[], oracle: readonly string[], label?: string): void => {
		sameRows(withoutStreamingRow(view), withoutStreamingRow(oracle), label);
	};

	describe("a settled change", () => {
		it("draws the change byte for byte, at every disclosure and every width", () => {
			for (const width of [200, WIDTH, 40]) {
				for (const expanded of [false, true]) {
					const args: EditViewArgs = { file_path: "src/demo.ts", editMode: "hashline" };
					const result = updated(DIFF, "src/demo.ts", { firstChangedLine: 11 });
					sameRows(
						viewResult(result, args, { expanded }, width),
						oracleResult(result, args, { expanded }, width),
						`width ${width} expanded ${expanded}`,
					);
				}
			}
		});

		it("cuts a change buried in context at the same line, and reveals all of it when expanded", () => {
			const result = updated(CONTEXT_HEAVY_DIFF);
			const args: EditViewArgs = { file_path: "src/demo.ts" };
			// Every row but the note, whose wording is the host's; both arms hold back the same count.
			sameRows(
				withoutNoteRow(viewResult(result, args)),
				withoutNoteRow(oracleResult(result, args)).map(row => row.replace(NOTE_COLOUR_RESIDUE, "")),
				"collapsed",
			);
			sameRows(
				viewResult(result, args, { expanded: true }),
				oracleResult(result, args, { expanded: true }),
				"expanded",
			);
			for (const rows of [viewResult(result, args), oracleResult(result, args)]) {
				expect(plain(rows).find(row => NOTE_ROW.test(row))).toContain("23 more lines");
			}
			// Anti-vacuity: the collapsed card really is cut, and expanding it really does reveal the rest.
			expect(viewResult(result, args).length).toBeLessThan(viewResult(result, args, { expanded: true }).length);
			expect(plain(viewResult(result, args, { expanded: true })).some(row => row.includes("context 0.0"))).toBe(
				true,
			);
			expect(plain(viewResult(result, args)).some(row => row.includes("context 0.0"))).toBe(false);
		});

		it("draws a change whose rows are not next to each other the same way, in every spelling of a gap", () => {
			const result = updated(GAPPED_DIFF);
			const args: EditViewArgs = { file_path: "src/demo.ts" };
			sameRows(viewResult(result, args), oracleResult(result, args));
			expect(plain(viewResult(result, args)).filter(row => row.trim().endsWith("…")).length).toBe(3);
		});

		it("shortens every path inside a failure, the one it edited and the ones the message quotes", () => {
			const path = `${HOME}/repo/src/demo.ts`;
			const result: EditViewResult = {
				content: [
					{
						type: "text",
						text: `Failed to apply patch to ${path}:\n  (${HOME}/repo/src/other.ts)\n  const a = 1;`,
					},
				],
				isError: true,
				details: { diff: "", path },
			};
			const args: EditViewArgs = { file_path: path };
			expect(viewResult(result, args)).toEqual(oracleResult(result, args));
			// Anti-vacuity: the home directory is off both the path the row names and the path the
			// message quotes inside its brackets.
			const drawn = plain(viewResult(result, args)).join("\n");
			expect(drawn).not.toContain(HOME);
			expect(drawn).toContain("(~/repo/src/other.ts)");
		});

		it("states the counts, the sentence and the rows of every settled shape the tool reports", () => {
			const cases: Array<{ label: string; result: EditViewResult; args: EditViewArgs }> = [
				{
					label: "a failure that still carries a change",
					result: {
						content: [{ type: "text", text: "Failed" }],
						isError: true,
						details: { diff: DIFF, path: "src/demo.ts" },
					},
					args: { file_path: "src/demo.ts" },
				},
				{
					label: "a delete that failed",
					result: {
						content: [{ type: "text", text: "Cannot delete src/old.ts: not found" }],
						isError: true,
						details: { diff: "", op: "delete", path: "src/old.ts" },
					},
					args: { file_path: "src/old.ts", op: "delete" },
				},
				{
					label: "a created file with nothing in it",
					result: {
						content: [{ type: "text", text: "Created" }],
						details: { diff: "", op: "create", path: "src/empty.ts" },
					},
					args: { file_path: "src/empty.ts", op: "create" },
				},
				{
					label: "a settled result beside a change computed while it streamed",
					result: { content: [{ type: "text", text: "x" }], details: { diff: "", path: "src/demo.ts" } },
					args: { file_path: "src/demo.ts", preview: { diff: DIFF, firstChangedLine: undefined } },
				},
				{
					// A result that reports no change at all, which is not the same as reporting an empty
					// one: the computed change is still a call-phase artifact and the card states neither
					// its counts nor the line it starts at.
					label: "a settled result carrying no change, beside a computed one",
					result: {
						content: [{ type: "text", text: "x" }],
						details: { path: "src/demo.ts" } as EditViewResult["details"],
					},
					args: { file_path: "src/demo.ts", preview: { diff: DIFF, firstChangedLine: 11 } },
				},
				{
					label: "a move that failed, naming both paths with nothing between them",
					result: {
						content: [
							{
								type: "text",
								text: `Cannot move ${HOME}/repo/src/old.ts→${HOME}/repo/src/new.ts: destination exists`,
							},
						],
						isError: true,
						details: { diff: "", path: `${HOME}/repo/src/new.ts` },
					},
					args: { file_path: `${HOME}/repo/src/old.ts` },
				},
				{
					label: "one file reported through the per-file list",
					result: {
						content: [{ type: "text", text: "x" }],
						details: { diff: "", perFileResults: [{ path: "src/one.ts", diff: DIFF }] },
					},
					args: { edits: [{ path: "src/one.ts" }] },
				},
				{
					label: "a failure written for a reader",
					result: {
						content: [{ type: "text", text: "raw error text" }],
						isError: true,
						details: {
							diff: "",
							path: "src/demo.ts",
							displayErrorText: "the reader's version of the failure",
						} as EditViewResult["details"],
					},
					args: { file_path: "src/demo.ts" },
				},
			];
			for (const { label, result, args } of cases) {
				sameRows(viewResult(result, args), oracleResult(result, args), label);
				sameRows(
					viewResult(result, args, { expanded: true }),
					oracleResult(result, args, { expanded: true }),
					label,
				);
			}
			// Anti-vacuity: the reader's version of a failure is the one that reaches the card, and a
			// failed edit states no counts even when the change it failed halfway through is known.
			const shape = (label: string): { result: EditViewResult; args: EditViewArgs } => {
				const found = cases.find(entry => entry.label === label);
				if (!found) throw new Error(`no case labelled ${label}`);
				return found;
			};
			const drawnFor = (label: string): string[] => {
				const { result, args } = shape(label);
				return plain(viewResult(result, args));
			};
			const reader = drawnFor("a failure written for a reader").join("\n");
			expect(reader).toContain("the reader's version of the failure");
			expect(reader).not.toContain("raw error text");
			expect(drawnFor("a failure that still carries a change")[0]).not.toContain("+1");
			// A settled result is authoritative: the change computed while the call streamed says one
			// file changed, and the result says none did.
			expect(drawnFor("a settled result beside a change computed while it streamed").join("\n")).toContain(
				"No changes were made to src/demo.ts.",
			);
			expect(drawnFor("a settled result carrying no change, beside a computed one")[0]).not.toContain("+1");
			// Both paths of a failed move lose the home directory, including the one glued to the arrow,
			// which is past the first word of the token it sits in.
			const movedText = drawnFor("a move that failed, naming both paths with nothing between them").join("\n");
			expect(movedText).toContain("~/repo/src/old.ts→~/repo/src/new.ts");
			expect(movedText).not.toContain(HOME);
		});

		it("links the row to the same file main linked, at the same line, over a change and a move", () => {
			settings.override("tui.hyperlinks", "always");
			try {
				const edited: EditViewResult = {
					content: [{ type: "text", text: "x" }],
					details: { diff: DIFF, path: `${HOME}/repo/src/demo.ts`, firstChangedLine: 11 },
				};
				const editedArgs: EditViewArgs = { file_path: `${HOME}/repo/src/demo.ts` };
				expect(linkTargets(viewResult(edited, editedArgs))).toEqual(linkTargets(oracleResult(edited, editedArgs)));
				expect(linkTargets(viewResult(edited, editedArgs))).toEqual([`file://${HOME}/repo/src/demo.ts?line=11`]);
				const moved: EditViewResult = {
					content: [{ type: "text", text: "x" }],
					details: { diff: DIFF, path: `${HOME}/repo/src/new.ts`, move: `${HOME}/repo/src/new.ts` },
				};
				const movedArgs: EditViewArgs = {
					file_path: `${HOME}/repo/src/old.ts`,
					rename: `${HOME}/repo/src/new.ts`,
				};
				// A move points at where the file ended up, which is what a reader opens. Main drew the
				// same target twice, once per half of the description it split around the arrow.
				expect([...new Set(linkTargets(viewResult(moved, movedArgs)))]).toEqual([
					...new Set(linkTargets(oracleResult(moved, movedArgs))),
				]);
				expect(linkTargets(viewResult(moved, movedArgs))).toEqual([`file://${HOME}/repo/src/new.ts`]);
				// A move whose result still names the source: the row points at the destination, which is
				// the file that now exists. Main linked each half of its split description separately, so
				// it pointed at both.
				const stillSource: EditViewResult = {
					content: [{ type: "text", text: "x" }],
					details: { diff: DIFF, path: `${HOME}/repo/src/old.ts` },
				};
				expect(linkTargets(viewResult(stillSource, movedArgs))).toEqual([`file://${HOME}/repo/src/new.ts`]);
				expect(linkTargets(oracleResult(stillSource, movedArgs))).toEqual([
					`file://${HOME}/repo/src/old.ts`,
					`file://${HOME}/repo/src/new.ts`,
				]);
			} finally {
				settings.clearOverride("tui.hyperlinks");
			}
		});

		it("states the file's language on the row, which a host with a glyph for it draws", () => {
			const view = editToolView.renderResult(
				updated(DIFF),
				{ expanded: false, partial: false },
				{
					file_path: "src/demo.ts",
				},
			);
			expect(framedView(view).header.language).toBe("typescript");
			// A call whose path has not arrived names no language, so a host draws no glyph for one.
			expect(framedView(editToolView.renderCall({ previewDiff: DIFF }, { expanded: false })).header.language).toBe(
				undefined,
			);
		});

		it("draws a created file's rows, and a deleted file's one row, byte for byte", () => {
			const created: EditViewResult = {
				content: [{ type: "text", text: "Created src/new.ts" }],
				details: { diff: "+1│ hello\n+2│ world", op: "create", path: "src/new.ts" },
			};
			sameRows(
				viewResult(created, { file_path: "src/new.ts", op: "create" }),
				oracleResult(created, { file_path: "src/new.ts", op: "create" }),
			);
			const deleted: EditViewResult = {
				content: [{ type: "text", text: "Deleted src/old.ts" }],
				details: { diff: "", op: "delete", path: "src/old.ts" },
			};
			expect(viewResult(deleted, { file_path: "src/old.ts", op: "delete" })).toEqual(
				oracleResult(deleted, { file_path: "src/old.ts", op: "delete" }),
			);
		});

		it("states the same sentence when the edit changed nothing", () => {
			const result: EditViewResult = {
				content: [{ type: "text", text: "No changes" }],
				details: { diff: "", path: "src/demo.ts" },
			};
			for (const expanded of [false, true]) {
				expect(viewResult(result, { file_path: "src/demo.ts" }, { expanded })).toEqual(
					oracleResult(result, { file_path: "src/demo.ts" }, { expanded }),
				);
			}
		});

		it("draws the failure card byte for byte, however many lines the message carries", () => {
			const short: EditViewResult = {
				content: [{ type: "text", text: "Failed to apply patch to src/demo.ts:\n  const a = 1;" }],
				isError: true,
				details: { diff: "", path: "src/demo.ts" },
			};
			const long: EditViewResult = {
				content: [
					{
						type: "text",
						text: `Failed to apply patch to src/demo.ts:\n${Array.from({ length: 20 }, (_, i) => `  line ${i}`).join("\n")}`,
					},
				],
				isError: true,
				details: { diff: "", path: "src/demo.ts" },
			};
			for (const result of [short, long]) {
				for (const expanded of [false, true]) {
					expect(viewResult(result, { file_path: "src/demo.ts" }, { expanded })).toEqual(
						oracleResult(result, { file_path: "src/demo.ts" }, { expanded }),
					);
				}
			}
		});

		it("falls back to the computed change when the tool reported no details, error included", () => {
			const bare: EditViewResult = { content: [{ type: "text", text: "" }] };
			sameRows(
				viewResult(bare, { file_path: "src/demo.ts", preview: { diff: DIFF, firstChangedLine: undefined } }),
				oracleResult(bare, { file_path: "src/demo.ts", preview: { diff: DIFF, firstChangedLine: undefined } }),
			);
			const failed: EditViewArgs = { file_path: "src/demo.ts", preview: { error: "no preview for src/demo.ts" } };
			expect(viewResult(bare, failed)).toEqual(oracleResult(bare, failed));
		});

		it("wraps a row wider than the card the same way, gutter and all", () => {
			const wide = updated(`+12│ ${"x".repeat(120)}`);
			sameRows(
				viewResult(wide, { file_path: "src/demo.ts" }, {}, 60),
				oracleResult(wide, { file_path: "src/demo.ts" }, {}, 60),
			);
		});
	});

	describe("a pending call", () => {
		it("draws the computed change byte for byte, at every disclosure and every width", () => {
			for (const width of [200, WIDTH, 40]) {
				for (const expanded of [false, true]) {
					const args: EditViewArgs = {
						file_path: "src/demo.ts",
						previewDiff: DIFF,
						preview: { diff: DIFF, firstChangedLine: undefined },
						editMode: "hashline",
					};
					sameLiveRows(
						viewCall(args, expanded, width),
						oracleCall(args, expanded, width),
						`width ${width} expanded ${expanded}`,
					);
				}
			}
		});

		it("names the file the same way before the change is computed, over every way a call carries one", () => {
			const cases: EditViewArgs[] = [
				{ input: "[src/demo.ts#A1B2]\nSWAP 1.=1:\n+const a = 2;", editMode: "hashline" },
				{ __partialJson: '{"path":"src/demo.ts","old', editMode: "replace" },
				{ edits: [{ path: "src/demo.ts" }], editMode: "replace" },
			];
			for (const args of cases) {
				sameLiveRows(viewCall(args), oracleCall(args), JSON.stringify(args));
			}
		});

		it("draws a change the call carried itself, and a move that carries one, as the same card", () => {
			const ownDiff: EditViewArgs = { file_path: "src/demo.ts", diff: DIFF, op: "update", editMode: "patch" };
			sameLiveRows(viewCall(ownDiff), oracleCall(ownDiff), "a call carrying its own change");
			// A move with edits under it is a card, not the one-row move a bare rename draws.
			const renameWithEdits: EditViewArgs = {
				file_path: "src/old.ts",
				rename: "src/new.ts",
				previewDiff: DIFF,
				preview: { diff: DIFF, firstChangedLine: undefined },
			};
			expect(body(viewCall(renameWithEdits)).some(row => row.includes("const b = 3;"))).toBe(true);
			expect(body(oracleCall(renameWithEdits)).some(row => row.includes("const b = 3;"))).toBe(true);
			sameLiveRows(
				viewCall(renameWithEdits).slice(1),
				oracleCall(renameWithEdits).slice(1),
				"a move that carries a change",
			);
		});

		it("draws the replacement text a call carries, byte for byte, until the note it ends on", () => {
			const args: EditViewArgs = {
				file_path: "src/demo.ts",
				newText: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight",
				editMode: "replace",
			};
			// The last row of each arm is the held-back note, whose wording is the host's and is pinned
			// in an exception cell below; every row of the text itself is main's.
			const rowsOf = (rows: readonly string[]): string[] => withoutNoteRow(withoutStreamingRow(rows));
			sameRows(rowsOf(viewCall(args)), rowsOf(oracleCall(args)));
			expect(rowsOf(viewCall(args)).length).toBe(7);
		});

		it("titles a call that deletes several files by the operation, not by the tool", () => {
			const args: EditViewArgs = {
				editMode: "apply_patch",
				input: "*** Begin Patch\n*** Delete File: src/one.ts\n*** Delete File: src/two.ts\n*** End Patch",
			};
			expect(body(viewCall(args))[0]).toContain("Delete: src/one.ts");
			expect(body(oracleCall(args))[0]).toContain("Delete: src/one.ts");
		});

		it("draws a delete and a bare move as the same single row", () => {
			const deleted: EditViewArgs = { file_path: "src/old.ts", op: "delete", editMode: "patch" };
			for (const expanded of [false, true]) {
				expect(viewCall(deleted, expanded)).toEqual(oracleCall(deleted, expanded));
			}
		});

		it("states an unterminated patch envelope in the same words, once the call has stopped arriving", () => {
			const args: EditViewArgs = {
				input: "*** Begin Patch\n*** Update File: src/demo.ts\n@@\n-a\n+b",
				editMode: "apply_patch",
			};
			// While the envelope is still arriving, a missing terminator is the stream and not a
			// failure, so both arms draw the change so far and neither says anything about it.
			sameLiveRows(viewCall(args), oracleCall(args));
			expect(body(viewCall(args)).join("\n")).not.toContain("*** End Patch");
			// Once it has stopped, both arms state the same reason the envelope cannot be read, on the
			// same rows, and mark the card as failed.
			const drawn = viewCall(args, false, WIDTH, false);
			const oracle = oracleCall(args, false, WIDTH, false);
			expect(plain(drawn)).toEqual(plain(oracle));
			expect(drawn.slice(1)).toEqual(oracle.slice(1));
			expect(body(drawn).join("\n")).toContain("The last line of the patch must be '*** End Patch'");
			// The envelope named no file it could read, so the row heads the card with an ellipsis:
			// main opened the muted colour twice around it, the host once.
			expect(oracle[0]).toContain(theme.fg("muted", theme.fg("muted", "…")));
			expect(drawn[0]).toContain(theme.fg("muted", "…"));
		});
	});

	describe("exception cells", () => {
		it("exception cell: the change counts are the row's meta, not a bracketed suffix", () => {
			const result = updated(DIFF);
			const args: EditViewArgs = { file_path: "src/demo.ts" };
			const drawn = plain(viewResult(result, args))[0] ?? "";
			const oracle = plain(oracleResult(result, args))[0] ?? "";
			expect(oracle).toContain("Edit: src/demo.ts ⟦+1/-1⟧");
			expect(drawn).toContain("Edit: src/demo.ts +1 · -1");
			// The card is exactly the width its widest row needs, so the punctuation main spent two
			// columns on comes off every row of it.
			expect((viewResult(result, args)[0] ?? "").length).toBeLessThan((oracleResult(result, args)[0] ?? "").length);
		});

		it("exception cell: the held-back note is the host's sentence, over a settled change and a streaming one", () => {
			const settled = updated(LONG_DIFF);
			const args: EditViewArgs = { file_path: "src/demo.ts" };
			const noteOf = (rows: readonly string[]): string =>
				plain(rows).find(row => row.includes("more lines") || row.includes("earlier lines")) ?? "";
			expect(noteOf(oracleResult(settled, args))).toContain("… (6 more hunks, 16 more lines) ▸ Ctrl+O expand");
			expect(noteOf(viewResult(settled, args))).toContain("… 16 more lines ▸ Ctrl+O expand");

			const streaming: EditViewArgs = {
				file_path: "src/demo.ts",
				previewDiff: LONG_DIFF,
				preview: { diff: LONG_DIFF, firstChangedLine: undefined },
				editMode: "hashline",
			};
			expect(noteOf(oracleCall(streaming))).toContain("… (10 more hunks, 30 more lines above)");
			expect(noteOf(viewCall(streaming))).toContain("… 31 earlier lines ▸ Ctrl+O expand");
			// Every row the two windows share is the same row: the view spends one of its ten on the
			// note, so it keeps the nine newest where main kept ten.
			const rowsOf = (rows: readonly string[]): string[] =>
				plain(rows)
					.filter(row => /│ line \d+/.test(row))
					.map(row => row.trimEnd());
			const drawn = rowsOf(viewCall(streaming));
			const oracle = rowsOf(oracleCall(streaming));
			expect(drawn.length).toBe(oracle.length - 1);
			expect(drawn.map(row => row.replace(/\s+$/, ""))).toEqual(oracle.slice(1).map(row => row.replace(/\s+$/, "")));
			// Expanded, the window is the viewport less the headroom the settled card will need, so it
			// is still a window: the same newest rows as main's, one fewer, under the same note.
			const drawnWide = rowsOf(viewCall(streaming, true));
			const oracleWide = rowsOf(oracleCall(streaming, true));
			expect(drawnWide.length).toBe(oracleWide.length - 1);
			expect(drawnWide.length).toBeLessThan(40);
			expect(drawnWide).toEqual(oracleWide.slice(1));
			expect(noteOf(viewCall(streaming, true))).toContain("earlier lines ▸ Ctrl+O expand");
		});

		it("exception cell: a card that is still arriving carries the host's streaming row", () => {
			const args: EditViewArgs = {
				file_path: "src/demo.ts",
				previewDiff: DIFF,
				preview: { diff: DIFF, firstChangedLine: undefined },
			};
			expect(plain(viewCall(args)).at(-1)).toContain("… (streaming)");
			expect(plain(viewCall(args, true)).at(-1)).toContain("… (streaming)");
			expect(plain(oracleCall(args)).at(-1)).toContain("(preview)");
			expect(plain(oracleCall(args)).at(-1)).not.toContain("streaming");
			// Main wrote its own note under a collapsed preview alone, so an expanded one ended on the
			// last row of the change and said nothing about being live.
			expect(plain(oracleCall(args, true)).at(-1)).toContain("const c = 4;");
		});

		it("exception cell: expanding a call reveals the whole replacement, which main held back at every disclosure", () => {
			const args: EditViewArgs = {
				file_path: "src/demo.ts",
				newText: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight",
				editMode: "replace",
			};
			expect(plain(viewCall(args)).some(row => row.includes("… 2 more lines ▸ Ctrl+O expand"))).toBe(true);
			expect(plain(oracleCall(args)).some(row => row.includes("… 2 more lines"))).toBe(true);
			const expandedView = plain(viewCall(args, true));
			expect(expandedView.some(row => row.includes("seven"))).toBe(true);
			expect(expandedView.some(row => row.includes("eight"))).toBe(true);
			expect(expandedView.some(row => row.includes("more lines"))).toBe(false);
			expect(plain(oracleCall(args, true)).some(row => row.includes("… 2 more lines"))).toBe(true);
		});

		it("exception cell: an edit spanning several files is one card whose sections are the files", () => {
			const result: EditViewResult = {
				content: [{ type: "text", text: "Edited 2 files" }],
				details: {
					diff: "",
					perFileResults: [
						{ path: "src/one.ts", diff: DIFF },
						{ path: "src/two.ts", diff: "+3│ added" },
					],
				},
			};
			const args: EditViewArgs = { edits: [{ path: "src/one.ts" }, { path: "src/two.ts" }] };
			const drawn = plain(viewResult(result, args));
			const oracle = plain(oracleResult(result, args));
			// Main drew a framed card per file, each with its own header, separated by a blank row.
			expect(oracle.filter(row => row.includes("Edit: ")).length).toBe(2);
			expect(oracle.some(row => row === "")).toBe(true);
			// One card: one header naming the count, one section per file labelled with its path, and
			// every changed row of both files inside it.
			expect(drawn.filter(row => row.includes("Edit")).length).toBe(1);
			expect(drawn[0]).toContain("Edit 2 files · +2 · -1");
			expect(body(viewResult(result, args))).toContain("src/one.ts");
			expect(body(viewResult(result, args))).toContain("src/two.ts");
			expect(drawn.some(row => row === "")).toBe(false);
			for (const row of ["const b = 3;", "+3│ added"]) {
				expect(drawn.some(line => line.includes(row))).toBe(true);
			}
		});

		it("exception cell: a file that failed inside a multi-file edit marks the one card, and the pending count sits inside it", () => {
			const failed: EditViewResult = {
				content: [{ type: "text", text: "Edited" }],
				details: {
					diff: "",
					perFileResults: [
						{ path: "src/one.ts", diff: DIFF },
						{ path: "src/two.ts", diff: "", isError: true, errorText: "No match for src/two.ts" },
					],
				},
			};
			const args: EditViewArgs = { edits: [{ path: "src/one.ts" }, { path: "src/two.ts" }] };
			expect(plain(viewResult(failed, args))[0]).toContain("✗ Edit 2 files");
			expect(plain(viewResult(failed, args)).some(row => row.includes("No match for src/two.ts"))).toBe(true);
			// Main marked the second card alone, so a card scrolled past the failure looked clean.
			expect(plain(oracleResult(failed, args))[0]).toContain("✎ Edit: src/one.ts");

			const partial: EditViewResult = {
				content: [{ type: "text", text: "Edited" }],
				details: { diff: "", perFileResults: [{ path: "src/one.ts", diff: DIFF }] },
			};
			const threeFiles: EditViewArgs = {
				edits: [{ path: "src/one.ts" }, { path: "src/two.ts" }, { path: "src/three.ts" }],
			};
			const drawn = plain(viewResult(partial, threeFiles));
			expect(drawn[0]).toContain("◐ Edit 1 file ·");
			expect(drawn.at(-1)).toContain("▏ 2 more files pending…");
			// Main wrote the same count as a bare row under the last card, outside every frame.
			expect(plain(oracleResult(partial, threeFiles)).at(-1)).toBe("Edit: 2 more files pending…");
			// One card means one state: the failed one is railed in the failure colour, the one still
			// working in neither, and main's per-file cards each carried their own.
			expect(viewResult(failed, args)[0]).toContain(theme.fg("error", "▏"));
			expect(viewResult(partial, threeFiles)[0]).not.toContain(theme.fg("error", "▏"));
		});

		it("exception cell: one file reported through the per-file list is still the single-file card", () => {
			const result: EditViewResult = {
				content: [{ type: "text", text: "x" }],
				details: { diff: "", perFileResults: [{ path: "src/one.ts", diff: DIFF }] },
			};
			const args: EditViewArgs = { edits: [{ path: "src/one.ts" }] };
			// The head row names the file rather than counting it, which is main's card exactly.
			expect(plain(viewResult(result, args))[0]).toContain("Edit: src/one.ts");
			expect(plain(viewResult(result, args))[0]).not.toContain("1 file");
			sameRows(viewResult(result, args), oracleResult(result, args));
		});

		it("exception cell: a multi-file preview labels its files, where main ruled them off", () => {
			const previewFiles = [
				{ path: "src/one.ts", diff: DIFF },
				{ path: "src/two.ts", diff: "+3│ added" },
			];
			const args: EditViewArgs = {
				previewFiles,
				editMode: "hashline",
				edits: [{ path: "src/one.ts" }, { path: "src/two.ts" }],
			};
			const oracle = plain(oracleCall(args));
			expect(oracle.some(row => row.includes("── src/one.ts ──"))).toBe(true);
			expect(body(oracleCall(args))).toContain("");
			const drawn = plain(viewCall(args));
			expect(body(viewCall(args))).toContain("src/one.ts");
			expect(drawn.some(row => row.includes("──"))).toBe(false);
			// The count of files past the first is the head row's meta, where main parenthesized it.
			expect(oracle[0]).toContain("Edit: src/one.ts (+1 more)");
			expect(drawn[0]).toContain("Edit: src/one.ts +1 more");
		});

		it("exception cell: a move's arrow carries the description's tone, where main dimmed it", () => {
			const moved: EditViewResult = {
				content: [{ type: "text", text: "Moved" }],
				details: { diff: "", op: "update", path: "src/next.ts", sourcePath: "src/prev.ts" },
			};
			const args: EditViewArgs = { file_path: "src/prev.ts", rename: "src/next.ts" };
			const drawn = viewResult(moved, args)[0] ?? "";
			const oracle = oracleResult(moved, args)[0] ?? "";
			expect(stripVTControlCharacters(drawn)).toBe(stripVTControlCharacters(oracle));
			expect(stripVTControlCharacters(drawn)).toBe("Move: src/prev.ts → src/next.ts");
			// Main closed the accent run before the arrow, toned the glyph dim and opened a second
			// accent run for the target; the description is one run, so the arrow is inside it.
			expect(oracle).toContain(theme.fg("dim", "→"));
			expect(drawn).not.toContain(theme.fg("dim", "→"));
			expect(drawn).toContain(theme.fg("accent", "src/prev.ts → src/next.ts"));
		});

		it("exception cell: a long path is fitted to the card's own width, not to a border main no longer drew", () => {
			const result = updated(DIFF, LONG_PATH);
			const args: EditViewArgs = { file_path: LONG_PATH };
			const drawn = plain(viewResult(result, args, {}, 60))[0] ?? "";
			const oracle = plain(oracleResult(result, args, {}, 60))[0] ?? "";
			// Both middle-elide the path and keep its tail, which is the part that names the file.
			for (const row of [drawn, oracle]) {
				expect(row).toContain("…");
				expect(row).toContain("tool-execution.ts");
				expect(row.length).toBeLessThanOrEqual(60);
			}
			expect(drawn).toContain("packages/coding-agen…");
			expect(oracle).toContain("packages/coding-ag…");
		});

		it("exception cell: diagnostics follow the change with no blank row in front of them", () => {
			const result = updated(DIFF, "src/demo.ts", {
				diagnostics: {
					server: "typescript",
					summary: "1 error(s), 1 warning(s)",
					errored: true,
					messages: [
						"src/demo.ts:11:5 - error: Type 'string' is not assignable to type 'number'.",
						"src/demo.ts:12:3 - warning: 'b' is declared but never used.",
					],
				},
			});
			const args: EditViewArgs = { file_path: "src/demo.ts" };
			const drawn = viewResult(result, args);
			const oracle = oracleResult(result, args);
			const groupAt = (rows: readonly string[]): number => plain(rows).findIndex(row => row.includes("Diagnostics"));
			expect(plain(oracle)[groupAt(oracle) - 1]?.trim()).toBe("▏");
			expect(plain(drawn)[groupAt(drawn) - 1]).toContain("const c = 4;");
			// Every row of the group itself is main's, byte for byte.
			sameRows(drawn.slice(groupAt(drawn)), oracle.slice(groupAt(oracle)));
		});
	});
});
