import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { TUI } from "@veyyon/tui";
import { loopSource, unionMembers } from "../../agent/test/support/invented-tool-result-sources";
import { createToolExecution } from "./helpers/tool-execution";

/**
 * What the transcript says about a tool call an interrupt cut short.
 *
 * The sibling defect to the one #4321 fixed, and it landed the same way. The
 * renderer learned to read `__synthetic` (never dispatched) and stopped drawing
 * those as failures. `__skipped` (cut short) makes exactly the same claim, is far
 * more common, and kept drawing the red `✗ failed` header of a command that ran and
 * exited non-zero, next to a headline that is fixed per interrupt source. So the
 * operator watching a cancelled run saw a screen full of identical failures for
 * calls that never touched the machine.
 *
 * `entered` is the part that cannot be flattened. A call cut off before dispatch
 * applied nothing; a call cut off inside `tool.execute()` may have applied half its
 * work. Those need opposite responses from the person reading the screen.
 *
 * These assert the rendered rows, because the defect is entirely in what reaches the
 * screen; the state behind it is already correct.
 */
const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

function rows(component: { render(width: number): readonly string[] }): string[] {
	return component
		.render(80)
		.map(line => stripVTControlCharacters(line).replace(/\s+$/, ""))
		.filter(line => line.length > 0);
}

/**
 * A call the interrupt caught BEFORE dispatch: the card is the call and the
 * notice, with no failure chrome and no Output section. The placeholder's text is
 * written for the model ("Skipped due to ..."), so putting it through the tool's
 * result renderer would state the reason twice, once in the model's register and
 * once in the operator's.
 */
const CALL_ONLY_FRAME = ["  ▏  $ npm run migrate:up"];

/**
 * A call the interrupt caught INSIDE `tool.execute()`: whatever it printed is
 * real output about real side effects, so the output stays on screen and the
 * frame keeps its failed header.
 */
const ENTERED_FRAME = [
	"  ✗ failed",
	"  ▏  $ npm run migrate:up",
	"  ▏  Output",
	"  ▏  Skipped due to queued user message.",
];

function renderSkipped(source: string, entered: boolean): string[] {
	const block = createToolExecution("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
	block.setArgsComplete();
	block.updateResult({
		content: [{ type: "text", text: "Skipped due to queued user message." }],
		details: { __skipped: true, source, entered },
		isError: true,
	});
	return rows(block);
}

describe("a tool block an interrupt cut short says so", () => {
	beforeAll(async () => {
		await initTheme();
	});

	/**
	 * Every interrupt source, read out of the declaration rather than listed here.
	 * A new source that renders as a plain failure is the defect returning, and a
	 * hardcoded list would not notice.
	 */
	it("names every skip source as a call that did not run", async () => {
		const sources = await unionMembers(await loopSource(), "SkippedToolResultDetails", "source");
		expect(sources.length).toBeGreaterThanOrEqual(6);
		for (const source of sources) {
			expect(renderSkipped(source, false), source).toEqual([
				...CALL_ONLY_FRAME,
				"  ! not executed: an interrupt cut the batch short before this call ran",
			]);
		}
	});

	/**
	 * The dangerous case, and the reason one line cannot serve both: a `bash` that
	 * was mid-migration when the signal landed may have applied part of its work.
	 * Telling the operator "not executed" there is a false statement about their
	 * machine.
	 */
	it("warns about partial side effects when the call was already running", async () => {
		const sources = await unionMembers(await loopSource(), "SkippedToolResultDetails", "source");
		for (const source of sources) {
			expect(renderSkipped(source, true), source).toEqual([
				...ENTERED_FRAME,
				"  ! cut off while running: side effects may be partial",
			]);
		}
	});

	/**
	 * The negative control. A tool that really ran and really failed keeps exactly
	 * its old frame, so the notice cannot pass by labelling everything.
	 */
	it("leaves a genuine tool failure unannotated", () => {
		const block = createToolExecution("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
		block.setArgsComplete();
		block.updateResult({
			content: [{ type: "text", text: "exit 1: relation already exists" }],
			details: { exitCode: 1 },
			isError: true,
		});

		expect(rows(block)).toEqual([
			"  ✗ failed",
			"  ▏  $ npm run migrate:up",
			"  ▏  Output",
			"  ▏  exit 1: relation already exists",
			"  ▏  ⟦Exit: 1⟧",
		]);
	});
});
