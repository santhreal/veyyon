/**
 * The session tree's disk-write budget: `session.writeBudgetGb` and
 * `session.writeBudgetKill`.
 *
 * The budget is cumulative over the whole tree and has two halves that no
 * single mechanism can see at once. Spawned processes write through the
 * kernel, so their bytes come from the budget group's `io.stat` where the `io`
 * controller is delegated and from `/proc/<pid>/io` where it is not. veyyon's
 * own write and edit tools run IN the harness process, which is deliberately
 * never a member of its own group, so their bytes are counted at the one
 * callback both tools commit through. These tests drive both halves, their
 * sum, the refusal, and the opt-in kill, against a tmpdir cgroup tree and a
 * tmpdir procfs.
 *
 * What they do NOT prove: that the kernel's `io.stat` numbers are accurate, or
 * that a real SIGTERM lands. Those are the kernel's contract and the OS's, not
 * this module's.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	budgetedFileCommit,
	type CpuBudgetGroupHandle,
	CpuLimitDeniedError,
	initSessionCpuLimit,
	probeCpuLimitSupport,
	resetSessionCpuLimitsForTests,
	SessionCpuLimit,
	sessionCpuBudgetName,
	WriteBudgetDeniedError,
} from "../src/session/cpu-limit";
import { BYTES_PER_GB } from "../src/session/write-accounting";
import {
	type FakeHost,
	makeCgroupRoot,
	makeDelegatedParent,
	makeFakeHost,
	removeCgroupRoots,
} from "./helpers/fake-cgroup";

const MIB = 1024 * 1024;

/** Limiters created by a test, disposed after it so no watcher survives the file. */
const live: SessionCpuLimit[] = [];
/** Fake procfs roots, removed after each test. */
const procRoots: string[] = [];

afterEach(async () => {
	for (const limiter of live.splice(0)) await limiter.dispose();
	resetSessionCpuLimitsForTests();
	for (const root of procRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
	await removeCgroupRoots();
});

/** A group handle whose member list the test drives; usage never moves, so CPU never denies. */
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
	/** The group's own cgroup directory, where `io.stat` is read from. */
	cgroupDir: string;
	setMembers(pids: number[]): void;
}

async function makeFixture(options: {
	writeBudgetGb: number;
	writeBudgetKill?: boolean;
	members?: number[];
	procRoot?: string;
}): Promise<Fixture> {
	const root = await makeCgroupRoot();
	const parent = await makeDelegatedParent(root);
	const host = makeFakeHost(root);
	if (options.procRoot) host.env = { ...host.env, procRoot: options.procRoot };
	let members = options.members ?? [];
	const notices: string[] = [];
	const probe = await probeCpuLimitSupport(host.env);
	const limiter = new SessionCpuLimit({
		sessionId: "sess-write",
		cores: 0,
		kill: false,
		writeBudgetGb: options.writeBudgetGb,
		writeBudgetKill: options.writeBudgetKill ?? false,
		probe,
		env: host.env,
		onNotice: text => notices.push(text),
		createGroup: () => stubGroup(() => members),
		watchIntervalMs: 1_000,
	});
	live.push(limiter);
	const cgroupDir = path.join(parent, sessionCpuBudgetName("sess-write"));
	await fs.mkdir(cgroupDir, { recursive: true });
	await limiter.ensureGroup();
	return {
		host,
		limiter,
		notices,
		cgroupDir,
		setMembers: pids => {
			members = pids;
		},
	};
}

/** A tmpdir standing in for `/proc`, with a readable `self/io` so the source is not `none`. */
async function makeProcRoot(entries: Record<number, number>): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-write-budget-proc-"));
	procRoots.push(root);
	await fs.mkdir(path.join(root, "self"), { recursive: true });
	await fs.writeFile(path.join(root, "self", "io"), "write_bytes: 0\n");
	for (const [pid, bytes] of Object.entries(entries)) {
		await fs.mkdir(path.join(root, pid), { recursive: true });
		await fs.writeFile(path.join(root, pid, "io"), `rchar: 10\nwchar: 99999999\nwrite_bytes: ${bytes}\n`);
	}
	return root;
}

describe("the spawned half of the write budget", () => {
	it("meters from io.stat when the io controller reports, and treats it as cumulative", async () => {
		const fixture = await makeFixture({ writeBudgetGb: 4, members: [11] });
		await fs.writeFile(path.join(fixture.cgroupDir, "io.stat"), `259:0 rbytes=512 wbytes=${2 * BYTES_PER_GB}\n`);

		await fixture.limiter.pollOnce();
		expect(fixture.limiter.writeSource).toBe("io.stat");
		expect(fixture.limiter.writtenBytes).toBe(2 * BYTES_PER_GB);

		// The kernel counter is a running total, so a second identical reading is
		// the same two gigabytes, not four.
		await fixture.limiter.pollOnce();
		expect(fixture.limiter.writtenBytes).toBe(2 * BYTES_PER_GB);
	});

	it("sums io.stat across every backing device", async () => {
		const fixture = await makeFixture({ writeBudgetGb: 4, members: [11] });
		await fs.writeFile(
			path.join(fixture.cgroupDir, "io.stat"),
			`259:0 rbytes=1 wbytes=${MIB}\n253:1 rbytes=2 wbytes=${3 * MIB}\n`,
		);

		await fixture.limiter.pollOnce();
		expect(fixture.limiter.writtenBytes).toBe(4 * MIB);
	});

	it("falls back to /proc/<pid>/io when the io controller is not delegated", async () => {
		const procRoot = await makeProcRoot({ 111: 3 * MIB, 222: 5 * MIB });
		const fixture = await makeFixture({ writeBudgetGb: 4, members: [111, 222], procRoot });

		await fixture.limiter.pollOnce();
		expect(fixture.limiter.writeSource).toBe("proc-io");
		expect(fixture.limiter.writtenBytes).toBe(8 * MIB);
	});

	it("keeps the bytes a finished command wrote after its /proc entry disappears", async () => {
		const procRoot = await makeProcRoot({ 111: 3 * MIB, 222: 5 * MIB });
		const fixture = await makeFixture({ writeBudgetGb: 4, members: [111, 222], procRoot });
		await fixture.limiter.pollOnce();

		// 111 exits: its /proc entry is gone and it is no longer a member. A
		// budget that forgot its bytes could be spent without limit by short
		// commands.
		await fs.rm(path.join(procRoot, "111"), { recursive: true, force: true });
		fixture.setMembers([222]);
		await fixture.limiter.pollOnce();

		expect(fixture.limiter.writtenBytes).toBe(8 * MIB);
	});

	it("reports the spawned half as unmeterable once when neither source exists", async () => {
		// The fake host's procRoot does not exist and no io.stat was written.
		const fixture = await makeFixture({ writeBudgetGb: 1, members: [11] });

		await fixture.limiter.pollOnce();
		// Neither another poll nor an unrelated limit change may re-narrate it.
		await fixture.limiter.updateLimits({ maxProcesses: 4 });
		await fixture.limiter.pollOnce();

		const unmeterable = fixture.notices.filter(text => text.includes("cannot be metered"));
		expect(unmeterable).toHaveLength(1);
		expect(unmeterable[0]).toContain("session.writeBudgetGb is set to 1");
		expect(unmeterable[0]).toContain("io.stat");
		expect(unmeterable[0]).toContain("/proc/<pid>/io");
		expect(fixture.limiter.writeSource).toBe("none");

		// Changing the budget itself is a new fact, and the report names it.
		await fixture.limiter.updateLimits({ writeBudgetGb: 3 });
		await fixture.limiter.pollOnce();
		const reported = fixture.notices.filter(text => text.includes("cannot be metered"));
		expect(reported).toHaveLength(2);
		expect(reported[1]).toContain("session.writeBudgetGb is set to 3");
	});
});

describe("the budget is the sum of both halves", () => {
	it("adds the harness tools' bytes to the group's", async () => {
		const fixture = await makeFixture({ writeBudgetGb: 8, members: [11] });
		await fs.writeFile(path.join(fixture.cgroupDir, "io.stat"), `259:0 wbytes=${2 * BYTES_PER_GB}\n`);
		await fixture.limiter.pollOnce();

		fixture.limiter.recordHarnessWrite(BYTES_PER_GB);

		expect(fixture.limiter.writtenBytes).toBe(3 * BYTES_PER_GB);
	});

	it("refuses a new spawn once the tree's budget is spent, naming the budget and the amount", async () => {
		const fixture = await makeFixture({ writeBudgetGb: 2, members: [11] });
		fixture.limiter.assertMaySpawn("a bash command");

		await fs.writeFile(path.join(fixture.cgroupDir, "io.stat"), `259:0 wbytes=${3 * BYTES_PER_GB}\n`);
		await fixture.limiter.pollOnce();

		expect(() => fixture.limiter.assertMaySpawn("a bash command")).toThrow(CpuLimitDeniedError);
		try {
			fixture.limiter.assertMaySpawn("a bash command");
			throw new Error("expected a refusal");
		} catch (error) {
			const text = (error as Error).message;
			expect(text).toContain("Refused to start a bash command");
			expect(text).toContain("write budget of 2 GB is spent");
			expect(text).toContain("3.00 GB written");
			expect(text).toContain("session.writeBudgetGb");
		}
	});

	it("reports a spent budget once rather than once per poll", async () => {
		const fixture = await makeFixture({ writeBudgetGb: 1, members: [11] });
		await fs.writeFile(path.join(fixture.cgroupDir, "io.stat"), `259:0 wbytes=${2 * BYTES_PER_GB}\n`);

		for (let tick = 0; tick < 3; tick++) await fixture.limiter.pollOnce();

		const exceeded = fixture.notices.filter(text => text.includes("Session write budget exceeded"));
		expect(exceeded).toHaveLength(1);
		expect(exceeded[0]).toContain("limit 1 GB");
		expect(exceeded[0]).toContain("Further writes and new commands are refused");
	});
});

describe("session.writeBudgetKill", () => {
	it("leaves running commands alone while off", async () => {
		const fixture = await makeFixture({ writeBudgetGb: 1, members: [11, 22] });
		await fs.writeFile(path.join(fixture.cgroupDir, "io.stat"), `259:0 wbytes=${2 * BYTES_PER_GB}\n`);

		for (let tick = 0; tick < 3; tick++) await fixture.limiter.pollOnce();

		expect(fixture.host.killed).toEqual([]);
		expect(fixture.limiter.consumeKillReport()).toBeUndefined();
	});

	it("SIGTERMs the over-budget group once and reports it as a budget action", async () => {
		const fixture = await makeFixture({ writeBudgetGb: 1, writeBudgetKill: true, members: [11, 22] });
		await fs.writeFile(path.join(fixture.cgroupDir, "io.stat"), `259:0 wbytes=${2 * BYTES_PER_GB}\n`);

		await fixture.limiter.pollOnce();
		await fixture.limiter.pollOnce();

		expect(fixture.host.killed).toEqual([
			{ pid: 11, signal: "SIGTERM" },
			{ pid: 22, signal: "SIGTERM" },
		]);
		const report = fixture.limiter.consumeKillReport();
		expect(report).toContain("Session write budget exceeded");
		expect(report).toContain("session.writeBudgetKill is on");
		expect(report).toContain("not a crash");
		// Consumed once: a second command must not inherit the first one's report.
		expect(fixture.limiter.consumeKillReport()).toBeUndefined();
	});
});

describe("the harness's own tools are charged and gated", () => {
	async function registerLimiter(writeBudgetGb: number): Promise<SessionCpuLimit> {
		const root = await makeCgroupRoot();
		const host = makeFakeHost(root);
		const limiter = await initSessionCpuLimit({
			sessionId: "sess-tools",
			cores: 0,
			kill: false,
			writeBudgetGb,
			onNotice: () => {},
			env: host.env,
		});
		live.push(limiter);
		return limiter;
	}

	it("counts a committed write and refuses the one that would cross the budget", async () => {
		const limiter = await registerLimiter(1 / 1024);
		const committed: string[] = [];
		const commit = budgetedFileCommit(
			{ sessionId: () => "sess-tools", limits: () => ({ writeBudgetGb: 1 / 1024 }) },
			async (dst: string) => {
				committed.push(dst);
			},
		);

		await commit("/tmp/a.txt", "x".repeat(700 * 1024));
		expect(limiter.writtenBytes).toBe(700 * 1024);

		// 700 KiB more would land at 1400 KiB against a 1 MiB budget. Refused
		// BEFORE the write, so one oversized write cannot blow through the wall.
		await expect(commit("/tmp/b.txt", "x".repeat(700 * 1024))).rejects.toThrow(WriteBudgetDeniedError);
		expect(committed).toEqual(["/tmp/a.txt"]);
		expect(limiter.writtenBytes).toBe(700 * 1024);

		// A write that still FITS is allowed: the budget gates per write, it does
		// not latch shut on the first refusal.
		await commit("/tmp/c.txt", "x".repeat(100 * 1024));
		expect(committed).toEqual(["/tmp/a.txt", "/tmp/c.txt"]);
		expect(limiter.writtenBytes).toBe(800 * 1024);
	});

	it("charges nothing for a write that failed", async () => {
		const limiter = await registerLimiter(1);
		const commit = budgetedFileCommit(
			{ sessionId: () => "sess-tools", limits: () => ({ writeBudgetGb: 1 }) },
			async () => {
				throw new Error("disk full");
			},
		);

		await expect(commit("/tmp/a.txt", "x".repeat(4096))).rejects.toThrow("disk full");
		expect(limiter.writtenBytes).toBe(0);
	});

	it("names the file and both sizes when it refuses", async () => {
		const limiter = await registerLimiter(1 / 1024);
		limiter.recordHarnessWrite(MIB);

		expect(() => limiter.assertMayWrite(4096, "/tmp/report.md")).toThrow(WriteBudgetDeniedError);
		try {
			limiter.assertMayWrite(4096, "/tmp/report.md");
			throw new Error("expected a refusal");
		} catch (error) {
			const text = (error as Error).message;
			expect(text).toContain("/tmp/report.md");
			expect(text).toContain("1.0 MB already written");
			expect(text).toContain("session.writeBudgetGb");
		}
	});

	it("charges and gates nothing at all while the budget is off", async () => {
		const limiter = await registerLimiter(0);
		const commit = budgetedFileCommit(
			{ sessionId: () => "sess-tools", limits: () => ({ writeBudgetGb: 0 }) },
			async () => {},
		);

		await commit("/tmp/a.txt", "x".repeat(64 * MIB));

		expect(limiter.writtenBytes).toBe(0);
		limiter.assertMaySpawn("a bash command");
		limiter.assertMayWrite(64 * MIB, "/tmp/b.txt");
	});
});

describe("changing the budget mid-session", () => {
	it("un-refuses when the operator raises it", async () => {
		const fixture = await makeFixture({ writeBudgetGb: 1, members: [11] });
		await fs.writeFile(path.join(fixture.cgroupDir, "io.stat"), `259:0 wbytes=${2 * BYTES_PER_GB}\n`);
		await fixture.limiter.pollOnce();
		expect(() => fixture.limiter.assertMaySpawn("a bash command")).toThrow(CpuLimitDeniedError);

		await fixture.limiter.updateLimits({ writeBudgetGb: 8 });

		fixture.limiter.assertMaySpawn("a bash command");
	});

	it("keeps the cumulative total when the budget is switched off and on again", async () => {
		const fixture = await makeFixture({ writeBudgetGb: 8, members: [11] });
		await fs.writeFile(path.join(fixture.cgroupDir, "io.stat"), `259:0 wbytes=${2 * BYTES_PER_GB}\n`);
		await fixture.limiter.pollOnce();
		expect(fixture.limiter.writtenBytes).toBe(2 * BYTES_PER_GB);

		await fixture.limiter.updateLimits({ writeBudgetGb: 0 });
		await fixture.limiter.updateLimits({ writeBudgetGb: 1 });

		// Cumulative means cumulative: toggling the setting is not a way to
		// clear what the tree has already written.
		expect(fixture.limiter.writtenBytes).toBe(2 * BYTES_PER_GB);
		expect(() => fixture.limiter.assertMaySpawn("a bash command")).toThrow(CpuLimitDeniedError);
	});
});
