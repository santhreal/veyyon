import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { TUI } from "@veyyon/tui";
import { createToolExecution } from "./helpers/tool-execution";

/**
 * What the transcript says about a tool call that never did any work.
 *
 * The operator presses Esc when a run is going wrong, which is exactly the moment the
 * transcript has to be honest about which calls touched the machine. Two shapes reach
 * it and both used to lie by omission.
 *
 * A call the assistant emitted but the loop never dispatched arrives as a synthetic
 * placeholder: `agent-loop.ts` stamps `details.__synthetic = true` with `executed: false`
 * and a `source` naming the assistant-side stop, and its own comment says UI consumers
 * are meant to key on it "to render or classify these as 'call emitted, not executed'
 * instead of a real local tool failure" (#4321). Nothing in `coding-agent` ever read it,
 * so a call that never ran drew the same red `✗ failed` header as a command that ran and
 * exited non-zero.
 *
 * A call the turn `seal()`ed with no result at all was worse: it rendered byte-identical
 * to a call still in flight, so a frozen transcript could not be told from a live one.
 *
 * These assert the rendered rows, because the defect was entirely in what reached the
 * screen; the state behind it was already correct.
 */
const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

function rows(component: { render(width: number): readonly string[] }): string[] {
	return component
		.render(80)
		.map(line => stripVTControlCharacters(line).replace(/\s+$/, ""))
		.filter(line => line.length > 0);
}

describe("tool block honesty about calls that never ran", () => {
	beforeAll(async () => {
		await initTheme();
	});

	/**
	 * The `seal()` case. A block frozen with no result must not be mistakable for one
	 * still running, so the assertion is a direct comparison of the two frames plus the
	 * exact row the sealed one gains.
	 */
	it("separates a sealed result-less block from a running one", () => {
		const running = createToolExecution("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
		running.setArgsComplete();
		const runningRows = rows(running);

		const sealed = createToolExecution("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
		sealed.setArgsComplete();
		sealed.seal();
		const sealedRows = rows(sealed);

		expect(runningRows).toEqual([
			"  ┌──────────────────────────────────────────────────────────────────────────┐",
			"  │ $ npm run migrate:up                                                     │",
			"  └──────────────────────────────────────────────────────────────────────────┘",
		]);
		expect(sealedRows).toEqual([
			...runningRows,
			"  ! no result recorded: this call was cut off before it reported back",
		]);
	});

	/**
	 * The synthetic-placeholder case, once per `source` the loop can stamp. Looping every
	 * value rather than asserting the interrupt one alone: each `source` is a different
	 * reason the call did not run, and a switch that handles one branch and drops the
	 * rest is the shape this defect already had. The `length` row wraps at 80 columns and
	 * the expected rows say so, because a notice that silently overflows would be its own
	 * defect.
	 *
	 * THE CARD SHOWS THE CALL AND THE REASON, AND NOTHING ELSE. The `✗ failed` header and the
	 * `Output` section carrying the loop's model-facing placeholder text used to sit above the
	 * notice, so a call that touched nothing wore the chrome of a command that ran and exited
	 * non-zero and stated its reason twice: once for the model ("Tool call was not executed
	 * because the provider stream ended with an error before the tool could run: ...") and once
	 * for the operator. The command the assistant asked for is the one fact the notice cannot
	 * carry, so that is what the frame keeps.
	 */
	it.each([
		["assistant_stop_aborted", ["  ! not executed: the turn was interrupted before this call ran"]],
		["assistant_stop_skipped", ["  ! not executed: the assistant ended its turn before this call ran"]],
		[
			"assistant_stop_length",
			["  ! not executed: the assistant hit its output limit before the arguments", "  finished"],
		],
		["assistant_stop_error", ["  ! not executed: the provider stream failed before this call ran"]],
	])("names %s as a call that did not run", (source, expectedRows) => {
		const block = createToolExecution("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
		block.setArgsComplete();
		block.updateResult({
			content: [{ type: "text", text: "Tool execution was aborted." }],
			details: { __synthetic: true, source, executed: false },
			isError: true,
		});

		expect(rows(block)).toEqual([
			"  ┌──────────────────────────────────────────────────────────────────────────┐",
			"  │ $ npm run migrate:up                                                     │",
			"  └──────────────────────────────────────────────────────────────────────────┘",
			...expectedRows,
		]);
	});

	/**
	 * The provider's own words, ONCE PER BATCH. `upstreamError` is the only actionable fact a
	 * transport failure carries (it is what separates "the stream stalled" from anything the
	 * operator's prompt did) and it reached the screen only inside the model-facing placeholder,
	 * wrapped across two rows of a red frame. Repeating it on every dropped call was the other
	 * half of the same defect: an eight-call batch printed the same sentence eight times under a
	 * pinned turn error that had already said it. The loop attaches the batch ledger to exactly
	 * one placeholder per cut-short batch, so that card names the fault and its siblings say only
	 * that they did not run. Both arms are asserted, because a rule that names it everywhere and
	 * a rule that names it nowhere both pass a one-sided test.
	 */
	it("carries the provider's error on the ledger-bearing card and not on its siblings", () => {
		const ledgerBearing = createToolExecution("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
		ledgerBearing.setArgsComplete();
		ledgerBearing.updateResult({
			content: [{ type: "text", text: "Tool call was not executed because the provider stream ended." }],
			details: {
				__synthetic: true,
				source: "assistant_stop_error",
				executed: false,
				upstreamError: "OpenAI completions stream stalled",
				batchLedger: { calls: [] },
			},
			isError: true,
		});

		expect(rows(ledgerBearing)).toEqual([
			"  ┌──────────────────────────────────────────────────────────────────────────┐",
			"  │ $ npm run migrate:up                                                     │",
			"  └──────────────────────────────────────────────────────────────────────────┘",
			"  ! not executed: the provider stream failed before this call ran: OpenAI",
			"  completions stream stalled",
		]);

		const sibling = createToolExecution("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
		sibling.setArgsComplete();
		sibling.updateResult({
			content: [{ type: "text", text: "Tool call was not executed because the provider stream ended." }],
			details: {
				__synthetic: true,
				source: "assistant_stop_error",
				executed: false,
				upstreamError: "OpenAI completions stream stalled",
			},
			isError: true,
		});

		expect(rows(sibling)).toEqual([
			"  ┌──────────────────────────────────────────────────────────────────────────┐",
			"  │ $ npm run migrate:up                                                     │",
			"  └──────────────────────────────────────────────────────────────────────────┘",
			"  ! not executed: the provider stream failed before this call ran",
		]);
	});

	/**
	 * The sibling discriminator, which is the whole reason this suite loops. `__skipped` with
	 * `entered: false` is the same claim as a synthetic placeholder — the interrupt arrived
	 * before the tool did anything — and it kept the failure frame and the placeholder text for
	 * a release after the synthetic one was fixed.
	 *
	 * `entered: true` is the case that MUST keep its body: the tool was running, so its output
	 * describes side effects that really happened.
	 */
	it.each([
		[
			false,
			[
				"  ┌──────────────────────────────────────────────────────────────────────────┐",
				"  │ $ npm run migrate:up                                                     │",
				"  └──────────────────────────────────────────────────────────────────────────┘",
				"  ! not executed: an interrupt cut the batch short before this call ran",
			],
		],
		[
			true,
			[
				"  ┌─── ✗ failed ─────────────────────────────────────────────────────────────┐",
				"  │ $ npm run migrate:up                                                     │",
				"  ├─── Output ───────────────────────────────────────────────────────────────┤",
				"  │ dropped table users                                                      │",
				"  └──────────────────────────────────────────────────────────────────────────┘",
				"  ! cut off while running: side effects may be partial",
			],
		],
	])("renders an interrupt with entered=%s by whether the tool did anything", (entered, expectedRows) => {
		const block = createToolExecution("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
		block.setArgsComplete();
		block.updateResult({
			content: [{ type: "text", text: "dropped table users" }],
			details: { __skipped: true, source: "steering", entered },
			isError: true,
		});

		expect(rows(block)).toEqual(expectedRows);
	});

	/**
	 * The other direction, which is what keeps the notice meaningful: a tool that really
	 * ran and really failed must keep exactly its old frame. Without this the fix could
	 * pass by labelling everything "did not run".
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
			"  ┌─── ✗ failed ─────────────────────────────────────────────────────────────┐",
			"  │ $ npm run migrate:up                                                     │",
			"  ├─── Output ───────────────────────────────────────────────────────────────┤",
			"  │ exit 1: relation already exists                                          │",
			"  │ ⟦Exit: 1⟧                                                                │",
			"  └──────────────────────────────────────────────────────────────────────────┘",
		]);
	});

	/**
	 * A sealed block that DID receive a result keeps its result frame. `seal()` is also
	 * how a superseded `todo`/`job` snapshot and an abandoned detached task are frozen,
	 * and none of those failed to run.
	 */
	it("leaves a sealed block that produced a result unannotated", () => {
		const block = createToolExecution("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
		block.setArgsComplete();
		block.updateResult({ content: [{ type: "text", text: "migrated 3 tables" }] });
		block.seal();

		expect(rows(block)).toEqual([
			"  ┌──────────────────────────────────────────────────────────────────────────┐",
			"  │ $ npm run migrate:up                                                     │",
			"  ├─── Output ───────────────────────────────────────────────────────────────┤",
			"  │ migrated 3 tables                                                        │",
			"  └──────────────────────────────────────────────────────────────────────────┘",
		]);
	});
});
