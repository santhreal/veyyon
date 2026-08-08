/**
 * The rest of the Resource Management tab: `session.maxProcesses`,
 * `session.memoryLimitGb`, and the per-backend question every limit has to
 * answer honestly, "can this host enforce it at all".
 *
 * Three classes are closed here rather than three incidents:
 *
 * 1. EVERY row on the resources tab is enforced. The membership is read out of
 *    `SETTINGS_SCHEMA` at run time, so adding a row without deciding how it is
 *    enforced turns this suite RED instead of shipping a dead knob.
 * 2. EVERY backend the probe can select has a recorded enforceability verdict,
 *    enumerated by probing every platform Node reports. A new backend, or a
 *    backend that quietly starts claiming a controller it does not have, turns
 *    this suite RED.
 * 3. A limit that cannot be enforced is REPORTED, once, and fails closed. The
 *    failure mode this guards against is the worst one available: a cap the
 *    operator set, the settings screen shows, and nothing applies.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getUi, SETTINGS_SCHEMA, type SettingPath } from "../src/config/settings-schema";
import {
	type CpuBudgetGroupHandle,
	CpuLimitDeniedError,
	type CpuLimitEnvironment,
	type CpuLimitProbe,
	initSessionCpuLimit,
	probeCpuLimitSupport,
	resetSessionCpuLimitsForTests,
	SessionCpuLimit,
	sessionCpuBudgetName,
} from "../src/session/cpu-limit";
import { BYTES_PER_GB } from "../src/session/write-accounting";
import {
	type FakeHost,
	makeCgroupRoot,
	makeDelegatedParent,
	makeFakeHost,
	removeCgroupRoots,
} from "./helpers/fake-cgroup";

const live: SessionCpuLimit[] = [];

afterEach(async () => {
	for (const limiter of live.splice(0)) await limiter.dispose();
	resetSessionCpuLimitsForTests();
	await removeCgroupRoots();
});

function stubGroup(getMembers: () => number[]): CpuBudgetGroupHandle {
	return {
		throttles: true,
		adopt: () => {},
		usageUsec: () => 0,
		throttledPeriods: () => 0,
		members: getMembers,
		setCores: () => {},
		renice: () => {},
		dispose: () => {},
	};
}

interface Fixture {
	host: FakeHost;
	limiter: SessionCpuLimit;
	notices: string[];
	cgroupDir: string;
	setMembers(pids: number[]): void;
}

/**
 * A limiter on a delegated cgroup tree. `delegated: false` withholds the
 * session's own directory, which is what a host that hands out `cpu` but not
 * `pids` or `memory` looks like from here: the controller files cannot be
 * written.
 */
async function makeFixture(options: {
	maxProcesses?: number;
	memoryLimitGb?: number;
	members?: number[];
	makeGroupDir?: boolean;
}): Promise<Fixture> {
	const root = await makeCgroupRoot();
	const parent = await makeDelegatedParent(root);
	const host = makeFakeHost(root);
	let members = options.members ?? [];
	const notices: string[] = [];
	const probe = await probeCpuLimitSupport(host.env);
	const limiter = new SessionCpuLimit({
		sessionId: "sess-limits",
		cores: 0,
		kill: false,
		maxProcesses: options.maxProcesses,
		memoryLimitGb: options.memoryLimitGb,
		probe,
		env: host.env,
		onNotice: text => notices.push(text),
		createGroup: () => stubGroup(() => members),
		watchIntervalMs: 1_000,
	});
	live.push(limiter);
	const cgroupDir = path.join(parent, sessionCpuBudgetName("sess-limits"));
	if (options.makeGroupDir !== false) await fs.mkdir(cgroupDir, { recursive: true });
	await limiter.ensureGroup();
	return { host, limiter, notices, cgroupDir, setMembers: pids => (members = pids) };
}

describe("session.maxProcesses", () => {
	it("writes the cap into pids.max, and lifts it when the cap is off", async () => {
		const fixture = await makeFixture({ maxProcesses: 4 });
		expect(await fs.readFile(path.join(fixture.cgroupDir, "pids.max"), "utf8")).toBe("4");

		await fixture.limiter.updateLimits({ maxProcesses: 0 });
		expect(await fs.readFile(path.join(fixture.cgroupDir, "pids.max"), "utf8")).toBe("max");
	});

	it("refuses a spawn at the cap and allows one below it, naming the cap and the live count", async () => {
		const fixture = await makeFixture({ maxProcesses: 2, members: [11] });
		fixture.limiter.assertMaySpawn("a bash command");

		fixture.setMembers([11, 22]);
		try {
			fixture.limiter.assertMaySpawn("a bash command");
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(CpuLimitDeniedError);
			const text = (error as Error).message;
			expect(text).toContain("process cap of 2 is reached");
			expect(text).toContain("2 live process(es)");
			expect(text).toContain("session.maxProcesses");
		}

		// The kernel cap is the backstop, not the notice: veyyon still refuses in
		// policy so the operator learns WHICH budget stopped the command, rather
		// than reading a fork failure.
		fixture.setMembers([11]);
		fixture.limiter.assertMaySpawn("a bash command");
	});

	it("never refuses while the cap is off, whatever the group holds", async () => {
		const fixture = await makeFixture({ maxProcesses: 0, members: [1, 2, 3, 4, 5, 6, 7, 8] });
		fixture.limiter.assertMaySpawn("a bash command");
	});

	it("says once that the kernel will not cap forks when pids is not delegated", async () => {
		const fixture = await makeFixture({ maxProcesses: 2, makeGroupDir: false, members: [11] });
		// Repeated attempts, and settings changes to OTHER limits, must not
		// repeat the notice: an unenforceable limit narrating every command is
		// how an operator learns to ignore it.
		for (let attempt = 0; attempt < 3; attempt++) {
			await fixture.limiter.pollOnce();
			await fixture.limiter.updateLimits({ writeBudgetGb: attempt + 1 });
		}

		const warnings = fixture.notices.filter(text => text.includes("session.maxProcesses is set to"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("session.maxProcesses is set to 2");
		expect(warnings[0]).toContain("refuses to START a new");

		// Changing the cap ITSELF is a new fact, so it is reported again, with
		// the new value.
		await fixture.limiter.updateLimits({ maxProcesses: 5 });
		const afterChange = fixture.notices.filter(text => text.includes("session.maxProcesses is set to"));
		expect(afterChange).toHaveLength(2);
		expect(afterChange[1]).toContain("session.maxProcesses is set to 5");

		// Degraded, not disabled: the policy refusal still holds, and it is the
		// process cap doing the refusing rather than some other limit.
		fixture.setMembers([11, 22, 33, 44, 55]);
		expect(() => fixture.limiter.assertMaySpawn("a bash command")).toThrow(
			/process cap of 5 is reached \(5 live process\(es\)/,
		);
	});
});

describe("session.memoryLimitGb", () => {
	it("writes the cap into memory.max in bytes, and lifts it when the cap is off", async () => {
		const fixture = await makeFixture({ memoryLimitGb: 2 });
		expect(await fs.readFile(path.join(fixture.cgroupDir, "memory.max"), "utf8")).toBe(String(2 * BYTES_PER_GB));

		await fixture.limiter.updateLimits({ memoryLimitGb: 0 });
		expect(await fs.readFile(path.join(fixture.cgroupDir, "memory.max"), "utf8")).toBe("max");
	});

	it("does not refuse spawns while the kernel holds the cap", async () => {
		const fixture = await makeFixture({ memoryLimitGb: 2, members: [11] });
		// The kernel reclaims and, at the wall, OOM-kills inside the group. That
		// IS the enforcement, so there is nothing to refuse.
		fixture.limiter.assertMaySpawn("a bash command");
	});

	it("fails closed when memory.max cannot be written, and says so once", async () => {
		const fixture = await makeFixture({ memoryLimitGb: 2, makeGroupDir: false });
		// An unrelated limit changing must not re-narrate this one.
		await fixture.limiter.updateLimits({ maxProcesses: 3 });
		await fixture.limiter.pollOnce();

		const warnings = fixture.notices.filter(text => text.includes("session.memoryLimitGb is set to 2"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("cannot be enforced");
		expect(warnings[0]).toContain("refused rather than run unbounded");

		try {
			fixture.limiter.assertMaySpawn("a bash command");
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(CpuLimitDeniedError);
			const text = (error as Error).message;
			expect(text).toContain("session.memoryLimitGb is set to 2");
			expect(text).toContain("would be unbounded");
		}

		// Lifting the limit lifts the refusal: an unenforceable cap is not a
		// permanently poisoned session.
		await fixture.limiter.updateLimits({ memoryLimitGb: 0 });
		fixture.limiter.assertMaySpawn("a bash command");
	});

	it("warns at session start, before any group exists, when the controller is absent", async () => {
		const root = await makeCgroupRoot(); // no delegated parent: nothing is available
		const host = makeFakeHost(root);
		const notices: string[] = [];
		const limiter = await initSessionCpuLimit({
			sessionId: "sess-memory-start",
			cores: 0,
			kill: false,
			memoryLimitGb: 4,
			onNotice: text => notices.push(text),
			env: host.env,
		});
		live.push(limiter);

		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("session.memoryLimitGb is set to 4");
		expect(notices[0]).toContain("cannot be enforced");
	});
});

describe("every limit is off at its default", () => {
	it("creates no group and refuses nothing when every limit is 0", async () => {
		const fixture = await makeFixture({ maxProcesses: 0, memoryLimitGb: 0, members: [1, 2, 3] });

		// `ensureGroup` already ran in the fixture: with no limit active it must
		// have declined to create anything, so no controller file was written.
		expect(await fs.readdir(fixture.cgroupDir)).toEqual([]);
		fixture.limiter.assertMaySpawn("a bash command");
		fixture.limiter.assertMayWrite(64 * BYTES_PER_GB, "/tmp/huge");
		expect(fixture.limiter.writtenBytes).toBe(0);
	});
});

/**
 * Every platform `process.platform` can report. The probe's whole job is to
 * answer for the host it is on, so the enumeration is the platform domain
 * rather than the handful of platforms someone remembered.
 */
const NODE_PLATFORMS = [
	"aix",
	"android",
	"cygwin",
	"darwin",
	"freebsd",
	"haiku",
	"linux",
	"netbsd",
	"openbsd",
	"sunos",
	"win32",
] as const;

/**
 * What each backend is expected to hold in the KERNEL. Anything false here is
 * enforced as policy (refuse the spawn, name the budget) or reported
 * unenforceable; nothing is pretended.
 */
const BACKEND_ENFORCEMENT: Record<string, { cpu: boolean; pids: boolean; memory: boolean }> = {
	direct: { cpu: true, pids: true, memory: true },
	"job-object": { cpu: true, pids: false, memory: false },
	tracked: { cpu: false, pids: false, memory: false },
	unsupported: { cpu: false, pids: false, memory: false },
};

describe("every backend has a recorded enforceability verdict", () => {
	it("probes every platform Node can report and finds a decision for each backend", async () => {
		const root = await makeCgroupRoot();
		await makeDelegatedParent(root);
		const base = makeFakeHost(root).env;
		const seen = new Map<string, CpuLimitProbe>();
		for (const platform of NODE_PLATFORMS) {
			const env: CpuLimitEnvironment = { ...base, platform };
			const probe = await probeCpuLimitSupport(env);
			const kind = probe.backend?.kind ?? "unsupported";
			expect(BACKEND_ENFORCEMENT[kind]).toBeDefined();
			expect(probe.kernelLimits).toEqual(BACKEND_ENFORCEMENT[kind]);
			seen.set(kind, probe);
		}
		// The three real backends must all be reachable from the platform list,
		// or the matrix above is describing code no platform runs.
		expect([...seen.keys()].sort()).toEqual(["direct", "job-object", "tracked", "unsupported"]);
	});

	it("reports a controller as unavailable when the delegated parent does not offer it", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-cpu-only-"));
		await fs.writeFile(path.join(root, "cgroup.controllers"), "cpu\n");
		const parent = path.join(root, "user.slice", "user-1000.slice", "user@1000.service", "app.slice");
		await fs.mkdir(parent, { recursive: true });
		// `cpu` alone: the parent can host a CPU quota and nothing else.
		await fs.writeFile(path.join(parent, "cgroup.controllers"), "cpu\n");
		await fs.writeFile(path.join(parent, "cgroup.subtree_control"), "");
		const host = makeFakeHost(root);

		const probe = await probeCpuLimitSupport(host.env);

		expect(probe.backend?.kind).toBe("direct");
		expect(probe.kernelLimits).toEqual({ cpu: true, pids: false, memory: false });
		await fs.rm(root, { recursive: true, force: true });
	});
});

/**
 * The resources tab is the operator-visible contract: one place holding every
 * limit on what a session may consume. A row that reaches the screen without
 * reaching enforcement is the defect this closes.
 */
const RESOURCE_ROW_ENFORCEMENT: Record<string, string> = {
	"session.cpuLimitCores": "cgroup cpu.max / Job Object CPU rate, plus a saturation refusal",
	"session.cpuLimitKill": "SIGTERM to the saturated group, reported as a budget action",
	"session.memoryLimitGb": "cgroup memory.max, refusing spawns where it cannot be written",
	"session.writeBudgetGb": "io.stat or /proc/<pid>/io plus harness tool bytes, refusing writes and spawns",
	"session.writeBudgetKill": "SIGTERM to the over-budget group, reported as a budget action",
	"session.maxProcesses": "cgroup pids.max, plus a refusal at the cap",
};

describe("the resources tab", () => {
	it("has an enforcement decision recorded for every row it shows", () => {
		const rows = Object.keys(SETTINGS_SCHEMA)
			.filter(key => getUi(key as SettingPath)?.tab === "resources")
			.sort();

		expect(rows.length).toBeGreaterThan(0);
		expect(rows).toEqual(Object.keys(RESOURCE_ROW_ENFORCEMENT).sort());
	});
});
