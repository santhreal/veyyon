/**
 * Aborting or timing out a command kills its whole process tree, not just the
 * process the tool was waiting on.
 *
 * WHY THIS SUITE EXISTS (EXEC-3). Killing only the direct child is the classic
 * half-fix: the tool returns promptly, the transcript says cancelled, and a
 * `webpack --watch` or a dev server keeps running with the port held and the CPU
 * spinning. Nothing reports it, because from the agent's side the command ended.
 * The damage accumulates across a session, and the user finds it hours later as a
 * machine full of processes they never started and cannot attribute.
 *
 * So every assertion here is on the STATE OF THE OPERATING SYSTEM after the fact,
 * via `process.kill(pid, 0)` against a pid the grandchild recorded itself. That a
 * `Command cancelled` error was thrown proves only that the tool stopped waiting,
 * which is precisely the thing that looks fine while orphans pile up.
 *
 * Two shell details this suite depends on, both learned by probing rather than
 * assumed. The shell is the native one from `@veyyon/natives`, not bash, so `$!`
 * is empty and a backgrounded job's pid cannot be captured that way. And a
 * grandchild recording `$$` from inside its own `sh -c` is the reliable way to
 * learn the pid, since it needs no cooperation from the shell running it.
 *
 * The `setsid` case at the end pins a real BOUNDARY rather than a success. Read
 * it before concluding this suite proves nothing escapes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import { removeWithRetries } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";

useIsolatedGlobalSettings();

let tmpDir: string;
/** Pids this file started, killed on the way out so a failure cannot leak the
 * very processes the suite is about. */
let startedPids: number[];

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-orphans-"));
	startedPids = [];
});

afterEach(async () => {
	for (const pid of startedPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone, which is the expected case.
		}
	}
	await removeWithRetries(tmpDir);
});

/**
 * Whether `pid` is a LIVE process. Signal 0 performs the permission and
 * existence check without delivering anything.
 *
 * A zombie answers signal 0 successfully and is not what this suite is about: it
 * has already been killed, holds no port, burns no CPU, and owns nothing but a
 * slot in its parent's wait queue. The distinction is load-bearing rather than
 * pedantic, because the sandbox runs the suite as PID 1 of a container and PID 1
 * here is the test harness, which never reaps a child it did not spawn. So a
 * grandchild whose own parent exited first is adopted by the harness, killed,
 * and then stays a zombie for the rest of the run. Signal 0 alone read that as a
 * surviving orphan, which is why `kills a descendant two levels down` failed
 * while the process had in fact been reaped: whether the middle shell or the leaf
 * died first decided the verdict.
 *
 * The state byte is read from procfs where there is one, and signal 0 remains
 * the answer everywhere else. A real escapee is `R`, `S` or `D` and is still
 * reported alive on every platform.
 */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	return !isZombie(pid);
}

function isZombie(pid: number): boolean {
	try {
		const stat = nodeFs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// The comm field is parenthesised and may itself contain spaces, so state
		// is the first field after the LAST ')'.
		const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim();
		return afterComm.startsWith("Z");
	} catch {
		// No procfs (macOS, Windows) or the process vanished between the two
		// reads: signal 0 already had the answer.
		return false;
	}
}

function bashTool(): BashTool {
	return new BashTool(
		makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			getSessionId: () => "bash-orphans",
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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Start `command`, wait for the descendant to record its pid, then end the run
 * either by aborting or by letting the timeout fire.
 *
 * @returns The descendant's pid and whether it was alive before the kill. The
 *   "before" half matters: without it, a test where the process never started
 *   would pass for the wrong reason.
 */
async function runAndEnd(
	label: string,
	buildCommand: (pidFile: string) => string,
	how: "abort" | "timeout",
): Promise<{ pid: number; aliveBefore: boolean }> {
	const pidFile = path.join(tmpDir, `${label}.pid`);
	const controller = new AbortController();
	const run = bashTool().execute(
		label,
		{ command: buildCommand(pidFile), timeout: how === "timeout" ? 2 : 60 },
		how === "abort" ? controller.signal : undefined,
	);

	// Long enough for the descendant to spawn and write its pid, comfortably
	// inside the 2 second timeout used by the timeout case.
	await sleep(1_500);
	let pid = 0;
	try {
		pid = Number.parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
	} catch {
		// Left as 0; the caller asserts it was found.
	}
	if (pid) startedPids.push(pid);
	const aliveBefore = pid > 0 && isAlive(pid);

	if (how === "abort") controller.abort();
	try {
		await run;
	} catch {
		// Cancellation and timeout both throw; the process state is the subject.
	}
	// Reaping is asynchronous, so allow it to land before observing.
	await sleep(2_500);
	return { pid, aliveBefore };
}

describe("aborting a command reaps its descendants", () => {
	/**
	 * The base case: one `sh` grandchild that outlives its parent's exit unless
	 * something kills the group.
	 *
	 * `aliveBefore` is asserted first and separately. Without it, a run where the
	 * process failed to start at all would satisfy "not alive afterwards" and the
	 * test would pass while proving nothing.
	 */
	it("kills a grandchild that would otherwise outlive the abort", async () => {
		const { pid, aliveBefore } = await runAndEnd("one-level", f => `sh -c 'echo $$ > ${f}; exec sleep 120'`, "abort");

		expect(pid).toBeGreaterThan(0);
		expect(aliveBefore).toBe(true);
		expect(isAlive(pid)).toBe(false);
	});

	/**
	 * Two levels deep, because a kill that walks only one generation would pass
	 * the test above and still strand everything a real build tool spawns. Depth is
	 * the norm rather than the exception: a package script starts a runner, which
	 * starts a compiler, which starts workers.
	 */
	it("kills a descendant two levels down", async () => {
		const { pid, aliveBefore } = await runAndEnd(
			"two-level",
			f => `sh -c 'sh -c "echo \\$\\$ > ${f}; exec sleep 120"'`,
			"abort",
		);

		expect(pid).toBeGreaterThan(0);
		expect(aliveBefore).toBe(true);
		expect(isAlive(pid)).toBe(false);
	});

	/** The caller-facing half: the tool must report the cancellation rather than
	 * returning a quiet empty success, or the model reads a killed command as one
	 * that finished with no output. */
	it("reports the cancellation to the caller", async () => {
		const controller = new AbortController();
		const run = bashTool().execute("cancel-msg", { command: "sleep 120", timeout: 60 }, controller.signal);
		await sleep(300);
		controller.abort();

		await expect(run).rejects.toThrow(/cancel/i);
	});
});

describe("a timeout reaps descendants the same way an abort does", () => {
	/**
	 * The timeout is a SEPARATE code path from the abort, and it is the one that
	 * fires unattended. If only the abort path reaped, every hung command in a long
	 * session would leave its tree behind, and nobody would be watching.
	 */
	it("kills a grandchild when the command times out", async () => {
		const { pid, aliveBefore } = await runAndEnd("timeout", f => `sh -c 'echo $$ > ${f}; exec sleep 120'`, "timeout");

		expect(pid).toBeGreaterThan(0);
		expect(aliveBefore).toBe(true);
		expect(isAlive(pid)).toBe(false);
	});
});

describe("the boundary: a process that leaves the group deliberately", () => {
	/**
	 * THE DOCUMENTED LIMIT, asserted so it is understood rather than discovered.
	 *
	 * `setsid` starts a new session and process group. That is not a gap in the
	 * kill, it is what the call MEANS: a process-group kill cannot reach a process
	 * that is no longer in the group, and no amount of care in the executor changes
	 * that. It is how daemons are supposed to survive their launching shell.
	 *
	 * The practical consequence is worth stating plainly, because it is the one
	 * case where a cancelled command really does leave something running: a command
	 * that daemonizes itself (`setsid`, a double fork, some service managers)
	 * survives the abort. Anything that needs to guarantee otherwise has to track
	 * descendants explicitly rather than rely on the group.
	 *
	 * Pinned as an expectation so that if the executor ever gains that tracking,
	 * this test fails and the failure is the prompt to document the stronger
	 * guarantee. The survivor is killed in `afterEach` like every other pid here.
	 */
	it("does not reach a setsid-detached process, which is what setsid means", async () => {
		const { pid, aliveBefore } = await runAndEnd(
			"setsid",
			f => `setsid sh -c 'echo $$ > ${f}; exec sleep 120' < /dev/null`,
			"abort",
		);

		expect(pid).toBeGreaterThan(0);
		expect(aliveBefore).toBe(true);
		expect(isAlive(pid)).toBe(true);
	});
});
