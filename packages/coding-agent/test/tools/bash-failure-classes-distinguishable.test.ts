/**
 * The three ways a command can fail come back as three different results.
 *
 * WHY THIS SUITE EXISTS (EXEC-4). When a command fails, the model decides what to
 * do next from the result alone, and the right next move differs completely by
 * failure class:
 *
 *   - a NON-ZERO EXIT means the program ran and disagreed, so read its output,
 *   - COMMAND NOT FOUND means nothing ran at all, so install it or fix the name,
 *   - DEATH BY SIGNAL means it was killed from outside, so it may be a timeout,
 *     an OOM kill, or a crash, and retrying verbatim is usually wrong.
 *
 * Collapse those into "it failed" and the model retries a missing binary as if it
 * were a flaky test. So each class is asserted here on the EXACT values a caller
 * can branch on, not on a substring of prose that could be reworded.
 *
 * The signal case used to be only half met. Commands run inside a persistent
 * shell, so the status the shell exposes through `$?` is already folded to
 * 128+N, which made `exit 137` and death by SIGKILL byte-identical. That is
 * fixed: the shell now carries the raw signal alongside the folded code, and the
 * two are separated here on exact values. `bash-signal-death.test.ts` covers the
 * signal contract in depth; what this file pins is that the three FAILURE
 * CLASSES stay distinguishable from one another.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import { removeWithRetries } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";

// `executeBash` calls `Settings.init()` itself, reaching past the session stub to
// the real config root; one line isolates the singleton for this file.
useIsolatedGlobalSettings();

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-failure-classes-"));
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
			getSessionId: () => "bash-failure-classes",
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

/** Run `command` and return its exit code and joined text. */
async function run(
	id: string,
	command: string,
): Promise<{ exitCode: number | undefined; signal: number | undefined; text: string }> {
	const result = await bashTool().execute(id, { command, timeout: 20 });
	const details = result.details as { exitCode?: number; signal?: number } | undefined;
	const text = (result.content ?? [])
		.filter(block => block.type === "text")
		.map(block => (block as { text: string }).text)
		.join("");
	return { exitCode: details?.exitCode, signal: details?.signal, text };
}

describe("a non-zero exit reports that exact code", () => {
	/**
	 * The code must be the NUMBER, on `details.exitCode`, because that is what a
	 * caller branches on. The suite this replaces accepted either the number or a
	 * substring of the status prose, so it passed whether or not the field was
	 * populated at all, which is the one thing it needed to prove.
	 */
	it.each([1, 2, 7, 42, 126])("reports exit code %i as a number in details", async code => {
		const { exitCode } = await run(`e${code}`, `exit ${code}`);
		expect(exitCode).toBe(code);
	});

	/**
	 * Success is the differential: a zero exit must NOT be dressed up as a
	 * failure, or every assertion above would also pass for a tool that reported
	 * failure unconditionally.
	 *
	 * Note the actual contract, which is absence rather than zero. `exitCode` is
	 * attached only when the exit is non-zero (`bash.ts` `if (failedExit)`), so a
	 * completed success carries no code at all and no "exited with code" line.
	 * That absence is unambiguous rather than sloppy, and the next test is what
	 * makes it so.
	 */
	it("omits exitCode entirely on success rather than reporting 0", async () => {
		const { exitCode, text } = await run("ok", "printf 'done\\n'");
		expect(exitCode).toBeUndefined();
		expect(text).toContain("done");
		expect(text).not.toContain("Command exited with code");
	});

	/**
	 * WHY the absence above is safe to read as success: the one other way a result
	 * could arrive with no exit code, a command whose status could not be
	 * determined, does not return at all. It throws. So within a returned result,
	 * "no exitCode" has exactly one meaning.
	 *
	 * Pinned because it is the load-bearing half of the omit-on-success design. If
	 * missing status ever became a silent undefined instead of a throw, success and
	 * unknown would collapse into the same result and this test is what says so.
	 */
	it("throws rather than returning when the exit status is missing", async () => {
		const source = await fs.readFile(path.join(import.meta.dir, "..", "..", "src", "tools", "bash.ts"), "utf8");
		expect(source).toContain("Command failed: missing exit status");
		expect(source).toMatch(/result\.exitCode === undefined[\s\S]{0,300}throw new ToolError/);
	});

	/** The prose must agree with the number. Two sources disagreeing is worse than
	 * one, because the model reads the prose and the caller reads the field. */
	it("states the same code in the status text", async () => {
		const { exitCode, text } = await run("e3", "exit 3");
		expect(exitCode).toBe(3);
		expect(text).toContain("Command exited with code 3");
	});

	/** The program's own output must survive a failing exit; it is usually the
	 * only thing that explains WHY it failed. */
	it("keeps the command's stderr alongside the failing code", async () => {
		const { exitCode, text } = await run("e-msg", "printf 'boom\\n' >&2; exit 4");
		expect(exitCode).toBe(4);
		expect(text).toContain("boom");
	});
});

describe("command not found is its own class, not just another non-zero exit", () => {
	/**
	 * THE distinction that matters most in practice. 127 is the POSIX code for
	 * "not found", and it must arrive with an explicit message naming the command,
	 * because a bare 127 reads like any other failure and the model retries.
	 */
	it("reports 127 and names the missing command", async () => {
		const { exitCode, text } = await run("nf", "definitely_not_a_real_command_xyz");
		expect(exitCode).toBe(127);
		expect(text).toContain("command not found");
		expect(text).toContain("definitely_not_a_real_command_xyz");
	});

	/** A misspelling deep in a pipeline is the realistic case, and the message
	 * must still name the offending word rather than the whole line. */
	it("names the missing command when it appears in a pipeline", async () => {
		const { exitCode, text } = await run("nf-pipe", "printf 'x\\n' | not_a_real_filter_abc");
		expect(exitCode).toBe(127);
		expect(text).toContain("not_a_real_filter_abc");
	});

	/**
	 * The false-positive guard: a command that EXISTS and merely exits 127 must
	 * not be reported as missing. Without this, a check that keyed on the number
	 * alone would mislabel it, which is exactly the confusion this class exists to
	 * prevent.
	 */
	it("does not claim not-found for a real command that exits 127", async () => {
		const { exitCode, text } = await run("e127", "exit 127");
		expect(exitCode).toBe(127);
		expect(text).not.toContain("command not found");
	});
});

describe("death by signal arrives as 128 plus the signal number", () => {
	/**
	 * The shell convention, pinned per signal so a change in how the child's
	 * status is read shows up as a specific wrong number rather than a vague
	 * failure. 9 is SIGKILL (the OOM killer's signal, and what a hard timeout
	 * sends) and 11 is SIGSEGV (a crash).
	 */
	it.each([
		["SIGKILL", 9, 137],
		["SIGSEGV", 11, 139],
	])("reports %s as %i + 128 = %i", async (_name, signal, expected) => {
		const { exitCode } = await run(`sig${signal}`, `sh -c 'kill -${signal} $$'`);
		expect(exitCode).toBe(expected);
	});

	/**
	 * The class separation this suite exists for, at its hardest case. A literal
	 * `exit 137` and a real SIGKILL produce the SAME exit code by design, because
	 * `$?` has to stay bash-compatible for scripts comparing against 137. The
	 * signal field is what tells them apart, and it is asserted in both
	 * directions: present and exact for the kill, absent for the plain exit.
	 *
	 * Asserting only the kill would pass against a build that set the field
	 * unconditionally, which would relabel every `exit 137` an OOM kill and be
	 * strictly worse than the ambiguity it replaced.
	 */
	it("separates a real SIGKILL from a literal exit 137", async () => {
		const killed = await run("real-kill", "sh -c 'kill -9 $$'");
		const plain = await run("plain-137", "exit 137");

		expect(killed.exitCode).toBe(137);
		expect(plain.exitCode).toBe(137);
		expect(killed.signal).toBe(9);
		expect(plain.signal).toBeUndefined();
	});

	/**
	 * And the prose separates them too, because the model reads the text, not the
	 * details object. The notice for a signalled death names the signal; the
	 * notice for an ordinary exit must NOT, or the distinction is undone at the
	 * only layer that reaches the model.
	 */
	it("says which one it was in the visible output", async () => {
		const killed = await run("real-kill-text", "sh -c 'kill -9 $$'");
		const plain = await run("plain-137-text", "exit 137");

		expect(killed.text).toContain("SIGKILL");
		expect(killed.text).toContain("137");
		expect(plain.text).toContain("Command exited with code 137");
		expect(plain.text).not.toContain("SIGKILL");
	});
});
