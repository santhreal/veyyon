import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { disposeAllVmContexts } from "@veyyon/coding-agent/eval/js/context-manager";
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

/**
 * Defends the contract that a cell which does not delegate to an `agent()`/
 * `completion()` bridge call is bounded by a *plain wall-clock* timeout — not the
 * activity watchdog, which now only extends the budget while a bridge call is in
 * flight. Regression guard for the watchdog killing ordinary compute cells and
 * surfacing a misleading "of inactivity" message.
 */
describe("EvalTool timeout semantics", () => {
	afterAll(async () => {
		await disposeAllVmContexts();
	});

	it("disables the cell timeout when timeout is zero", async () => {
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-unlimited-timeout", {
			language: "js",
			// This integration test must cross the former 1s watchdog boundary;
			// fake timers do not drive the isolated JS worker's clock.
			code: "await Bun.sleep(1250); print('completed');",
			timeout: 0,
		});

		expect(result.content.some(block => block.type === "text" && block.text.includes("completed"))).toBe(true);
		expect(result.details?.cells?.[0]?.status).toBe("complete");
	});

	it("bounds a compute cell (no agent/completion) by a plain wall-clock timeout", async () => {
		const tool = new EvalTool(makeSession());
		// 1s budget; the cell idles for 5s and emits no status, so nothing extends
		// the budget — it must be cut off at the wall-clock limit.
		const result = await tool.execute("call-compute-timeout", {
			language: "js",
			code: "await Bun.sleep(2000); return 'never';",
			timeout: 1,
		});

		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(text).toContain("timed out after 1 seconds");
		// The new wording is a plain wall-clock timeout, not an inactivity stall.
		expect(text).not.toContain("inactivity");
		expect(text).not.toContain("never");

		const cell = result.details?.cells?.[0];
		expect(cell?.exitCode).toBeUndefined();
	});

	// eval used to clamp an over-ceiling timeout silently (only bash reported the
	// clamp). These lock the fix: an over-ceiling request is pinned to eval's
	// 3600s max AND the caller is told, while an in-range or disabled timeout
	// says nothing about clamping.
	it("surfaces a notice when the requested timeout exceeds eval's ceiling", async () => {
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-clamp-notice", {
			language: "js",
			code: "print('ok');",
			timeout: 99_999, // eval max is 3600s
		});

		expect(result.details?.notice).toContain("Timeout clamped to 3600s (requested 99999s; allowed range 1-3600s).");
	});

	it("emits no clamp notice for an in-range timeout", async () => {
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-inrange-timeout", {
			language: "js",
			code: "print('ok');",
			timeout: 15,
		});

		expect(result.details?.notice ?? "").not.toContain("clamped");
	});

	it("emits no clamp notice when the timeout is disabled (0)", async () => {
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-zero-timeout-notice", {
			language: "js",
			code: "print('ok');",
			timeout: 0,
		});

		expect(result.details?.notice ?? "").not.toContain("clamped");
	});

	it("reports a dead JS worker instead of waiting for the cell timeout", async () => {
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-worker-exit", {
			language: "js",
			code: "process.exit(0);",
			timeout: 1,
		});

		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(text).toContain("JS eval worker exited");
		expect(text).not.toContain("timed out");

		const cell = result.details?.cells?.[0];
		expect(cell?.status).toBe("error");
		expect(cell?.exitCode).toBe(1);
	});
});
