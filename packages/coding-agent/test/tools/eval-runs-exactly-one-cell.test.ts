/**
 * An eval call is ONE cell, and both halves of that sentence are pinned here.
 *
 * WHY THIS SUITE EXISTS (EVAL-MULTI-CELL-LOOP-IS-VESTIGIAL). `EvalTool.execute`
 * built a one-element `cells` array out of `params` and then looped over it, with
 * per-cell `IdleTimeout` construction, `activeLiveCell` bookkeeping,
 * `cellOutputs`/`cellResults` accumulation joined with a blank line, and
 * `uniqueEvalLanguages`/`detailsNotice` helpers whose only job was folding several
 * cells into one summary. The wire schema carries exactly one
 * `language`/`code`/`title`/`timeout`/`reset`, so none of it could ever run twice.
 *
 * That was not harmless scaffolding. It made the cancellation path read as though
 * it had a partial-progress story to tell -- which cells ran, which did not -- and
 * the message it produced said "cell 1", counting to one. Anyone reasoning about
 * "the cells after the interrupted one", or writing a guard for the gap between
 * two cells, was reasoning about a branch no input can reach.
 *
 * THE OTHER HALF is why this suite is not simply "assert one cell". The details
 * type is a WIRE type: `details.cells` and `details.languages` reach the renderer
 * and are persisted in transcripts, so collapsing the loop must not collapse the
 * SHAPE. A single-cell run still reports a one-element array, with `index: 0`.
 * Both directions are asserted below, because a refactor could break either.
 *
 * Everything runs the real `EvalTool` against the real JS backend, so what is
 * pinned is the shape a real run produces rather than a stub's idea of it.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { disposeAllVmContexts } from "@veyyon/coding-agent/eval/js/context-manager";
import type { EvalToolDetails } from "@veyyon/coding-agent/eval/types";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { EvalTool } from "@veyyon/coding-agent/tools/eval";
import { makeToolSession } from "../helpers/tool-session";

function makeSession(): ToolSession {
	return makeToolSession({
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	});
}

/** The text of every text block in a tool result, joined. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

afterAll(() => {
	disposeAllVmContexts();
});

describe("the details a successful run reports", () => {
	/**
	 * The wire shape, which the renderer and every persisted transcript depend on.
	 * A one-element array is the contract, NOT an accident of the old loop, so the
	 * count and the index are both asserted: a refactor that returned the bare cell
	 * instead would break the renderer with no type error at the tool boundary.
	 */
	it("reports exactly one cell, at index 0, carrying the code that was run", async () => {
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-one", { language: "js", code: "console.log('alpha');", title: "greet" });
		const details = result.details as EvalToolDetails;

		expect(details.cells).toHaveLength(1);
		expect(details.cells![0]!.index).toBe(0);
		expect(details.cells![0]!.title).toBe("greet");
		expect(details.cells![0]!.code).toBe("console.log('alpha');");
		expect(details.cells![0]!.language).toBe("js");
		expect(details.cells![0]!.status).toBe("complete");
		expect(details.cells![0]!.output).toBe("alpha");
	});

	/**
	 * `language` and `languages` are two fields describing one fact, and both ship.
	 * The plural existed to fold several cells' languages together; with one cell it
	 * is a one-element array that must still agree with the singular, because a
	 * renderer reading either one has to reach the same answer.
	 */
	it("agrees with itself about the language, in both the singular and the plural field", async () => {
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-lang", { language: "js", code: "1 + 1;" });
		const details = result.details as EvalToolDetails;

		expect(details.language).toBe("js");
		expect(details.languages).toEqual(["js"]);
	});

	/**
	 * The output the model reads is the cell's own text, with nothing joined onto
	 * it. The old code built it as `cellOutputs.join("\n\n")`, so a change to the
	 * separator or a stray push would have silently reshaped every result; asserting
	 * the exact bytes is what makes that visible.
	 */
	it("returns the cell's output verbatim rather than a joined accumulation", async () => {
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-text", {
			language: "js",
			code: "console.log('one');\nconsole.log('two');",
		});

		expect(textOf(result)).toBe("one\ntwo");
	});
});

describe("the details a failing run reports", () => {
	/**
	 * The error path built its output through the same accumulator, so it gets the
	 * same proof: one cell, marked `error`, with the run's real output still
	 * attached. A result that reported zero cells here would leave the renderer with
	 * nothing to show for a run the operator watched happen.
	 */
	it("still reports exactly one cell, marked error, when the code throws", async () => {
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-throw", {
			language: "js",
			code: "console.log('before'); throw new Error('boom');",
		});
		const details = result.details as EvalToolDetails;

		expect(details.isError).toBe(true);
		expect(details.cells).toHaveLength(1);
		expect(details.cells![0]!.status).toBe("error");
		expect(textOf(result)).toContain("before");
		expect(textOf(result)).toContain("boom");
	});
});
