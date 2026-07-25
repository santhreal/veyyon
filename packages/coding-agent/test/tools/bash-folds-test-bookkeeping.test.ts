/**
 * The bash tool folds test bookkeeping, and the operator sees that it did.
 *
 * WHY THIS SUITE EXISTS. `output-fold` cuts per-test bookkeeping out of tool output because
 * that output is re-read as a cache token on every later turn: on a measured 66-turn trace, three
 * verbose test results were 67% of all tool-result bytes. A test suite run through `bash` lands in
 * context identically to one run through `eval`, so the fold is wired into both — but the two tools
 * differ in a way that was documented in a comment and asserted nowhere.
 *
 * `eval` keeps a raw copy for the renderer, so the operator still reads the full run. `bash` has ONE
 * output string and the operator reads the same string the model does, so a folded bash run shows the
 * operator the marker line instead of the bookkeeping. That is acceptable because it is visible
 * rather than silent, and it is exactly the kind of asymmetry that gets "fixed" by someone who did
 * not know it was deliberate. These tests pin it, with the marker bytes, against real commands.
 */

import { describe, expect, it } from "bun:test";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import { MIN_FOLDABLE_LINES } from "@veyyon/coding-agent/tools/output-fold";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";

// `executeBash` initializes the GLOBAL Settings singleton itself, so a session stub alone leaves
// it loading the developer's real ~/.veyyon agent.db.
useIsolatedGlobalSettings();

function makeSession(): ToolSession {
	return makeToolSession({
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "grep.enabled") return false;
				if (key === "glob.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
	} as never);
}

/** A shell command that prints a `go test -v` run: bookkeeping, one failure, a verdict. */
function goTestCommand(): string {
	const lines: string[] = [];
	for (let index = 0; index < MIN_FOLDABLE_LINES + 8; index++) {
		lines.push(`=== RUN   TestThing/case_${index}`);
		lines.push(`--- PASS: TestThing/case_${index} (0.00s)`);
	}
	lines.push("=== RUN   TestBroken");
	lines.push("    thing_test.go:42: expected 3, got 4");
	lines.push("--- FAIL: TestBroken (0.01s)");
	lines.push("FAIL");
	// A literal here rather than a tab escape, so the assertion below compares the bytes the
	// shell actually emitted.
	lines.push("FAIL\texample.com/pkg\t0.312s");
	return lines.map(line => `printf '%s\\n' ${JSON.stringify(line)}`).join("; ");
}

async function runBash(command: string): Promise<string> {
	const tool = new BashTool(makeSession());
	const result = await tool.execute(`call-${command.length}`, { command });
	return result.content.find(block => block.type === "text")?.text ?? "";
}

describe("BashTool and the test-output fold", () => {
	it("folds the bookkeeping and keeps every failure line", async () => {
		const text = await runBash(goTestCommand());

		expect(text).toContain("[folded 21 === RUN/CONT/PAUSE lines; failures are never folded]");
		expect(text).toContain("[folded 20 --- PASS/SKIP lines; failures are never folded]");
		expect(text).not.toContain("=== RUN   TestThing/case_0");
		expect(text).not.toContain("--- PASS: TestThing/case_0 (0.00s)");
		// The lines the agent actually acts on.
		expect(text).toContain("thing_test.go:42: expected 3, got 4");
		expect(text).toContain("--- FAIL: TestBroken (0.01s)");
	});

	it("shows the operator the same folded string, which is the documented asymmetry", async () => {
		// One output string, one reader. If this ever diverges — a raw copy appearing in
		// details for the renderer — the comment in `output-fold` about bash and eval
		// differing has stopped being true and should be rewritten, not left to rot.
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-asymmetry", { command: goTestCommand() });

		const modelText = result.content.find(block => block.type === "text")?.text ?? "";
		expect(modelText).toContain("[folded 21 === RUN/CONT/PAUSE lines; failures are never folded]");
		expect(JSON.stringify(result.details ?? {})).not.toContain("=== RUN   TestThing/case_0");
	});

	it("folds a run that was killed by the timeout", async () => {
		// The gap this test was written for. The fold used to sit on the completed-command
		// path only, so a `go test ./...` killed at the timeout carried every bookkeeping
		// line into context in full — and a suite slow enough to be killed is exactly the
		// expensive case. The output arrives as a thrown error here, which is why it was
		// missed: a different return path, the same string in the same context.
		const tool = new BashTool(makeSession());

		const thrown = await tool
			.execute("call-timeout", { command: `${goTestCommand()}; sleep 5`, timeout: 1 })
			.then(() => undefined)
			.catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(message).toContain("[folded 20 --- PASS/SKIP lines; failures are never folded]");
		expect(message).not.toContain("--- PASS: TestThing/case_0 (0.00s)");
		// And the failure, plus the notice that says why the output stops where it does.
		expect(message).toContain("--- FAIL: TestBroken (0.01s)");
		expect(message).toMatch(/timed out|aborted|cancelled/i);
	});

	it("leaves ordinary command output untouched", async () => {
		// The negative twin, and the one that matters most: the fold runs on EVERY bash
		// result, so a pattern that matched ordinary output would corrupt every command
		// the agent runs.
		const text = await runBash("printf '%s\\n' 'ok, that worked' 'building the thing' '=== RUNNING the migration'");

		expect(text).toContain("ok, that worked");
		expect(text).toContain("building the thing");
		expect(text).toContain("=== RUNNING the migration");
		expect(text).not.toContain("[folded");
	});

	it("leaves a short run alone, below the fold's floor", async () => {
		// Three lines are cheaper to read than a marker line is to explain.
		const text = await runBash(
			"printf '%s\\n' '=== RUN   TestOnly' '--- PASS: TestOnly (0.00s)' 'ok\texample.com/pkg\t0.10s'",
		);

		expect(text).toContain("=== RUN   TestOnly");
		expect(text).toContain("--- PASS: TestOnly (0.00s)");
		expect(text).not.toContain("[folded");
	});

	it("folds a non-zero-exit run and still reports the exit code", async () => {
		// The expensive real case: a failing suite whose bulk is bookkeeping for the
		// tests that passed. The fold must apply, and the exit-code footer the agent
		// relies on must survive it.
		const text = await runBash(`${goTestCommand()}; exit 1`);

		expect(text).toContain("[folded 20 --- PASS/SKIP lines; failures are never folded]");
		expect(text).toContain("--- FAIL: TestBroken (0.01s)");
		expect(text).toContain("Command exited with code 1");
	});
});
