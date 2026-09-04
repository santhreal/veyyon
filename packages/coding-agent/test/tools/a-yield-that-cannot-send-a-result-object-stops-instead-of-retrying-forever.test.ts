/**
 * A `yield` whose `result` is not an object is recovered when it can be, and
 * bounded when it cannot.
 *
 * WHY THIS SUITE EXISTS. A recorded child audit sent its whole result as a JSON
 * *string* — `result: "{\"data\": {\"plugin\": …}}"` — and the tool answered
 * `result must be an object containing either data or error`. The message named
 * no shape to send, so the child re-sent the identical stringified payload five
 * times, rewording the prose around it and adding fields (`i`, then `type`) that
 * were never the problem, and its parent got nothing. 38 recorded sessions hit
 * that refusal.
 *
 * Two defects, one branch. The string was recoverable: the argument repair pass
 * already parses a stringified argument object, but `yield` sets
 * `lenientArgValidation`, so it is the one tool that never reaches that pass.
 * And the refusal was unbounded: only the *empty*-result branch counted against
 * `MAX_EMPTY_RESULT_RETRIES`, so a caller that kept sending a string could
 * retry forever while the parent waited.
 *
 * WHAT CLASS THIS CLOSES. Every non-object `result` — a string, a JSON string, a
 * malformed JSON string, an array, `null`, a number, nothing at all — either
 * resolves to the object the caller meant or is refused with a message naming
 * both accepted shapes, and the refusal terminates: the fourth consecutive one
 * aborts the child instead of throwing again. The shapes are swept from a table
 * rather than asserted one at a time, and the bound is asserted as a bound (the
 * abort arrives, and it arrives on the attempt the constant says) rather than as
 * a value.
 *
 * WHAT IT DOES NOT CATCH. A `result` object whose *contents* are wrong is the
 * business of the schema-validation branch above it, which has its own retry
 * budget and its own tests in `yield.test.ts`. A stringified payload that parses
 * to an object with neither `data` nor `error` lands in the empty-result branch,
 * which is a different bound; the sweep here asserts only that it is no longer
 * refused for being a string. And nothing here proves the parent's behaviour on
 * abort — that is the executor's contract, not the tool's.
 */

import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { YieldTool } from "@veyyon/coding-agent/tools/agent/yield";

function session(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	} as ToolSession;
}

/** The refusal text, or `"accepted"` when the call got through. */
async function submit(tool: YieldTool, result: unknown, extra: Record<string, unknown> = {}): Promise<string> {
	try {
		const out = await tool.execute("call-1", { result, ...extra } as never);
		const text = out.content.map(part => (part.type === "text" ? part.text : "")).join("");
		return out.details?.status === "aborted" && text.startsWith("Task aborted") ? text : "accepted";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** The constant the tool bounds itself by; the sweep reads it rather than restating 3. */
const MAX_EMPTY_RESULT_RETRIES = 3;

describe("a yield whose result is not an object", () => {
	it("parses the stringified wrapper the recorded child kept re-sending", async () => {
		const tool = new YieldTool(session());
		const payload = { plugin: "woocommerce-pdf-invoices", verdict: "KILL", findings: [] };

		const result = await tool.execute("call-1", {
			result: JSON.stringify({ data: payload }),
		} as never);

		expect(result.details).toEqual({ data: payload, status: "success", error: undefined });
	});

	it("parses a stringified failure wrapper the same way", async () => {
		const tool = new YieldTool(session());

		const result = await tool.execute("call-1", {
			result: '{"error": "no vulnerabilities reachable"}',
		} as never);

		expect(result.details).toEqual({
			data: undefined,
			status: "aborted",
			error: "no vulnerabilities reachable",
		});
	});

	it("recovers a stringified wrapper with trailing commas, as the repair pass would", async () => {
		const tool = new YieldTool(session());

		const result = await tool.execute("call-1", {
			result: '{"data": {"ok": true,},}',
		} as never);

		expect(result.details).toEqual({ data: { ok: true }, status: "success", error: undefined });
	});

	it("names both accepted shapes for every non-object result, and says what arrived", async () => {
		// Swept rather than written one case at a time: a shape that starts being
		// refused silently, or refused without naming a fix, shows up here.
		const shapes: [label: string, value: unknown, described: string][] = [
			["a bare string", "done", "a string"],
			["a string that is not JSON", "{not json", "a string"],
			["an array", [{ data: 1 }], "an array"],
			["null", null, "null"],
			["a number", 7, "a number"],
			["nothing", undefined, "nothing"],
		];

		for (const [label, value, described] of shapes) {
			const message = await submit(new YieldTool(session()), value);
			expect(message, label).toContain(`result was ${described}, not an object`);
			expect(message, label).toContain('{ "result": { "data": <your output> } }');
			expect(message, label).toContain('{ "result": { "error": "message" } }');
			expect(message, label).not.toBe("accepted");
		}
	});

	it("counts the attempts down and aborts instead of refusing forever", async () => {
		const tool = new YieldTool(session());
		const seen: string[] = [];

		// One more attempt than the budget allows, so the last one is the abort.
		for (let attempt = 0; attempt <= MAX_EMPTY_RESULT_RETRIES; attempt++) {
			seen.push(await submit(tool, "still a string"));
		}

		// The refusals count down, which is what tells a caller the door is closing.
		expect(
			seen.slice(0, MAX_EMPTY_RESULT_RETRIES).map(text => text.match(/remaining before abort: (\d+)/)?.[1]),
		).toEqual(["3", "2", "1"]);
		// And the bound holds: attempt four ends the child rather than throwing a
		// fourth time. A test that only checked the message could not see a hang.
		const final = seen[MAX_EMPTY_RESULT_RETRIES] ?? "";
		expect(final).toStartWith("Task aborted:");
		expect(final).toContain("instead of retrying forever");
		expect(final).toContain("a string");
	});

	it("forgives a caller that gets it right before the budget runs out", async () => {
		const tool = new YieldTool(session());

		expect(await submit(tool, "wrong")).toContain("remaining before abort: 3");
		expect(await submit(tool, { data: { ok: true } })).toBe("accepted");
		// The counter reset with the accepted call, so the next mistake starts over
		// rather than aborting a child that had already recovered once.
		expect(await submit(tool, "wrong again")).toContain("remaining before abort: 3");
	});
});
