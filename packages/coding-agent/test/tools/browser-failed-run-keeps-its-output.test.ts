/**
 * A `browser run` that throws still reports what it printed first.
 *
 * WHY THIS SUITE EXISTS. Both browser backends built the run's output into a `RunOutput` and then
 * threw it away on the failure path: the worker backend sent `{ ok: false, error }` and dropped
 * `output.finish()`, and the cmux backend rethrew straight past it. The result was that a cell
 * which displayed a page observation and then hit the cell deadline came back as a bare "Browser
 * code execution timed out" with none of the evidence it had just produced. That is precisely
 * inverted: a run that succeeds needs its output least, and a run that fails needs it most.
 *
 * The contract pinned here is that a failed run's error carries `partialRunOutput`, so the tool
 * can fold the text into the message and still render the screenshots. The suite drives the REAL
 * `runCmuxCode` with a real `JsRuntime`, so it exercises the actual display plumbing rather than
 * asserting that a field was copied between two literals.
 */
import { describe, expect, it } from "bun:test";
import { JsRuntime } from "@veyyon/coding-agent/eval/js/shared/runtime";
import { type CmuxTab, runCmuxCode } from "@veyyon/coding-agent/tools/browser/cmux/cmux-tab";
import type { BrowserRunError, SessionSnapshot } from "@veyyon/coding-agent/tools/browser/tab-protocol";
import { ToolError } from "@veyyon/coding-agent/tools/tool-errors";

const SNAPSHOT = { cwd: process.cwd() } as unknown as SessionSnapshot;

/**
 * The narrowest tab `runCmuxCode` actually touches: it stores a run context, hands back a runtime,
 * and clears the context afterwards. A real `JsRuntime` is used so `display()` travels the genuine
 * hook path into `RunOutput` instead of being simulated.
 */
function stubTab(): CmuxTab {
	let runtime: JsRuntime | undefined;
	return {
		page: {},
		browser: {},
		setRunContext: () => {},
		clearRunContext: () => {},
		ensureRuntime: () => {
			runtime ??= new JsRuntime({ initialCwd: process.cwd(), sessionId: "browser-failed-run-test" });
			return runtime;
		},
	} as unknown as CmuxTab;
}

async function runAndCatch(code: string): Promise<BrowserRunError> {
	try {
		await runCmuxCode(stubTab(), {
			code,
			timeoutMs: 10_000,
			snapshot: SNAPSHOT,
			session: { cwd: process.cwd() } as never,
		});
	} catch (error) {
		return error as BrowserRunError;
	}
	throw new Error("The run was expected to fail, but it succeeded.");
}

describe("a browser run that throws", () => {
	/**
	 * THE CORE REGRESSION. Everything displayed before the throw must survive on the error. Before
	 * the fix this list was discarded and the operator saw only "boom", which is the failure mode
	 * that makes a browser run undebuggable: the run tells you what it found, then explains
	 * nothing about why it stopped.
	 */
	it("carries the text it displayed before failing", async () => {
		const error = await runAndCatch(
			`display("first observation");\ndisplay("second observation");\nthrow new Error("boom");`,
		);

		expect(error.message).toContain("boom");
		const text = (error.partialRunOutput?.displays ?? [])
			.filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
			.map(entry => entry.text)
			.join("\n");
		expect(text).toContain("first observation");
		expect(text).toContain("second observation");
	});

	/**
	 * The attachment is present but EMPTY when the run failed before printing anything. An empty
	 * list and a missing list must stay distinguishable, because the tool decides whether to
	 * prepend anything to the error text from exactly this.
	 */
	it("reports an empty output rather than none when it failed silently", async () => {
		const error = await runAndCatch(`throw new Error("immediate");`);

		expect(error.partialRunOutput).toBeDefined();
		expect(error.partialRunOutput?.displays).toEqual([]);
		expect(error.partialRunOutput?.screenshots).toEqual([]);
	});

	/**
	 * A run that SUCCEEDS is untouched by this path: its output arrives as the normal result, and
	 * nothing is smuggled onto an error that does not exist. This is the negative control that
	 * keeps the failure path from being wired into the success path.
	 */
	it("returns its output normally when it does not fail", async () => {
		const result = await runCmuxCode(stubTab(), {
			code: `display("all good");\nreturn 42;`,
			timeoutMs: 10_000,
			snapshot: SNAPSHOT,
			session: { cwd: process.cwd() } as never,
		});

		expect(result.returnValue).toBe(42);
		const text = result.displays
			.filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
			.map(entry => entry.text)
			.join("\n");
		expect(text).toContain("all good");
	});

	/**
	 * A `ToolError` thrown by user code (`assert`) keeps its class through the enrichment. The tool
	 * layer and the approval/retry plumbing branch on `instanceof ToolError`, so attaching output
	 * must not silently reclassify a failure into a generic one.
	 */
	it("preserves the error class while attaching output", async () => {
		const error = await runAndCatch(`display("before the assert");\nassert(false, "assertion failed here");`);

		expect(error).toBeInstanceOf(ToolError);
		expect(error.message).toContain("assertion failed here");
		expect(error.partialRunOutput?.displays.length).toBeGreaterThan(0);
	});
});
