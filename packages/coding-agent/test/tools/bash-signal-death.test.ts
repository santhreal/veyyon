/**
 * A command killed by a signal reports WHICH signal, separately from `$?`.
 *
 * WHY THIS SUITE EXISTS (BASH-SIGNAL-DEATH-INDISTINGUISHABLE). A shell reports a
 * signalled death through `$?` as `128 + signal`, so SIGKILL becomes 137. A
 * program that calls `exit(137)` produces the identical status. Before this
 * contract existed, veyyon had nothing but that number, so an out-of-memory kill
 * and a program returning 137 on purpose were byte-identical in the tool result.
 *
 * That matters because the two want opposite responses. An OOM kill retried
 * verbatim spends the same memory and dies the same way; the fix is a smaller
 * batch or a bigger machine. A program returning 137 is reporting something
 * about its own work, and its output is where the answer is. Merging them makes
 * the model take the wrong action confidently.
 *
 * The fix is additive on purpose: `exitCode` still carries 128+N, because
 * scripts compare `$?` against 137 and 143 and changing that would break them.
 * The raw signal rides alongside it. So every test here asserts BOTH halves, and
 * asserts the negative case as loudly as the positive one. A build that set the
 * signal field unconditionally would satisfy every "the kill reports 9" check
 * while relabelling all 61 ordinary exits as signal deaths, which is worse than
 * the ambiguity it replaced.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import { removeWithRetries, SIGNAL_EXIT_BASE, signalName, signalNumber } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";

useIsolatedGlobalSettings();

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-signal-death-"));
});

afterEach(async () => {
	await removeWithRetries(tmpDir);
});

function bashTool(): BashTool {
	return new BashTool(
		makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			getSessionId: () => "bash-signal-death",
			allocateOutputArtifact: async kind => ({ id: `${kind}-1`, path: path.join(tmpDir, `${kind}-1.txt`) }),
			settings: {
				get(key: string) {
					if (key === "async.enabled") return false;
					if (key === "bash.autoBackground.enabled") return false;
					if (key === "bash.autoBackground.thresholdMs") return 60_000;
					if (key === "bashInterceptor.enabled") return false;
					return undefined;
				},
				getBashInterceptorRules: () => [],
			},
			getClientBridge: () => undefined,
		}) as never,
	);
}

interface RunOutcome {
	exitCode: number | undefined;
	signal: number | undefined;
	text: string;
}

async function run(id: string, command: string): Promise<RunOutcome> {
	const result = await bashTool().execute(id, { command, timeout: 20 });
	const details = result.details as { exitCode?: number; signal?: number } | undefined;
	const text = (result.content ?? [])
		.filter(block => block.type === "text")
		.map(block => (block as { text: string }).text)
		.join("");
	return { exitCode: details?.exitCode, signal: details?.signal, text };
}

describe("a signalled death reports the signal alongside the folded exit code", () => {
	/**
	 * The core contract, across the signals that actually reach veyyon in
	 * practice: SIGKILL is what the OOM killer and a hard timeout send, SIGTERM
	 * is a polite shutdown, SIGSEGV is a crash, SIGINT is a Ctrl-C, and SIGABRT
	 * is an assertion failure. Each is checked per signal rather than once,
	 * because a fold that dropped the number would still pass a single-signal
	 * test that happened to use the one hardcoded value.
	 *
	 * Both halves are asserted on every row: the exit code keeps 128+N so `$?`
	 * stays bash-compatible, and the signal is the raw number.
	 */
	it.each([
		["SIGINT", 2],
		["SIGABRT", 6],
		["SIGKILL", 9],
		["SIGSEGV", 11],
		["SIGTERM", 15],
	])("reports %s as signal %i with exit code 128 + it", async (name, number) => {
		const outcome = await run(`sig-${name}`, `sh -c 'kill -${number} $$'`);

		expect(outcome.signal).toBe(number);
		expect(outcome.exitCode).toBe(SIGNAL_EXIT_BASE + number);
	});

	/**
	 * The negative half, and the one that keeps the field honest. Every exit code
	 * in the 128+N range is reachable by a program calling `exit` directly, and
	 * none of those is a signal death. Checked across the same range the positive
	 * cases cover, so a build that inferred the signal FROM the exit code would
	 * fail here rather than passing everything above.
	 */
	it.each([130, 134, 137, 139, 143])("does not claim a signal for a literal exit %i", async code => {
		const outcome = await run(`exit-${code}`, `exit ${code}`);

		expect(outcome.exitCode).toBe(code);
		expect(outcome.signal).toBeUndefined();
	});

	/**
	 * An ordinary failure outside the signal range must also carry no signal.
	 * This is the common case by far, so a regression here would be everywhere at
	 * once rather than in a corner.
	 */
	it("reports no signal for an ordinary non-zero exit", async () => {
		const outcome = await run("exit-1", "exit 1");

		expect(outcome.exitCode).toBe(1);
		expect(outcome.signal).toBeUndefined();
	});

	/**
	 * And success carries neither. `exitCode` is omitted entirely on success
	 * rather than reported as 0, and the signal must follow the same rule instead
	 * of appearing as a stray 0.
	 */
	it("reports neither field on success", async () => {
		const outcome = await run("success", "true");

		expect(outcome.exitCode).toBeUndefined();
		expect(outcome.signal).toBeUndefined();
	});
});

describe("the signal survives the shell constructs a command is wrapped in", () => {
	/**
	 * The killed process is the LAST stage of a pipeline, so its status is the
	 * pipeline's status, and the signal has to travel with it. A pipeline is the
	 * ordinary way a long command is written, so losing the signal here would
	 * lose it for most real commands.
	 */
	it("survives being the last stage of a pipeline", async () => {
		const outcome = await run("pipeline-tail", "echo hi | sh -c 'kill -9 $$'");

		expect(outcome.exitCode).toBe(137);
		expect(outcome.signal).toBe(9);
	});

	/**
	 * A subshell's exit code is deliberately preserved by the shell while its
	 * control-flow requests are discarded. The signal belongs with the code, not
	 * with the control flow, so it must be preserved on that same path.
	 */
	it("survives a subshell", async () => {
		const outcome = await run("subshell", "(sh -c 'kill -9 $$')");

		expect(outcome.exitCode).toBe(137);
		expect(outcome.signal).toBe(9);
	});

	/**
	 * A command list reports its LAST command's status, so a kill followed by a
	 * clean command must report the clean one, with no signal left over. A field
	 * that stuck to the result after the process it described was gone would
	 * attribute a kill to a command that exited normally, which is a worse lie
	 * than reporting nothing.
	 */
	it("does not leak onto a later command that exited cleanly", async () => {
		const outcome = await run("kill-then-true", "sh -c 'kill -9 $$'; true");

		expect(outcome.exitCode).toBeUndefined();
		expect(outcome.signal).toBeUndefined();
	});

	/**
	 * Negation inverts the exit code, so the code no longer describes how the
	 * process ended. Reporting a signal beside an inverted code would say the
	 * command succeeded BECAUSE it was killed, which is nonsense; the signal must
	 * be dropped with the code it belonged to.
	 */
	it("is dropped when the exit code is inverted by `!`", async () => {
		const outcome = await run("negated-kill", "! sh -c 'kill -9 $$'");

		expect(outcome.exitCode).toBeUndefined();
		expect(outcome.signal).toBeUndefined();
	});
});

describe("the visible output names the signal", () => {
	/**
	 * The details object is for programmatic callers; the model reads the text.
	 * A distinction that exists only in `details` is invisible where it matters
	 * most, so the notice names the signal AND keeps the numeric code, because a
	 * script author reading the transcript still wants the 137.
	 */
	it("names the signal and keeps the numeric code in the failure notice", async () => {
		const outcome = await run("kill-notice", "sh -c 'kill -9 $$'");

		expect(outcome.text).toContain("SIGKILL");
		expect(outcome.text).toContain("137");
	});

	/**
	 * The notice for a signalled death must not be the ordinary-exit wording, or
	 * a reader skimming for "Command exited with code" would treat the two the
	 * same and the naming above would be decoration.
	 */
	it("does not use the ordinary-exit wording for a killed command", async () => {
		const outcome = await run("kill-wording", "sh -c 'kill -15 $$'");

		expect(outcome.text).toContain("SIGTERM");
		expect(outcome.text).not.toContain("Command exited with code 143");
	});

	/**
	 * And the reverse: an ordinary exit in the signal range must keep the plain
	 * wording with no signal name anywhere in it.
	 */
	it("keeps the plain wording for a literal exit in the signal range", async () => {
		const outcome = await run("exit-143-wording", "exit 143");

		expect(outcome.text).toContain("Command exited with code 143");
		expect(outcome.text).not.toContain("SIGTERM");
	});
});

describe("signal name and number conversion", () => {
	/**
	 * The conversion helpers are the single place the 128 offset and the
	 * name/number mapping are spelled out, so they are pinned directly rather
	 * than only through the shell. The values come from `os.constants.signals`,
	 * which is why nothing here asserts a number that differs between platforms.
	 */
	it("maps the common signal names to their numbers", () => {
		expect(signalNumber("SIGKILL")).toBe(os.constants.signals.SIGKILL);
		expect(signalNumber("SIGTERM")).toBe(os.constants.signals.SIGTERM);
		expect(signalNumber("SIGINT")).toBe(os.constants.signals.SIGINT);
	});

	/**
	 * Both spellings reach veyyon: PTYs and `Bun.Subprocess.signalCode` report
	 * the prefixed name, while some wire formats drop the prefix. Accepting only
	 * one would silently fail to resolve half the inputs.
	 */
	it("accepts the bare name as well as the SIG-prefixed one", () => {
		expect(signalNumber("KILL")).toBe(os.constants.signals.SIGKILL);
		expect(signalNumber("kill")).toBe(os.constants.signals.SIGKILL);
		expect(signalNumber(" SIGTERM ")).toBe(os.constants.signals.SIGTERM);
	});

	/**
	 * An unknown name resolves to `undefined` rather than to a guess. The bridge
	 * path turns that into a thrown error instead of a fabricated exit code, so
	 * this returning a number would be the root of a silent wrong answer.
	 */
	it("returns undefined for a name this platform does not have", () => {
		expect(signalNumber("SIGNOTAREALSIGNAL")).toBeUndefined();
		expect(signalNumber("")).toBeUndefined();
	});

	/**
	 * The inverse direction is built by inverting the same platform table, so the
	 * two can never disagree. Round-tripping is what proves that rather than
	 * assuming it.
	 */
	it("round-trips a number back to its name", () => {
		for (const name of ["SIGKILL", "SIGTERM", "SIGINT", "SIGSEGV"]) {
			const number = signalNumber(name);
			expect(number).toBeDefined();
			expect(signalName(number as number)).toBe(name);
		}
	});

	/** The offset is a named constant so no caller writes 128 inline. */
	it("uses 128 as the shell's signal exit offset", () => {
		expect(SIGNAL_EXIT_BASE).toBe(128);
	});
});
