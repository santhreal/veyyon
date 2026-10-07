/**
 * A bash call whose caller cancels before its command starts never runs the command.
 *
 * WHY THIS SUITE EXISTS. `executeBash` checks the caller's signal on entry, then awaits the session CPU
 * budget (`gateSpawn`, `ensureGroup`: settings reads and cgroup creation) before it listens for an abort.
 * `addEventListener` on a signal that is already aborted never fires, so a cancel landing inside that wait
 * was dropped: the command ran to completion and the call reported it as finished.
 *
 * The class it closes: a cancel landing at any await of the budget join, inside the group creation the
 * spawn admission waits on, between the admission and the budget-name lookup, and inside that lookup.
 *
 * WHAT IT DOES NOT CATCH. A cancel landing after the run starts, which the native shell owns and
 * bash-executor.test.ts covers.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeBash } from "@veyyon/coding-agent/exec/bash-executor";
import {
	initSessionCpuLimit,
	resetSessionCpuLimitsForTests,
	type SessionCpuLimit,
	sessionCpuLimit,
} from "@veyyon/coding-agent/session/cpu-limit";
import { makeCgroupRoot, makeDelegatedParent, makeFakeHost, removeCgroupRoots } from "../helpers/fake-cgroup";

const SESSION = "cancel-before-start";
const dirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await sessionCpuLimit(SESSION)?.dispose();
	resetSessionCpuLimitsForTests();
	await removeCgroupRoots();
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function budgetedSession(): Promise<SessionCpuLimit> {
	const root = await makeCgroupRoot();
	await makeDelegatedParent(root);
	await initSessionCpuLimit({
		sessionId: SESSION,
		cores: 1,
		kill: false,
		onNotice: () => {},
		env: makeFakeHost(root).env,
	});
	const limiter = sessionCpuLimit(SESSION);
	if (!limiter) throw new Error("the session registered no CPU limiter");
	return limiter;
}

type Window =
	| "inside the group creation the admission waits on"
	| "after the admission"
	| "inside the budget-name lookup";

/** Abort `controller` at `window` of the budget join. */
function abortAt(window: Window, limiter: SessionCpuLimit, controller: AbortController): void {
	if (window === "after the admission") {
		const gateSpawn = limiter.gateSpawn.bind(limiter);
		vi.spyOn(limiter, "gateSpawn").mockImplementation(async what => {
			await gateSpawn(what);
			controller.abort();
		});
		return;
	}
	const ensureGroup = limiter.ensureGroup.bind(limiter);
	const abortOnCall = window === "inside the group creation the admission waits on" ? 1 : 2;
	let calls = 0;
	vi.spyOn(limiter, "ensureGroup").mockImplementation(async () => {
		const group = await ensureGroup();
		if (++calls === abortOnCall) controller.abort();
		return group;
	});
}

const WINDOWS: readonly Window[] = [
	"inside the group creation the admission waits on",
	"after the admission",
	"inside the budget-name lookup",
];

describe("a bash call cancelled before its command starts", () => {
	for (const window of WINDOWS) {
		it(`never runs the command when the cancel lands ${window}`, async () => {
			const limiter = await budgetedSession();
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-bash-cancel-"));
			dirs.push(dir);
			const marker = path.join(dir, "ran");
			const controller = new AbortController();
			abortAt(window, limiter, controller);

			const result = await executeBash(`printf ran > '${marker}'`, {
				signal: controller.signal,
				cpuSessionId: SESSION,
				sessionKey: SESSION,
			});

			expect(controller.signal.aborted).toBe(true);
			expect(result.cancelled).toBe(true);
			expect(result.exitCode).toBeUndefined();
			expect(existsSync(marker)).toBe(false);
		});
	}
});
