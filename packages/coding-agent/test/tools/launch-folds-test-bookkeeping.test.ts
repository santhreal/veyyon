/**
 * `launch logs` folds test bookkeeping, the third and last wiring site.
 *
 * WHY THIS SUITE EXISTS. A test suite streamed through a launched process lands in the
 * conversation exactly as one run through `bash` or `eval` does, so `output-fold` is wired into
 * all three. The eval and bash wirings are pinned by their own suites; this one was a single call
 * with a comment and no test, which is how a refactor removes it without any gate noticing — the
 * output would still look right, just several times larger, and the cost is invisible in a diff.
 *
 * The daemon client is stubbed. What is under test is that `LaunchTool` folds what it puts in
 * context and keeps the failure lines, not the broker.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as launchClient from "@veyyon/coding-agent/launch/client";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { LaunchTool } from "@veyyon/coding-agent/tools/launch";
import { MIN_FOLDABLE_LINES } from "@veyyon/coding-agent/tools/output-fold";

/** A `go test -v` run: bookkeeping for the tests that passed, one real failure, a verdict. */
function goTestLog(): string {
	const lines: string[] = [];
	for (let index = 0; index < MIN_FOLDABLE_LINES + 8; index++) {
		lines.push(`=== RUN   TestThing/case_${index}`);
		lines.push(`--- PASS: TestThing/case_${index} (0.00s)`);
	}
	lines.push("=== RUN   TestBroken");
	lines.push("    thing_test.go:42: expected 3, got 4");
	lines.push("--- FAIL: TestBroken (0.01s)");
	lines.push("FAIL");
	return `${lines.join("\n")}\n`;
}

function stubLogs(text: string): void {
	vi.spyOn(launchClient, "daemonClientForProject").mockResolvedValue({
		async request() {
			return {
				op: "logs" as const,
				name: "suite",
				state: "running" as const,
				cursor: 42,
				timedOut: false,
				text,
			};
		},
	} as never);
}

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/launch-fold-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: { get: () => undefined } as never,
	} as ToolSession;
}

async function readLogs(): Promise<string> {
	const tool = new LaunchTool(makeSession());
	const result = await tool.execute("call-logs", { op: "logs", name: "suite" } as never);
	return result.content.find(block => block.type === "text")?.text ?? "";
}

describe("LaunchTool and the test-output fold", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("folds the bookkeeping out of the logs it puts in context", async () => {
		stubLogs(goTestLog());

		const text = await readLogs();

		expect(text).toContain("[folded 21 === RUN/CONT/PAUSE lines; failures are never folded]");
		expect(text).toContain("[folded 20 --- PASS/SKIP lines; failures are never folded]");
		expect(text).not.toContain("=== RUN   TestThing/case_0");
		expect(text).not.toContain("--- PASS: TestThing/case_0 (0.00s)");
	});

	it("keeps every failure line and the daemon footer", async () => {
		// The footer names the daemon and the cursor, which is how the agent asks for the
		// next chunk. Folding must not eat it, and it is appended after the log text, so a
		// fold that mishandled the tail would take it.
		stubLogs(goTestLog());

		const text = await readLogs();

		expect(text).toContain("thing_test.go:42: expected 3, got 4");
		expect(text).toContain("--- FAIL: TestBroken (0.01s)");
		expect(text).toContain("[suite: running; cursor=42]");
	});

	it("leaves ordinary log output untouched", async () => {
		// The negative twin. Every `launch logs` call goes through the fold, so a pattern
		// that matched an application's own logging would corrupt all of them.
		stubLogs("server listening on :8080\nok, ready\nGET /health 200\n");

		const text = await readLogs();

		expect(text).toContain("server listening on :8080");
		expect(text).toContain("ok, ready");
		expect(text).toContain("GET /health 200");
		expect(text).not.toContain("[folded");
	});
});
