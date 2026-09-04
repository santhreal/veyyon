/**
 * WHY: `runCommitAgentSession` used to write its own console output — chalk, a
 * markdown component and `process.stdout` inside the session subscription — so
 * the commit domain could not run under a host that draws differently, and the
 * engine import was charged to `commit/agentic/agent.ts`. The run now reports
 * through `CommitAgentReporter` and `createCommitConsoleReporter` is the only
 * module that draws it.
 *
 * The class this closes is "a commit run states what it drew instead of what
 * happened": the architecture ledger in
 * `test/architecture/only-the-terminal-host-imports-the-terminal-engine.test.ts`
 * goes red the moment a module outside the render sibling names the engine
 * again, and these cases pin the bytes the sibling produces so the move is not
 * a silent rewrite of the CLI's output.
 *
 * It does not catch a caller that installs no reporter where one is wanted:
 * `veyyon commit` is the only caller, and its wiring is a single argument.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createCommitConsoleReporter } from "@veyyon/coding-agent/commit/agentic/agent-render";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { INTENT_FIELD } from "@veyyon/wire";

const DONE_MARK = "\uf00c";
const FAILED_MARK = "\uf00d";

describe("the commit console draws what the commit agent reports", () => {
	let written: string[] = [];
	let restoreWrite: (() => void) | undefined;
	let originalIsTTY: boolean | undefined;
	let originalColumns: number | undefined;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	beforeEach(() => {
		written = [];
		const stream = process.stdout as unknown as {
			write: (chunk: string) => boolean;
			isTTY?: boolean;
			columns?: number;
		};
		const original = stream.write;
		stream.write = (chunk: string) => {
			written.push(chunk);
			return true;
		};
		restoreWrite = () => {
			stream.write = original;
		};
		originalIsTTY = stream.isTTY;
		originalColumns = stream.columns;
		stream.columns = 80;
	});

	afterEach(() => {
		restoreWrite?.();
		const stream = process.stdout as unknown as { isTTY?: boolean; columns?: number };
		stream.isTTY = originalIsTTY;
		stream.columns = originalColumns;
	});

	function setTTY(isTTY: boolean): void {
		(process.stdout as unknown as { isTTY?: boolean }).isTTY = isTTY;
	}

	it("draws a finished tool as its label with the arguments below it, and a failed one with the failure mark", () => {
		setTTY(true);
		const reporter = createCommitConsoleReporter();

		reporter.toolFinished("propose_commit", { [INTENT_FIELD]: "skipped", type: "fix", scope: "commit" }, false);
		reporter.toolFinished("analyze_files", undefined, true);

		expect(written).toEqual([
			`${DONE_MARK} ProposeCommit\n`,
			"  ⎿ type: fix\n    └ scope: commit\n",
			`${FAILED_MARK} AnalyzeFiles\n`,
		]);
	});

	it("bullets the first line of an assistant message and indents the rest", () => {
		setTTY(false);
		const reporter = createCommitConsoleReporter();

		reporter.assistantMessage("First line\n\nSecond line");

		const body = written.join("");
		const lines = body.split("\n").filter(line => line.length > 0);
		expect(lines[0]?.startsWith("● ")).toBe(true);
		expect(lines[0]).toContain("First line");
		expect(lines.slice(1).every(line => line.startsWith("  "))).toBe(true);
		expect(body).toContain("Second line");
	});

	it("holds the thinking preview back on a stream that is not a terminal, and clears it on one that is", () => {
		setTTY(false);
		const piped = createCommitConsoleReporter();
		piped.thinking("weighing the diff");
		piped.messageEnded();
		expect(written).toEqual([]);

		setTTY(true);
		const terminal = createCommitConsoleReporter();
		terminal.thinking("weighing the diff");
		terminal.messageEnded();
		expect(written.length).toBe(2);
		expect(written[0]).toContain("weighing the diff");
		expect(written[0]?.startsWith("\r\x1b[2K")).toBe(true);
		expect(written[1]).toBe("\r\x1b[2K");
	});

	it("bounds a long thinking preview so the overwritten line cannot wrap", () => {
		setTTY(true);
		const reporter = createCommitConsoleReporter();

		reporter.thinking("x".repeat(200));

		const line = written[0] ?? "";
		expect(line).toContain("…");
		expect(line).not.toContain("x".repeat(41));
	});

	it("reports the run's totals in one line", () => {
		setTTY(false);
		createCommitConsoleReporter().finished(3, 7);

		expect(written).toEqual(["● agent finished (3 messages, 7 tools)\n"]);
	});
});
