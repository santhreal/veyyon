/**
 * The `ask` card draws what main's renderer drew.
 *
 * Every arm a question passes through is compared as terminal bytes -- the question's markdown, the
 * option marks, the answer marks, the free-text answer, the note, the timeout row, the chat redirect
 * and the two fallbacks. FIVE DIFFERENCES ARE PINNED AS EXCEPTION CELLS rather than waived silently:
 *
 *  - The pending row's title is not bold, where main bolded the tool's name in a header it built by
 *    hand; the row now goes through the shared status line, which bolds nothing.
 *  - The pending row's metadata is dim, where main coloured it muted.
 *  - Content sits at the frame's own indent, where main laid every question and option row out one
 *    column further in, which also made its block one column wider.
 *  - A section's label is drawn in the tool-title colour as one run, where main coloured the id dim
 *    and appended its meta as a second dim run.
 *  - The card with no details indents its fallback line two columns under the header, where main drew
 *    one `Text` whose second row began at column zero behind the header's reopened colour runs.
 *
 * WHAT THIS SUITE DOES NOT CATCH. It never calls `execute()`, so nothing here proves what an ask
 * REPORTS or which dialog it opened: `test/tools/ask.test.ts` owns that, and a `details` shape whose
 * meaning changed would be drawn identically by both arms. The live selector the call renders behind
 * is the mode's, not the card's, so `callIsLiveWidget` is asserted at the registry rather than here.
 * It compares one theme, because the oracle and the view resolve the same one -- and in that theme
 * `output` and `muted` resolve to ONE colour, so swapping those two tones on an answer row draws the
 * same bytes and no comparison here can see it. Both arms carry the same tones on those rows, which
 * is why the swap is invisible rather than wrong.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { theme } from "@veyyon/coding-agent/theme/theme";
import type { AskToolDetails } from "@veyyon/coding-agent/tools/agent/ask";
import { type AskRenderArgs, type AskViewResult, askToolView } from "@veyyon/coding-agent/tools/agent/ask-view";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import type { ToolViewContext } from "@veyyon/view";
import { askMainRenderer } from "../oracles/ask-main-renderer";
import { HOST_EXPANDED, renderCompLines, useDifferentialTheme, WIDTH } from "./harness";

useDifferentialTheme();

const WIDTHS = [200, WIDTH, 40];
const CLOSE = "\u001b[39m";

/**
 * The escape that opens one theme colour, without the close the theme pairs it with.
 *
 * Read inside a cell rather than at module scope, because the theme is loaded by the harness in
 * `beforeAll` and a colour read while the file is being evaluated has no theme to read from.
 */
function colorOpen(color: "dim" | "muted" | "toolTitle"): string {
	const run = theme.fg(color, "");
	return run.slice(0, run.length - CLOSE.length);
}

function escapeRe(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("ask tool differential", () => {
	const EXPANDED: ToolViewContext = { expanded: true, partial: false };
	const DIM = () => colorOpen("dim");
	const MUTED = () => colorOpen("muted");
	const TITLE = () => colorOpen("toolTitle");

	function callViewRows(args: AskRenderArgs, width = WIDTH): string[] {
		return renderCompLines(drawToolView(askToolView.renderCall(args, EXPANDED), theme), width);
	}

	function callOracleRows(args: AskRenderArgs, width = WIDTH, options: RenderResultOptions = HOST_EXPANDED): string[] {
		return renderCompLines(askMainRenderer.renderCall(args, options, theme), width);
	}

	function viewRows(result: AskViewResult, width = WIDTH): string[] {
		return renderCompLines(drawToolView(askToolView.renderResult(result, EXPANDED), theme), width);
	}

	function oracleRows(result: AskViewResult, width = WIDTH, options: RenderResultOptions = HOST_EXPANDED): string[] {
		return renderCompLines(
			askMainRenderer.renderResult(
				result as { content: Array<{ type: string; text?: string }>; details?: AskToolDetails },
				options,
				theme,
			),
			width,
		);
	}

	/**
	 * A row without the fill a framed block pads it to.
	 *
	 * The block sizes itself to its widest row, and the indent difference below moves that width, so
	 * the fill is a consequence of a pinned difference rather than content either arm chose. Applied to
	 * BOTH arms, so the columns before it are still compared byte for byte.
	 */
	function unfilled(rows: readonly string[]): string[] {
		return rows.map(row => row.replace(/ +((?:\x1b\[49m)?)$/, "$1"));
	}

	/**
	 * The oracle's content rows at the frame's own indent.
	 *
	 * Main laid its content out one column past the frame -- a leading space on every option row and a
	 * one-column markdown indent for the question -- so every content row carries one column the host's
	 * frame does not. A section label is not one of those rows: main drew it at the frame's own indent,
	 * which is where the host draws it too, so a run of two columns is left alone.
	 */
	function deindent(rows: readonly string[]): string[] {
		const rail = escapeRe(theme.symbol("block.rail"));
		const content = new RegExp(`^((?:\\x1b\\[[0-9;:]*m)*${rail}(?:\\x1b\\[[0-9;:]*m)*) ( {2,})`, "u");
		return rows.map(row => row.replace(content, "$1$2"));
	}

	/**
	 * The oracle's pending row as the shared status line draws it.
	 *
	 * Main built this one header by hand: it bolded the tool's name and coloured the metadata muted,
	 * where every row a view returns goes through `renderStatusLine`, which bolds nothing and dims
	 * metadata. Both are pinned below.
	 */
	function pendingHeader(rows: readonly string[], meta?: string): string[] {
		return rows.map((row, index) => {
			if (index !== 0) return row;
			const plain = row.replace(theme.bold("Ask"), "Ask");
			return meta === undefined ? plain : plain.replace(`${MUTED()}${meta}${CLOSE}`, `${DIM()}${meta}${CLOSE}`);
		});
	}

	/**
	 * The oracle's section labels as chrome the host colours.
	 *
	 * Main coloured a question's id dim and appended its meta as a second dim run; a section label is
	 * the terminal's own chrome, so the host draws the whole label in the tool-title colour in one run.
	 */
	function sectionLabels(rows: readonly string[]): string[] {
		const pattern = new RegExp(
			`${escapeRe(DIM())}(\\[[^\\]]*\\])${escapeRe(CLOSE)}(?:${escapeRe(DIM())}([^\\x1b]*)${escapeRe(CLOSE)})?`,
			"g",
		);
		return rows.map(row =>
			row.replace(pattern, (_match, id: string, meta: string | undefined) => `${TITLE()}${id}${meta ?? ""}${CLOSE}`),
		);
	}

	/** The oracle's pending card, with every recorded difference of a pending card undone. */
	function pendingOracle(args: AskRenderArgs, width: number, meta?: string): string[] {
		return unfilled(sectionLabels(pendingHeader(deindent(callOracleRows(args, width)), meta)));
	}

	/** The oracle's settled card, with every recorded difference of a settled card undone. */
	function settledOracle(result: AskViewResult, width: number): string[] {
		return unfilled(sectionLabels(deindent(oracleRows(result, width))));
	}

	/** The view's pending card, without the fill the block pads its rows to. */
	function pendingView(args: AskRenderArgs, width: number): string[] {
		return unfilled(callViewRows(args, width));
	}

	/** The view's settled card, without the fill the block pads its rows to. */
	function settledView(result: AskViewResult, width: number): string[] {
		return unfilled(viewRows(result, width));
	}

	function settled(details: AskToolDetails, text = "answer recorded"): AskViewResult {
		return { content: [{ type: "text", text }], details };
	}

	const LONG_QUESTION =
		"Which **authentication** path should the session take, given the credentials already on disk?";

	it("draws a pending single question byte for byte, over every shape its options arrive in", () => {
		const calls: Array<[AskRenderArgs, string | undefined]> = [
			[{ question: "Pick one" }, undefined],
			[{ question: LONG_QUESTION }, undefined],
			[{ question: "Pick one", options: [{ label: "Alpha" }, { label: "Beta" }] }, "options:2"],
			[
				{
					question: "Pick one",
					options: [{ label: "Alpha", description: "Use the keys already configured" }, { label: "Beta" }],
				},
				"options:2",
			],
			[
				{
					question: "Pick one",
					options: [
						{ label: "**Alpha** or `beta`", description: "  Reads the keys under `~/.veyyon`  " },
						{ label: "Beta", description: "   " },
					],
				},
				"options:2",
			],
			[{ question: "Pick many", options: [{ label: "Alpha" }], multi: true }, "multi · options:1"],
			[{ question: "Pick many", multi: true }, "multi"],
			[{ question: "Pick one", options: ["BareString", { label: "Proper" }, { nope: 1 }, 7] as never }, "options:2"],
		];
		for (const [args, meta] of calls) {
			for (const width of WIDTHS) {
				expect(pendingView(args, width)).toEqual(pendingOracle(args, width, meta));
			}
		}
		// Anti-vacuity: the card really is the question and the choices under it, marked unselected.
		const drawn = stripVTControlCharacters(callViewRows(calls[3]![0], 200).join("\n"));
		expect(drawn).toContain("Pick one");
		expect(drawn).toContain(`${theme.radio.unselected} Alpha`);
		expect(drawn).toContain("↳ Use the keys already configured");
	});

	it("draws a pending question form byte for byte, ids, meta and untrusted args included", () => {
		const form: AskRenderArgs = {
			questions: [
				{ id: "lang", question: "Which **language**?", options: [{ label: "TypeScript" }, { label: "Rust" }] },
				{ id: "hosts", question: "Which hosts?", options: [{ label: "one" }], multi: true },
				{ id: "free", question: "Anything else?", options: [] },
				{ question: "Nameless?", options: [{ label: "x" }] } as never,
			],
		};
		const doubleEncoded: AskRenderArgs = {
			questions: JSON.stringify([
				{ id: "q1", question: "Pick one", options: [{ label: "Alpha" }, { label: "Beta" }] },
			]) as never,
		};
		const mangled: AskRenderArgs = {
			questions: [null, "garbage", { id: "ok", question: "Real question", options: ["BareString"] }] as never,
		};
		const forms: Array<[AskRenderArgs, string]> = [
			[form, "4 questions"],
			[doubleEncoded, "1 questions"],
			[mangled, "1 questions"],
		];
		for (const [args, meta] of forms) {
			for (const width of WIDTHS) {
				expect(pendingView(args, width)).toEqual(pendingOracle(args, width, meta));
			}
		}
		// Anti-vacuity: every question of a form is drawn under its own id, and a mangled entry is
		// dropped rather than taking the card down.
		const drawn = stripVTControlCharacters(callViewRows(form, 200).join("\n"));
		expect(drawn).toContain("[lang] · options:2");
		expect(drawn).toContain("[hosts] · multi · options:1");
		expect(drawn).toContain("[free]");
		expect(drawn).toContain("[?] · options:1");
		expect(stripVTControlCharacters(callViewRows(mangled, 200).join("\n"))).toContain("[ok]");
	});

	it("draws the error frame for a call with no question, with nothing normalized away", () => {
		for (const args of [{}, { question: "" }, { questions: "[{trunc" } as never, { questions: 42 } as never]) {
			for (const width of WIDTHS) {
				expect(callViewRows(args, width)).toEqual(callOracleRows(args, width));
			}
		}
		// Anti-vacuity: the frame states the failure rather than drawing an empty card.
		expect(stripVTControlCharacters(callViewRows({}, 200).join("\n"))).toContain("No question provided");
	});

	it("draws a settled single answer byte for byte, over every way an answer comes back", () => {
		const results: AskToolDetails[] = [
			{ question: "Pick one", multi: false, options: ["Alpha", "Beta"], selectedOptions: ["Alpha"] },
			{ question: "Pick many", multi: true, options: ["Alpha", "Beta"], selectedOptions: ["Alpha", "Beta"] },
			{ question: "Pick one", multi: false, options: ["Alpha", "Beta"], selectedOptions: [] },
			{ question: LONG_QUESTION, multi: false, selectedOptions: ["Alpha"] },
			{
				question: "Details?",
				multi: false,
				options: [],
				selectedOptions: [],
				customInput: "first line\nsecond line",
			},
			{ question: "Details?", multi: false, options: [], selectedOptions: [], customInput: "" },
			{
				question: "Pick one",
				multi: false,
				options: ["Alpha"],
				selectedOptions: ["Alpha"],
				note: "a\tnote\nsecond",
			},
			{ question: "Pick one", multi: false, options: ["Alpha"], selectedOptions: ["Alpha"], timedOut: true },
		];
		for (const details of results) {
			for (const width of WIDTHS) {
				const result = settled(details);
				expect(settledView(result, width)).toEqual(settledOracle(result, width));
			}
		}
		// Anti-vacuity: a chosen option carries the filled mark, an unchosen one does not, and a
		// question nobody answered says so.
		const answered = stripVTControlCharacters(viewRows(settled(results[0]!), 200).join("\n"));
		expect(answered).toContain(`${theme.radio.selected} Alpha`);
		expect(answered).toContain(`${theme.radio.unselected} Beta`);
		expect(stripVTControlCharacters(viewRows(settled(results[2]!), 200).join("\n"))).toContain("Cancelled");
	});

	it("draws a settled question form byte for byte, one section per question", () => {
		const results: AskToolDetails[] = [
			{
				results: [
					{
						id: "lang",
						question: "Which **language**?",
						options: ["TypeScript", "Rust"],
						multi: false,
						selectedOptions: ["Rust"],
					},
					{
						id: "hosts",
						question: "Which hosts?",
						options: ["one", "two"],
						multi: true,
						selectedOptions: ["one", "two"],
						note: "why",
					},
					{
						id: "free",
						question: "Anything else?",
						options: [],
						multi: false,
						selectedOptions: [],
						customInput: "a note\nand more",
					},
				],
			},
			{
				results: [
					{ id: "lang", question: "Which language?", options: ["TypeScript"], multi: false, selectedOptions: [] },
					{ id: "hosts", question: "Which hosts?", options: ["one"], multi: true, selectedOptions: [] },
				],
			},
			{
				results: [
					{
						id: "lang",
						question: "Which language?",
						options: ["TypeScript", "Rust"],
						multi: false,
						selectedOptions: ["Rust"],
					},
					{ id: "hosts", question: "Which hosts?", options: ["one", "two"], multi: true, selectedOptions: [] },
				],
			},
		];
		for (const details of results) {
			for (const width of WIDTHS) {
				const result = settled(details);
				expect(settledView(result, width)).toEqual(settledOracle(result, width));
			}
		}
		// Anti-vacuity: a form with nothing chosen anywhere is the warning card, and one where a single
		// question was answered is the settled one, which is the icon the header carries.
		const none = stripVTControlCharacters(viewRows(settled(results[1]!), 200)[0] ?? "");
		expect(none).toContain(theme.symbol("status.warning"));
		for (const answeredSome of [results[0]!, results[2]!]) {
			expect(stripVTControlCharacters(viewRows(settled(answeredSome), 200)[0] ?? "")).toContain(
				theme.symbol("status.success"),
			);
		}
	});

	it("draws the chat redirect byte for byte, questions and all", () => {
		const redirects: AskToolDetails[] = [
			{ chatRedirect: true, questions: ["First?", "Second **bold**?"] },
			{ chatRedirect: true, questions: [] },
			{ chatRedirect: true },
		];
		for (const details of redirects) {
			for (const width of WIDTHS) {
				const result = settled(details);
				expect(settledView(result, width)).toEqual(settledOracle(result, width));
			}
		}
		expect(stripVTControlCharacters(viewRows(settled(redirects[0]!), 200).join("\n"))).toContain("chat redirect");
	});

	it("draws the fallback for a result with no question with nothing normalized away", () => {
		const noQuestion: AskViewResult = {
			content: [{ type: "text", text: "the caller dismissed the dialog" }],
			details: { multi: false, selectedOptions: [] },
		};
		const empty: AskViewResult = { content: [{ type: "text", text: "" }] };
		for (const width of WIDTHS) {
			expect(viewRows(noQuestion, width)).toEqual(oracleRows(noQuestion, width));
			expect(viewRows(empty, width)).toEqual(oracleRows(empty, width));
		}
		expect(stripVTControlCharacters(viewRows(noQuestion, 200).join("\n"))).toContain("dismissed the dialog");
	});

	it("exception: the pending row's title is not bold, where main bolded the tool's name", () => {
		const args: AskRenderArgs = { question: "Pick one" };
		expect(callViewRows(args, 200)[0]).toContain(`${TITLE()}Ask${CLOSE}`);
		expect(callOracleRows(args, 200)[0]).toContain(`${TITLE()}${theme.bold("Ask")}${CLOSE}`);
		expect(callViewRows(args, 200)[0]).not.toContain("\u001b[1m");
	});

	it("exception: the pending row's metadata is dim, where main coloured it muted", () => {
		const args: AskRenderArgs = { question: "Pick many", options: [{ label: "Alpha" }], multi: true };
		expect(callViewRows(args, 200)[0]).toContain(`${DIM()}multi · options:1${CLOSE}`);
		expect(callOracleRows(args, 200)[0]).toContain(`${MUTED()}multi · options:1${CLOSE}`);
	});

	it("exception: content sits at the frame's indent, where main laid it out one column further in", () => {
		const args: AskRenderArgs = { question: "Pick one", options: [{ label: "Alpha" }] };
		const rail = theme.symbol("block.rail");
		const rows = callViewRows(args, 200).map(row => stripVTControlCharacters(row).trimEnd());
		const old = callOracleRows(args, 200).map(row => stripVTControlCharacters(row).trimEnd());
		expect(rows[1]).toBe(`${rail}  Pick one`);
		expect(old[1]).toBe(`${rail}   Pick one`);
		expect(rows[2]).toBe(`${rail}  ${theme.radio.unselected} Alpha`);
		expect(old[2]).toBe(`${rail}   ${theme.radio.unselected} Alpha`);
	});

	it("exception: a section label is one tool-title run, where main drew two dim ones", () => {
		const args: AskRenderArgs = {
			questions: [{ id: "lang", question: "Which language?", options: [{ label: "TypeScript" }] }],
		};
		expect(callViewRows(args, 200)[1]).toContain(`${TITLE()}[lang] · options:1${CLOSE}`);
		expect(callOracleRows(args, 200)[1]).toContain(`${DIM()}[lang]${CLOSE}${DIM()} · options:1${CLOSE}`);
	});

	it("exception: the detail-less card indents its fallback line, where main began it at column zero", () => {
		const result: AskViewResult = { content: [{ type: "text", text: "no dialog was opened" }] };
		expect(stripVTControlCharacters(viewRows(result, 200)[1] ?? "")).toBe("  no dialog was opened");
		expect(stripVTControlCharacters(oracleRows(result, 200)[1] ?? "")).toBe("no dialog was opened");
		// The words, the tone and the header row above them are the same either way.
		expect(viewRows(result, 200)[0]).toBe(oracleRows(result, 200)[0]);
		// A 256-colour terminal and a truecolor one open the same empty runs with different bytes, so
		// the normalizer keys off a colour opened and closed with nothing between it, not off a depth.
		expect(viewRows(result, 200)[1]?.trimStart()).toBe(
			(oracleRows(result, 200)[1] ?? "").replace(/^(?:\x1b\[[0-9;]*m\x1b\[39m)+/, ""),
		);
	});

	it("proves the normalizers undo an indent and a colour, and nothing else", () => {
		const args: AskRenderArgs = { question: "Pick one", options: [{ label: "Alpha" }] };
		// A normalized oracle row is not the raw one, or the cells above would be comparing raw bytes
		// and passing for the wrong reason.
		expect(pendingOracle(args, 200, "options:1")).not.toEqual(unfilled(callOracleRows(args, 200)));
		// A real difference survives every normalizer: one word changed still fails.
		const different: AskRenderArgs = { question: "Pick two", options: [{ label: "Alpha" }] };
		expect(pendingView(args, 200)).not.toEqual(pendingOracle(different, 200, "options:1"));
		// A tone changed on a row the normalizers touch still fails, in either direction.
		expect(pendingView(args, 200)).not.toEqual(
			pendingOracle(args, 200, "options:1").map(row => row.replace(DIM(), MUTED())),
		);
		expect(pendingView(args, 200)).not.toEqual(
			pendingOracle(args, 200, "options:1").map(row => row.replace(TITLE(), DIM())),
		);
		// And an option mark dropped from a row the indent normalizer rewrites still fails.
		expect(pendingView(args, 200)).not.toEqual(
			pendingOracle(args, 200, "options:1").map(row => row.replace(theme.radio.unselected, " ")),
		);
	});
});
