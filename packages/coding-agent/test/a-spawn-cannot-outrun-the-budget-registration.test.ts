/**
 * A command must never start before the budget that is supposed to bound it is
 * findable.
 *
 * ## The defect class this closes
 *
 * Spawn sites resolve the limiter by session id through `sessionCpuLimit(id)`.
 * `AgentSession` starts the registration with `void initSessionCpuLimit(...)`
 * and does not await it, so everything between the call and `limiters.set`
 * is a window in which a tool call finds no limiter and runs the command
 * outside every budget — silently, because "no limiter" is also what an
 * unconfigured host looks like. Any `await` added ahead of the registration
 * reopens that window; one added to resolve the cgroup environment did.
 *
 * The second half of the class is the id itself. A spawn site that resolves
 * the limiter under a key that is not the session id gets the same silent
 * miss. The async bash path builds a per-JOB shell key (`<id>:async:<jobId>`)
 * so a background command gets its own brush session, and passing that key as
 * the budget id put every background command outside the budget.
 *
 * ## What it does not catch
 *
 * A spawn site that never asks for a limiter at all. That is
 * cpu-limit-spawn-sites.test.ts, which sweeps the sites.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { executeBash } from "@veyyon/coding-agent/exec/bash-executor";
import {
	initSessionCpuLimit,
	resetSessionCpuLimitsForTests,
	resolveCpuLimitEnvironment,
	sessionCpuLimit,
} from "@veyyon/coding-agent/session/cpu-limit";
import { makeCgroupRoot, makeDelegatedParent, makeFakeHost, removeCgroupRoots } from "./helpers/fake-cgroup";

type CpuLimitEnv = Parameters<typeof initSessionCpuLimit>[0]["env"];

/** A session with a CPU limit set, so a spawn has a group worth creating. */
async function register(sessionId: string, env: CpuLimitEnv): Promise<void> {
	await initSessionCpuLimit({ sessionId, cores: 1, kill: false, onNotice: () => {}, env });
}

afterEach(async () => {
	for (const sessionId of ["sync-registration", "async-bash-session", "async-bash-miss"]) {
		await sessionCpuLimit(sessionId)?.dispose();
	}
	resetSessionCpuLimitsForTests();
	await removeCgroupRoots();
});

describe("registering a session budget", () => {
	it("is findable in the same tick the session asks for it, before any await resolves", () => {
		const sessionId = "sync-registration";
		// Exactly how AgentSession calls it: launched, never awaited.
		void initSessionCpuLimit({ sessionId, cores: 0, kill: false, onNotice: () => {} });

		expect(sessionCpuLimit(sessionId)).toBeDefined();
	});

	it("resolves the production environment without yielding", () => {
		const env = resolveCpuLimitEnvironment();
		expect(env.platform).toBe(process.platform);
		expect(typeof env.ownCgroupPath).toBe("string");
	});
});

describe("a background bash job", () => {
	it("joins the session budget even though its shell session key is per job", async () => {
		const root = await makeCgroupRoot();
		const delegated = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const sessionId = "async-bash-session";
		await register(sessionId, host.env);
		const limiter = sessionCpuLimit(sessionId);
		expect(limiter).toBeDefined();
		if (!limiter) return;

		// The key the async path builds. It is deliberately NOT the session id:
		// a background job needs its own brush session.
		await executeBash("true", { sessionKey: `${sessionId}:async:7`, cpuSessionId: sessionId });

		// The group is the observable: it exists only because a spawn asked the
		// limiter for one, which is the step a mismatched key skips.
		expect(limiter.budgetName).toBe(`veyyon-cpu-${sessionId}`);
		expect(existsSync(path.join(delegated, limiter.budgetName))).toBe(true);
	});

	it("creates no group at all when the budget id is the per-job key", async () => {
		const root = await makeCgroupRoot();
		const delegated = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const sessionId = "async-bash-miss";
		await register(sessionId, host.env);
		const limiter = sessionCpuLimit(sessionId);
		expect(limiter).toBeDefined();
		if (!limiter) return;

		await executeBash("true", { sessionKey: `${sessionId}:async:7` });

		expect(existsSync(path.join(delegated, limiter.budgetName))).toBe(false);
	});
});
