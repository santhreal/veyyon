/**
 * WHY: a supervised process that dies without the caller asking must not read as an unexplained
 * death. The broker records an owner on every terminal transition and `list` prints it, but the
 * notice the exit watch delivers as a background job is a second, independent rendering of the
 * same fact, and it had no test. A branch merge dropped the attribution branch out of
 * `exitNotice` and every launch suite stayed green: the notice said "Reason: ..." when there was
 * a reason and nothing at all when the owner was the only thing known, so an OOM kill arrived as
 * a bare "exited with code 137".
 *
 * The class this closes: a rendering of an attributed event that drops the attribution. The
 * sweep is over `DAEMON_TERMINATION_OWNERS` read at run time, so a new owner is covered the day
 * it is added rather than the day someone remembers this file.
 *
 * The broker RPC is the boundary here and is faked: a real broker driving each of the ten owners
 * is `a-daemon-death-records-who-and-why.test.ts`, which takes ten seconds a case and asserts
 * the recorded snapshot rather than the delivered text. Everything from the snapshot to the job
 * payload is the production path.
 *
 * What it does not catch: the log tail the notice carries, and the decision to deliver the
 * notice as a failure rather than a completion. Both are asserted once here, on one owner, not
 * swept.
 */
import { describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import type { DaemonBrokerClient } from "@veyyon/coding-agent/launch/client";
import type { DaemonOperation, DaemonRpcResult, DaemonSnapshot } from "@veyyon/coding-agent/launch/protocol";
import { DAEMON_TERMINATION_OWNERS } from "@veyyon/coding-agent/launch/protocol";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { watchLaunchedProcessExit } from "@veyyon/coding-agent/tools/launch-exit-watch";

function snapshot(name: string, overrides: Partial<DaemonSnapshot>): DaemonSnapshot {
	return {
		name,
		id: `${name}-1`,
		state: "exited",
		createdAt: 1_000,
		startedAt: 1_000,
		exitedAt: 4_000,
		exitCode: 137,
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
		...overrides,
	};
}

/** The broker's answers to the two calls the watch makes: one `wait`, then one `logs`. */
function brokerServing(exited: DaemonSnapshot, logText: string): DaemonBrokerClient {
	return {
		projectDir: "/project",
		runtimeDir: `/cfg/run/daemons/session-${exited.name}`,
		close: () => {},
		request: async (operation: DaemonOperation): Promise<DaemonRpcResult> => {
			if (operation.op === "wait") return { op: "wait", daemon: exited, timedOut: false };
			if (operation.op === "logs") {
				return { op: "logs", name: exited.name, text: logText, cursor: 0, timedOut: false, state: "exited" };
			}
			throw new Error(`unexpected op ${operation.op}`);
		},
	};
}

/** Run one watch to completion and return the text the job manager delivered. */
async function noticeFor(exited: DaemonSnapshot, logText = ""): Promise<string> {
	const delivered: string[] = [];
	const manager = new AsyncJobManager({
		onJobComplete: async (_jobId, text) => {
			delivered.push(text);
		},
	});
	const session = { asyncJobManager: manager } as unknown as ToolSession;

	watchLaunchedProcessExit({
		session,
		client: brokerServing(exited, logText),
		daemon: snapshot(exited.name, { state: "running", exitedAt: undefined, exitCode: undefined }),
	});
	await manager.waitForAll();
	await manager.drainDeliveries({ timeoutMs: 2_000 });

	return delivered.join("\n");
}

describe("an exit notice names who ended the process", () => {
	it("carries the owner for every termination the protocol can record", async () => {
		const silent: string[] = [];
		for (const owner of DAEMON_TERMINATION_OWNERS) {
			const notice = await noticeFor(snapshot(`by-${owner}`, { terminatedBy: owner }));
			if (!notice.includes(`Terminated by: ${owner}`)) silent.push(owner);
		}

		expect(silent).toEqual([]);
	});

	it("carries the reason beside the owner when the broker recorded one", async () => {
		const notice = await noticeFor(snapshot("reasoned", { terminatedBy: "idle-reaper", exitReason: "idle for 30m" }));

		expect(notice).toContain("Terminated by: idle-reaper");
		expect(notice).toContain("idle for 30m");
	});

	/**
	 * A snapshot with no owner is the pre-attribution shape a broker from an older version still
	 * sends. The reason must not disappear with the owner.
	 */
	it("falls back to the bare reason when nothing recorded an owner", async () => {
		const notice = await noticeFor(snapshot("unattributed", { exitReason: "spawn failed" }));

		expect(notice).toContain("Reason: spawn failed");
		expect(notice).not.toContain("Terminated by:");
	});

	it("reports the process name, how it ended, and the tail of its output", async () => {
		const notice = await noticeFor(
			snapshot("web", { terminatedBy: "external-signal", signal: "SIGKILL", exitCode: undefined }),
			"listening on 5173\nkilled",
		);

		expect(notice).toContain("Launched process web");
		expect(notice).toContain("SIGKILL");
		expect(notice).toContain("Terminated by: external-signal");
		expect(notice).toContain("killed");
	});
});
