/**
 * A finished agent keeps nothing of the run that spawned it.
 *
 * THE DEFECT. A kept-alive agent outlives its run: the live session holds the options it was created
 * with, and the lifecycle manager holds the reviver that rebuilds it after parking. The options'
 * `systemPrompt` callback and the reviver both closed over the run's context, whose run monitor holds
 * every assistant message of the run, and whose options hold the spawning tool call's `onProgress` and
 * abort signal. The task tool's `parentApprovalBypassed` arrow, and its fallback `local://` options,
 * were created in the spawn body, and a JavaScriptCore closure holds its whole enclosing scope, so each
 * one held the tool call's update callback and signal. Each progress snapshot's tail lines were cuts
 * of the streamed text, so a snapshot the tool call or the agent HUD kept held the message it was cut
 * from. An idle or parked agent held all of it until it was pruned.
 *
 * THE CLASS. Anything a finished agent's survivors reach that belongs to the run: its monitor, its
 * streamed text, its caller's callbacks and signals. The fixture spawns through the task tool, parks
 * the agent, wakes it with a follow-up turn, and holds every survivor whole: every option each child
 * session was created with, the lifecycle manager and agent registry with the reviver and live
 * session in them, each run's result and the last progress snapshot each caller received. A new
 * option, callback or registry field that reaches the run is measured with no change here.
 *
 * WHAT IT DOES NOT CATCH. The child is a mock session: state the real `AgentSession` builds from its
 * options is not constructed, so a path through the real session's internals is not measured. An
 * isolated run has no reviver and is not spawned. A background spawn's job record belongs to the job
 * manager and outlives the run by design; its closures are not measured.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { FinishedAgentRetention } from "../fixtures/finished-agent-retention";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "finished-agent-retention.ts");
/** A fresh process spawns, parks and wakes an agent that streams 4 MiB, and snapshots its own heap four times. */
const MEASURED_TIMEOUT_MS = 90_000;
/** String bytes both runs may leave live. One run's retained stream is 2 MiB. */
const RETAINED_LIMIT = 512 * 1024;
/** Bytes a tail line's cell may keep alive beyond its own characters. A cut of one streamed message keeps 256 KiB. */
const PINNED_LIMIT = 512;

let report: FinishedAgentRetention;

beforeAll(async () => {
	const { env, cleanup } = hermeticSpawnEnv();
	try {
		const { stdout, stderr } = await run(process.execPath, [FIXTURE], {
			env,
			timeout: MEASURED_TIMEOUT_MS - 5_000,
			killSignal: "SIGKILL",
			maxBuffer: 1024 * 1024,
		});
		expect(stderr).toBe("");
		report = JSON.parse(stdout) as FinishedAgentRetention;
	} finally {
		cleanup();
	}
}, MEASURED_TIMEOUT_MS);

describe("a finished agent", () => {
	it("was spawned, parked and revived, so both the live options and the reviver were held", () => {
		expect(report.sessionsCreated).toBe(2);
		expect(report.streamedChars).toBeGreaterThan(RETAINED_LIMIT * 4);
	});

	it("keeps none of the text its runs streamed", () => {
		expect(report.retainedBytes).toBeLessThan(RETAINED_LIMIT);
	});

	it("keeps neither caller's progress callback", () => {
		expect(report.callbacksCollected).toEqual([true, true]);
	});

	it("keeps neither caller's abort signal", () => {
		expect(report.signalsCollected).toEqual([true, true]);
	});

	it("hands out progress tail lines that keep no streamed message alive", () => {
		expect(report.tailLines).toBeGreaterThan(0);
		expect(report.tailPinned).toBeLessThan(PINNED_LIMIT);
	});
});
