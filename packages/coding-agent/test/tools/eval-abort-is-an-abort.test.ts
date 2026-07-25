/**
 * Cancelling an eval run reports the cancellation as a cancellation.
 *
 * WHY THIS SUITE EXISTS (TOOLE-1-ABORT). The eval tool had a single
 * `result.cancelled` branch that resolved with an ordinary `isError: true`
 * result whose entire text was `result.output || "Command aborted"`, and it lost
 * two separate things.
 *
 * The first is the difference between a cancellation and a failure. Both arrived
 * as the same `isError: true` result, but the agent loop's correct response to a
 * failed cell is to read the error and retry, and its correct response to a
 * cancellation is to stop. That is the same defect the multi-step edit loop had,
 * fixed the same way: keep the `ToolAbortError` type so the roughly twenty
 * `instanceof` catchers can tell, and put the detail in the message.
 *
 * The second is what the operator has to go and clean up. An eval cell mutates
 * kernel state that outlives the call, so "this cell started and did not finish"
 * is not a formality: whatever it had already done to the session is still
 * there, and the message has to say so. The old text could not, because it was
 * assembled from the cell output rather than from the run.
 *
 * A THIRD, SEPARATE THING THIS SUITE PINS: the timeout path must NOT become an
 * abort. Three signals are merged into the cell's `combinedSignal` (the caller's,
 * the session's, and the per-cell idle watchdog), and only the first two are a
 * cancellation. A timeout means "raise the cell's timeout and run it again", and
 * it already carries the backend's own `timed out after N seconds` annotation,
 * which is what the model needs to act on. Turning that into a `ToolAbortError`
 * would stop the loop over something it could have fixed itself, so the last
 * describe here holds that line.
 *
 * Everything runs the real `EvalTool` against the real JS backend. A stub that
 * returned `{cancelled: true}` would exercise the branch and prove nothing about
 * whether a real cancelled cell reaches it.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { disposeAllVmContexts } from "@veyyon/coding-agent/eval/js/context-manager";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { EvalTool } from "@veyyon/coding-agent/tools/eval";
import { ToolAbortError } from "@veyyon/coding-agent/tools/tool-errors";
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

describe("EvalTool cancellation", () => {
	afterAll(async () => {
		await disposeAllVmContexts();
	});

	it("rejects with a ToolAbortError rather than resolving with an error result", async () => {
		// THE HEADLINE REGRESSION. Resolving is what made a cancellation
		// indistinguishable from a cell that threw, and `.resolves` here would have
		// been the old behavior passing.
		const tool = new EvalTool(makeSession());
		const controller = new AbortController();
		const running = tool.execute(
			"call-cancel-mid-cell",
			{ language: "js", code: "await Bun.sleep(5000); print('never');", timeout: 0 },
			controller.signal,
		);
		await Bun.sleep(50);
		controller.abort();

		await expect(running).rejects.toBeInstanceOf(ToolAbortError);
	});

	it("says it was cancelled, whatever the cell had managed to print", async () => {
		// The exact shape of the loss: `result.output || "Command aborted"` meant
		// output, when there was any, displaced the notice entirely. An interrupted
		// backend returns an empty `result.output`, so on this path the fallback
		// fired and the message was the bare constant "Command aborted": no mention
		// of which cell, and nothing about the kernel state left behind.
		const tool = new EvalTool(makeSession());
		const controller = new AbortController();
		const running = tool.execute(
			"call-cancel-after-output",
			{ language: "js", code: "print('step 1 done'); await Bun.sleep(5000); print('step 2');", timeout: 0 },
			controller.signal,
		);
		await Bun.sleep(120);
		controller.abort();

		const err = (await running.catch(e => e)) as Error;
		expect(err).toBeInstanceOf(ToolAbortError);
		expect(err.message).toContain("Eval cancelled");
		expect(err.message).toContain("started and did NOT finish");
		// The half-run cell's effects outlive the call, and the operator is the one
		// who has to reason about them.
		expect(err.message).toContain("still in the kernel");
	});

	it("names the interrupted cell by its title", async () => {
		// So an operator reading a transcript can match the cancellation to the cell
		// they see in it, rather than working out which of several calls stopped.
		const tool = new EvalTool(makeSession());
		const controller = new AbortController();
		const running = tool.execute(
			"call-cancel-titled",
			{ language: "js", code: "await Bun.sleep(5000);", timeout: 0, title: "load fixtures" },
			controller.signal,
		);
		await Bun.sleep(50);
		controller.abort();

		const err = (await running.catch(e => e)) as Error;
		expect(err.message).toContain("Eval cancelled: load fixtures started and did NOT finish");
	});

	it("falls back to the ordinal and the language when the cell has no title", async () => {
		// The title is optional, and a cancellation message that trails off into
		// nothing when it is absent is the case that actually reaches an operator
		// most often, since the model does not always set one.
		const tool = new EvalTool(makeSession());
		const controller = new AbortController();
		const running = tool.execute(
			"call-cancel-count",
			{ language: "js", code: "await Bun.sleep(5000);", timeout: 0 },
			controller.signal,
		);
		await Bun.sleep(50);
		controller.abort();

		const err = (await running.catch(e => e)) as Error;
		expect(err.message).toContain("Eval cancelled: cell 1 (js) started and did NOT finish");
	});

	it("says so plainly when the cancelled cell had produced no output", async () => {
		// The empty case has to state it rather than trail off, so silence in the
		// message is never ambiguous between "nothing printed" and "we lost it".
		const tool = new EvalTool(makeSession());
		const controller = new AbortController();
		const running = tool.execute(
			"call-cancel-silent",
			{ language: "js", code: "await Bun.sleep(5000);", timeout: 0 },
			controller.signal,
		);
		await Bun.sleep(50);
		controller.abort();

		const err = (await running.catch(e => e)) as Error;
		expect(err.message).toContain("it produced no output before the cancellation");
	});

	it("refuses to start a cell when the signal fired before the call", async () => {
		// The entry guard, kept honest. An already-aborted signal must never reach a
		// backend at all.
		const tool = new EvalTool(makeSession());
		const controller = new AbortController();
		controller.abort();

		await expect(
			tool.execute(
				"call-cancel-preaborted",
				{ language: "js", code: "print('must not run');", timeout: 0 },
				controller.signal,
			),
		).rejects.toBeInstanceOf(ToolAbortError);
	});
});

describe("EvalTool without a cancellation", () => {
	// NON-VACUITY. Every assertion above is about a failure path, so each of them
	// would still pass against a tool that rejected every call. These two prove the
	// ordinary run is untouched, and they are the reason the suite above means
	// anything.
	afterAll(async () => {
		await disposeAllVmContexts();
	});

	it("resolves normally and produces its output", async () => {
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-no-cancel", {
			language: "js",
			code: "print('finished cleanly');",
			timeout: 0,
		});

		expect(textOf(result)).toContain("finished cleanly");
		expect(result.details?.cells?.[0]?.status).toBe("complete");
	});

	it("still reports an ordinary failure as an error result, not as an abort", async () => {
		// The distinction the fix exists to create, asserted from the other side: a
		// cell that throws must NOT come back as a cancellation, or the agent loop
		// would stop on something it should retry.
		const tool = new EvalTool(makeSession());
		const result = await tool
			.execute("call-throwing-cell", {
				language: "js",
				code: "throw new Error('deliberate failure');",
				timeout: 0,
			})
			.catch(e => e);

		expect(result).not.toBeInstanceOf(ToolAbortError);
		expect(textOf(result as { content: Array<{ type: string; text?: string }> })).toContain("deliberate failure");
	});
});

describe("EvalTool timeout stays a timeout", () => {
	// The line between the watchdog and a cancellation. Both set the same
	// `cancelled` flag on the backend result, so the only thing separating them is
	// which signal actually fired, and getting that wrong in either direction
	// costs the model the information it needs: a cancellation it should stop for,
	// or a budget it could have raised.
	afterAll(async () => {
		await disposeAllVmContexts();
	});

	it("returns the backend's timeout annotation instead of throwing an abort", async () => {
		const tool = new EvalTool(makeSession());
		const result = await tool
			.execute("call-timeout-not-abort", {
				language: "js",
				code: "await Bun.sleep(4000); return 'never';",
				timeout: 1,
			})
			.catch(e => e);

		expect(result).not.toBeInstanceOf(ToolAbortError);
		expect(textOf(result as { content: Array<{ type: string; text?: string }> })).toContain("timed out");
	});
});
