/**
 * A command that expects a human cannot hang the agent.
 *
 * WHY THIS SUITE EXISTS (EXEC-5). The agent runs commands nobody vetted, and a
 * great many of them will wait forever given the chance: `git push` asking for a
 * password, `apt-get` asking to confirm, `git log` opening a pager that waits for
 * `q`, anything reading stdin. There is no human at the other end, so every one
 * of those is an indefinite hang. And a hang is worse than a failure: a failure
 * comes back with output the model can react to, while a hang consumes the
 * session with nothing to show and no signal about which command did it.
 *
 * Four independent mechanisms prevent it, and this suite proves each one
 * SEPARATELY rather than proving "nothing hung". That distinction matters: any
 * one of the four would hide the loss of the other three, and the timeout in
 * particular would make a suite look green while every prompt-suppression measure
 * had quietly stopped working, turning instant answers into slow timeouts.
 *
 *   1. stdin is at EOF, so a read returns instead of waiting,
 *   2. stdin is not a TTY, so tools take their non-interactive branch,
 *   3. the non-interactive environment disables pagers, editors, and prompts,
 *   4. a bounded timeout is the backstop, and it reports what happened.
 *
 * The timeouts here are deliberately short, and the assertions on elapsed time
 * are one-sided (an upper bound only), so the suite cannot become flaky on a
 * loaded machine.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildNonInteractiveEnv, NON_INTERACTIVE_ENV } from "@veyyon/coding-agent/exec/non-interactive-env";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import { removeWithRetries } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";

useIsolatedGlobalSettings();

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-no-human-"));
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
			getSessionId: () => "bash-no-human",
			allocateOutputArtifact: async (kind: string) => ({
				id: `${kind}-1`,
				path: path.join(tmpDir, `${kind}-1.txt`),
			}),
			settings: {
				get(key: string) {
					if (key === "async.enabled") return false;
					if (key === "bash.autoBackground.enabled") return false;
					if (key === "bashInterceptor.enabled") return false;
					return undefined;
				},
				getBashInterceptorRules: () => [],
			},
			getClientBridge: () => undefined,
		}) as never,
	);
}

/** Run `command`, returning its text and how long the call took. */
async function runTimed(id: string, command: string, timeout: number): Promise<{ text: string; elapsedMs: number }> {
	const started = performance.now();
	const result = await bashTool().execute(id, { command, timeout });
	const text = (result.content ?? [])
		.filter(block => block.type === "text")
		.map(block => (block as { text: string }).text)
		.join("");
	return { text, elapsedMs: performance.now() - started };
}

describe("stdin is at EOF, so a command that reads it returns instead of waiting", () => {
	/**
	 * `read` is the bare form of the problem: with a terminal it blocks forever,
	 * and here it must come back at once with an empty value.
	 *
	 * The elapsed bound is the real assertion. Without it this passes even if the
	 * command blocked for the entire timeout, which is exactly the failure being
	 * excluded, so checking only the output would prove nothing.
	 */
	it("returns immediately from `read` with an empty value", async () => {
		const { text, elapsedMs } = await runTimed("read", "read -r line; echo got=$line", 10);
		expect(text).toContain("got=");
		expect(elapsedMs).toBeLessThan(5_000);
	});

	/** `cat` with no arguments is the accidental version, usually a mistyped pipe.
	 * It must end at EOF rather than hold the session open. */
	it("ends `cat` with no arguments at EOF rather than waiting for input", async () => {
		const { elapsedMs } = await runTimed("cat", "cat", 10);
		expect(elapsedMs).toBeLessThan(5_000);
	});

	/** A read loop is what a script does, and it must terminate on its own: zero
	 * iterations, no waiting, normal completion. */
	it("terminates a `while read` loop with no iterations", async () => {
		const { text, elapsedMs } = await runTimed(
			"loop",
			"n=0; while read -r _; do n=$((n+1)); done; echo lines=$n",
			10,
		);
		expect(text).toContain("lines=0");
		expect(elapsedMs).toBeLessThan(5_000);
	});
});

describe("stdin is not a TTY, so interactive tools take their non-interactive branch", () => {
	/**
	 * THE check that most command-line tools make before deciding to prompt,
	 * page, or animate. If stdin ever became a TTY, every one of them would switch
	 * to its interactive path at once, and the EOF protection above would not help
	 * because those tools open the terminal directly rather than reading stdin.
	 */
	it("reports stdin as not a terminal", async () => {
		const { text } = await runTimed("isatty", "if [ -t 0 ]; then echo TTY; else echo NOTTY; fi", 10);
		expect(text).toContain("NOTTY");
		expect(text).not.toContain("TTY\n\nWall");
	});

	/** stdout is checked separately by tools deciding whether to page or colourize,
	 * and it is a different file descriptor, so it needs its own assertion. */
	it("reports stdout as not a terminal", async () => {
		const { text } = await runTimed("isatty-out", "if [ -t 1 ]; then echo OUTTTY; else echo OUTPIPE; fi", 10);
		expect(text).toContain("OUTPIPE");
	});
});

describe("the non-interactive environment reaches the command", () => {
	/**
	 * These are asserted INSIDE a real command rather than by reading the constant,
	 * because the constant existing proves nothing about whether it survives the
	 * shell setup and the snapshot restore to arrive at the process that needs it.
	 *
	 * Each variable is a specific hang that has a name. `GIT_TERMINAL_PROMPT=0`
	 * turns a credential prompt into an error; `PAGER=cat` stops `git log` waiting
	 * on `q`; `DEBIAN_FRONTEND=noninteractive` stops a package install asking to
	 * confirm; `GIT_EDITOR=true` stops a commit opening an editor and blocking.
	 */
	it.each([
		["GIT_TERMINAL_PROMPT", "0"],
		["PAGER", "cat"],
		["GIT_PAGER", "cat"],
		["DEBIAN_FRONTEND", "noninteractive"],
		["GIT_EDITOR", "true"],
		["PIP_NO_INPUT", "1"],
		["COMPOSER_NO_INTERACTION", "1"],
		["TERM", "dumb"],
	])("sets %s to %s in the running command", async (key, value) => {
		const { text } = await runTimed(`env-${key}`, `echo "${key}=[$${key}]"`, 10);
		expect(text).toContain(`${key}=[${value}]`);
	});

	/** The builder returns the constant unchanged on a POSIX host, so a caller
	 * cannot be handed a partial environment; the Windows path adds UTF-8 defaults
	 * on top and is covered by that platform's own tests. */
	it("returns the full constant from buildNonInteractiveEnv on a POSIX host", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "linux");
		for (const [key, value] of Object.entries(NON_INTERACTIVE_ENV)) {
			expect(env[key]).toBe(value);
		}
	});

	/** An explicit override must win, or a caller could not set a variable a
	 * command genuinely needs. */
	it("lets an explicit override beat the default", () => {
		expect(buildNonInteractiveEnv({ PAGER: "less" }, {}, "linux").PAGER).toBe("less");
	});
});

describe("the timeout is the backstop, and it says what happened", () => {
	/**
	 * The last line of defence, for the command that hangs for a reason none of the
	 * three measures above can address: a network read with no timeout, a lock
	 * wait, a deadlock.
	 *
	 * It must THROW rather than return a quiet empty result, since a silent empty
	 * success would have the model treat the hang as a completed command and move
	 * on with a wrong conclusion.
	 */
	it("throws when a command outlives its timeout", async () => {
		await expect(bashTool().execute("sleep", { command: "sleep 30", timeout: 2 })).rejects.toThrow();
	});

	/** The message must name the timeout AND its duration. "Command failed" would
	 * leave the model unable to tell a hang from a crash, and unable to know the
	 * limit it should raise if the command was legitimately slow. */
	it("names the timeout and its duration in the error", async () => {
		let message = "";
		try {
			await bashTool().execute("sleep-msg", { command: "sleep 30", timeout: 2 });
		} catch (err) {
			message = String((err as Error).message);
		}
		expect(message).toContain("timed out");
		expect(message).toContain("2 seconds");
	});

	/**
	 * It fires at the deadline rather than at some later point, which is what makes
	 * the limit meaningful. The upper bound is generous so a loaded machine cannot
	 * make this flaky, but it is still far below the command's own 30 seconds, so a
	 * timeout that failed to fire is caught.
	 */
	it("fires near the deadline rather than running the command to completion", async () => {
		const started = performance.now();
		try {
			await bashTool().execute("sleep-timing", { command: "sleep 30", timeout: 2 });
		} catch {
			// The throw is the previous test's subject; the timing is this one's.
		}
		expect(performance.now() - started).toBeLessThan(15_000);
	});

	/** The false-positive half: a command that finishes inside its budget must not
	 * be killed. Without this, every assertion above would also hold for a tool
	 * that timed out unconditionally. */
	it("lets a command that finishes within its budget complete normally", async () => {
		const { text } = await runTimed("quick", "sleep 0.1; echo finished", 10);
		expect(text).toContain("finished");
		expect(text).not.toContain("timed out");
	});
});
