/**
 * A machine-wide resource limit bounds every veyyon on the host at once, and
 * says so when it cannot.
 *
 * WHY THIS SUITE EXISTS. A limit has two scopes now. `session.*` bounds one
 * session tree; `machine.*` bounds every session, every profile and every
 * veyyon running concurrently. The machine tier is not a second limiter — it
 * is a cgroup that the session groups are created INSIDE, so the kernel bounds
 * the subtree and the two tiers cannot disagree about arithmetic neither of
 * them does.
 *
 * That design has one failure mode that looks exactly like success, and it is
 * what most of this file is about: the machine cgroup can exist, carry the
 * right quota, and contain nothing. Session groups are the only things ever
 * placed inside it, and a session creates a group only when a limit is active.
 * Read "active" as the session limits alone and a machine-only configuration
 * writes the setting, creates the cgroup, applies the cap, and then runs every
 * command outside it. Nothing errors. `cpu.max` reads back correctly. The
 * limit bounds an empty set.
 *
 * THE CLASS, NOT THE INCIDENT. Every case that can enumerate its variants does
 * so from source at run time — `GLOBAL_RESOURCE_LIMITS` for the resources,
 * `SETTINGS_SCHEMA` for the settings pairs — so adding a fifth resource turns
 * this file red until someone decides what it means, rather than leaving a
 * hole shaped like the resource nobody thought about.
 *
 * WHAT IT DOES NOT CATCH. It drives a FAKE cgroup tree: ordinary files in a
 * temp directory with the names the kernel uses. That proves which files are
 * written, with what bytes, in what layout, and what happens when a write
 * fails — it cannot prove the kernel then throttles anything. Real enforcement
 * is `cpu-limit-real-cgroup.test.ts`, which is skipped off Linux. It also does
 * not cover Windows nested job objects, which do not exist here yet: the
 * machine tier reports itself unenforceable there, and that report is asserted.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { SessionCpuLimit } from "@veyyon/coding-agent/session/cpu-limit";
import { formatCpuMaxValue } from "@veyyon/kernel/session/cgroup-format";
import { probeCpuLimitSupport } from "@veyyon/kernel/session/cgroup-host";
import {
	addMachineHarnessWrite,
	anyMachineLimitActive,
	ensureMachineBudget,
	MACHINE_BUDGET_DIR_NAME,
	type MachineBudgetLimits,
	machineHarnessWrittenBytes,
	machineSpawnedWrittenBytes,
	machineWrittenBytes,
	resetMachineWriteTally,
} from "@veyyon/kernel/session/machine-budget";
import { GLOBAL_RESOURCE_LIMITS } from "@veyyon/utils/dirs";
import * as YAML from "yaml";
import { makeCgroupRoot, makeDelegatedParent, makeFakeHost, removeCgroupRoots } from "./helpers/fake-cgroup";

let root = "";
let parentDir = "";

/** Whether a schema key is declared on the Resources tab. */
function onResourcesTab(key: string): boolean {
	const entry = SETTINGS_SCHEMA[key as keyof typeof SETTINGS_SCHEMA] as { ui?: { tab?: string } };
	return entry.ui?.tab === "resources";
}

/** No limit at any scope: the shape every case starts from and edits one field of. */
function noLimits(): MachineBudgetLimits {
	return { cpuLimitCores: 0, memoryLimitGb: 0, writeBudgetGb: 0, maxProcesses: 0 };
}

/**
 * A delegated cgroup parent that advertises `controllers`. Plain files with the
 * kernel's names: `ensureMachineBudget` reads and writes exactly these, so the
 * fake is the interface rather than a stand-in for it.
 */
function delegatedParent(controllers: string[]): string {
	const dir = path.join(root, "parent");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "cgroup.controllers"), controllers.join(" "));
	fs.writeFileSync(path.join(dir, "cgroup.subtree_control"), "");
	return dir;
}

/**
 * A parent whose child directory already carries `cgroup.controllers`, which is
 * what makes the machine dir able to delegate downward in turn. The kernel
 * creates that file on mkdir; a fake has to place it when the directory
 * appears, so this pre-creates the machine dir the way the kernel would.
 */
function withMachineDirControllers(parent: string, controllers: string[]): string {
	const machineDir = path.join(parent, MACHINE_BUDGET_DIR_NAME);
	fs.mkdirSync(machineDir, { recursive: true });
	fs.writeFileSync(path.join(machineDir, "cgroup.controllers"), controllers.join(" "));
	fs.writeFileSync(path.join(machineDir, "cgroup.subtree_control"), "");
	return machineDir;
}

function read(file: string): string {
	return fs.readFileSync(file, "utf8");
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "vey-machine-budget-"));
	parentDir = delegatedParent(["cpu", "pids", "memory", "io"]);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("a machine limit is applied to a cgroup the session groups live inside", () => {
	it("places session groups inside the machine directory rather than beside them", async () => {
		withMachineDirControllers(parentDir, ["cpu", "pids", "memory"]);

		const placement = await ensureMachineBudget(
			{ platform: "linux", parentDir },
			{
				...noLimits(),
				cpuLimitCores: 4,
			},
		);

		// The nesting IS the enforcement. A placement that returns the delegated
		// parent puts every session group as a SIBLING of the machine group, and
		// a sibling is not bounded by it.
		expect(placement.parentDir).toBe(path.join(parentDir, MACHINE_BUDGET_DIR_NAME));
		expect(placement.machineDir).toBe(placement.parentDir);
	});

	it("writes the quota the kernel reads, not a number that merely looks right", async () => {
		withMachineDirControllers(parentDir, ["cpu", "pids", "memory"]);

		await ensureMachineBudget(
			{ platform: "linux", parentDir },
			{
				cpuLimitCores: 4,
				memoryLimitGb: 8,
				writeBudgetGb: 0,
				maxProcesses: 256,
			},
		);

		const dir = path.join(parentDir, MACHINE_BUDGET_DIR_NAME);
		// cpu.max is "<quota> <period>" in microseconds, and 4 cores over a
		// 100ms period is 400000. A bare "4" parses as 4 microseconds of CPU per
		// period, which is a cap of roughly nothing and would look like a hang.
		expect(read(path.join(dir, "cpu.max"))).toBe("400000 100000");
		expect(read(path.join(dir, "pids.max"))).toBe("256");
		// memory.max is BYTES. Writing gigabytes here caps the machine at 8 bytes.
		expect(read(path.join(dir, "memory.max"))).toBe(String(8 * 1024 ** 3));
	});

	it("delegates controllers one at a time, so an undelegated one cannot take cpu down with it", async () => {
		const limited = delegatedParent(["cpu", "pids"]);
		withMachineDirControllers(limited, ["cpu", "pids"]);
		// The bodies are the assertion, so they are captured rather than read
		// back: a plain file OVERWRITES where cgroup.subtree_control APPENDS, so
		// the file on disk shows only the last write and would hide a batch.
		const bodies: string[] = [];
		const writeFile = spyOn(fsPromises, "writeFile").mockImplementation(async (file, data) => {
			if (String(file).endsWith("cgroup.subtree_control")) bodies.push(String(data));
			return undefined;
		});

		const placement = await ensureMachineBudget(
			{ platform: "linux", parentDir: limited },
			{ ...noLimits(), cpuLimitCores: 2 },
		);

		writeFile.mockRestore();
		expect(placement.kernelHeld.cpu).toBe(true);
		// cgroup v2 rejects the WHOLE write when any controller in it cannot be
		// enabled, so "+cpu +pids +memory" on a host without memory delegates
		// NOTHING — cpu included. One controller per write is the only spelling
		// where a missing memory controller costs only the memory cap.
		expect(bodies).toEqual(["+cpu", "+pids"]);
		for (const body of bodies) expect(body.trim().split(/\s+/)).toHaveLength(1);
	});

	it("lifts a limit with the kernel's own word rather than a zero that means no CPU", async () => {
		withMachineDirControllers(parentDir, ["cpu", "pids", "memory"]);

		// 0 is "no limit" in the settings and "no CPU at all" in cpu.max. The
		// translation is the only thing standing between the two readings.
		expect(formatCpuMaxValue(0)).toBe("max 100000");
		expect(formatCpuMaxValue(1)).toBe("100000 100000");
	});

	it("never writes a zero quota for a positive budget, at any size", async () => {
		withMachineDirControllers(parentDir, ["cpu", "pids", "memory"]);

		// A zero quota is a freeze, so the one value a POSITIVE budget must never
		// produce is `0`. The machine tier once formatted cpu.max itself, by
		// truncation, and a budget below half a microsecond of the period came out
		// as `0 100000`: the tier meant to bound the machine would have stopped
		// every process on it. Both tiers now share one formatter, so this holds
		// for a session group as well as the machine group above it.
		for (const cores of [1e-9, 1e-6, 0.000004, 0.0000051, 0.5, 1, 3.7, 128]) {
			const [quota, period] = formatCpuMaxValue(cores).split(" ");
			expect(Number(quota), `cpu.max quota for ${cores} cores`).toBeGreaterThan(0);
			expect(period).toBe("100000");
		}

		// The machine group gets that same value, rather than one of its own.
		await ensureMachineBudget({ platform: "linux", parentDir }, { ...noLimits(), cpuLimitCores: 1e-9 });
		const [quota] = read(path.join(parentDir, MACHINE_BUDGET_DIR_NAME, "cpu.max")).split(" ");
		expect(Number(quota)).toBeGreaterThan(0);
	});

	it("writes a whole number to every countable control file, whatever the setting holds", async () => {
		withMachineDirControllers(parentDir, ["cpu", "pids", "memory"]);

		// pids.max and memory.max take a count, and reject a fraction outright:
		// a 0.3 GB budget is 322122547.2 bytes, which the kernel will not parse.
		// The setting is a number the operator typed, so the conversion is the
		// only thing keeping a fraction out of the file.
		await ensureMachineBudget(
			{ platform: "linux", parentDir },
			{ ...noLimits(), memoryLimitGb: 0.3, maxProcesses: 2.7 },
		);

		const dir = path.join(parentDir, MACHINE_BUDGET_DIR_NAME);
		for (const file of ["memory.max", "pids.max"]) {
			const body = read(path.join(dir, file)).trim();
			expect(body, `${file} body`).toMatch(/^\d+$/);
		}
		expect(read(path.join(dir, "memory.max")).trim()).toBe("322122547");
		expect(read(path.join(dir, "pids.max")).trim()).toBe("2");
	});
});

describe("a machine limit that nothing is holding says so", () => {
	it("reports every configured limit whose controller is missing, naming each one", async () => {
		const cpuOnly = delegatedParent(["cpu"]);
		withMachineDirControllers(cpuOnly, ["cpu"]);
		// Make the two control files unwritable by making them directories: the
		// write fails the way an undelegated controller fails, from this code's
		// point of view.
		fs.mkdirSync(path.join(cpuOnly, MACHINE_BUDGET_DIR_NAME, "pids.max"));
		fs.mkdirSync(path.join(cpuOnly, MACHINE_BUDGET_DIR_NAME, "memory.max"));

		const placement = await ensureMachineBudget(
			{ platform: "linux", parentDir: cpuOnly },
			{
				cpuLimitCores: 2,
				memoryLimitGb: 4,
				writeBudgetGb: 0,
				maxProcesses: 64,
			},
		);

		expect(placement.kernelHeld).toEqual({ cpu: true, pids: false, memory: false });
		// Naming the resource is the difference between an actionable notice and
		// a shrug: the controllers fail independently and the fix differs.
		expect(placement.unenforceable).toContain("machine.maxProcesses");
		expect(placement.unenforceable).toContain("machine.memoryLimitGb");
		expect(placement.unenforceable).not.toContain("machine.cpuLimitCores");
	});

	it("stays quiet when every configured limit is held", async () => {
		withMachineDirControllers(parentDir, ["cpu", "pids", "memory"]);

		const placement = await ensureMachineBudget(
			{ platform: "linux", parentDir },
			{
				...noLimits(),
				cpuLimitCores: 2,
			},
		);

		// A notice on every startup is a notice nobody reads by the third one.
		expect(placement.unenforceable).toBeUndefined();
	});

	it("keeps the per-session tier working when the machine tier cannot be built", async () => {
		// No cpu controller: the machine dir could not delegate cpu downward, so
		// a session group created inside it would have no cpu.max at all.
		const useless = delegatedParent(["memory"]);

		const placement = await ensureMachineBudget(
			{ platform: "linux", parentDir: useless },
			{
				...noLimits(),
				cpuLimitCores: 2,
			},
		);

		// Falling back to the delegated parent is the right trade: a machine cap
		// this host cannot hold must not also cost the session cap it can.
		expect(placement.parentDir).toBe(useless);
		expect(placement.machineDir).toBeUndefined();
		expect(placement.unenforceable).toContain("Per-session limits still apply");
	});

	it("reports a machine limit as unheld on a platform with no per-group quota", async () => {
		for (const platform of ["darwin", "win32", "freebsd"]) {
			const placement = await ensureMachineBudget(
				{ platform, parentDir },
				{
					...noLimits(),
					cpuLimitCores: 2,
				},
			);

			expect(placement.machineDir).toBeUndefined();
			expect(placement.parentDir).toBe(parentDir);
			expect(placement.unenforceable).toContain(platform);
		}
	});

	it("does nothing at all, and reports nothing, when no machine limit is set", async () => {
		const placement = await ensureMachineBudget({ platform: "linux", parentDir }, noLimits());

		expect(placement.parentDir).toBe(parentDir);
		expect(placement.machineDir).toBeUndefined();
		expect(placement.unenforceable).toBeUndefined();
		// A machine group for a machine with no machine limit is a directory
		// that outlives the process and bounds nothing.
		expect(fs.existsSync(path.join(parentDir, MACHINE_BUDGET_DIR_NAME))).toBe(false);
	});
});

describe("the machine group is shared by every veyyon rather than one per process", () => {
	it("adopts an existing machine directory instead of failing on it", async () => {
		withMachineDirControllers(parentDir, ["cpu", "pids", "memory"]);
		const first = await ensureMachineBudget({ platform: "linux", parentDir }, { ...noLimits(), cpuLimitCores: 2 });

		// A second veyyon, started later, running the identical code path. If
		// this throws or picks a different directory, the two instances get one
		// quota each and the machine gets both.
		const second = await ensureMachineBudget({ platform: "linux", parentDir }, { ...noLimits(), cpuLimitCores: 2 });

		expect(second.parentDir).toBe(first.parentDir);
		expect(second.machineDir).toBe(first.machineDir);
		expect(second.unenforceable).toBeUndefined();
	});

	it("names the directory from the host alone, never from a pid or a session", async () => {
		// The name is what makes two processes agree. Anything per-instance in it
		// gives each veyyon its own group, which is the bug this asserts against
		// and which no amount of correct quota-writing would show.
		expect(MACHINE_BUDGET_DIR_NAME).not.toMatch(/\d/);
		expect(MACHINE_BUDGET_DIR_NAME).toBe("veyyon.machine");
	});
});

describe("every resource is limited at both scopes", () => {
	/** Session limits, read from the schema so a new one cannot be forgotten. */
	const sessionLimitLeaves = Object.keys(SETTINGS_SCHEMA)
		// The Resources TAB is what defines a resource limit, so the list comes
		// from there rather than from the `session.` prefix, which also covers
		// the working directory and the instrumentation flag.
		.filter(key => key.startsWith("session.") && onResourcesTab(key))
		.map(key => key.slice("session.".length))
		// Policy toggles (`cpuLimitKill`) decide what happens AT a limit rather
		// than being one, and have no machine twin by design.
		.filter(leaf => !leaf.endsWith("Kill"));

	it("gives every session resource limit a machine twin", () => {
		const missing = sessionLimitLeaves.filter(leaf => !(`machine.${leaf}` in SETTINGS_SCHEMA));

		// Derived from the schema at run time: adding `session.gpuLimitCount`
		// with no `machine.gpuLimitCount` turns this red rather than leaving the
		// machine tier with a hole shaped like the newest resource.
		expect(missing, "each session limit has no machine-wide counterpart").toEqual([]);
	});

	it("gives every machine limit a session twin and a place in the enforcement list", () => {
		const machineLeaves = Object.keys(SETTINGS_SCHEMA)
			.filter(key => key.startsWith("machine."))
			.map(key => key.slice("machine.".length));

		expect([...machineLeaves].sort()).toEqual([...GLOBAL_RESOURCE_LIMITS].sort());
		const orphans = machineLeaves.filter(leaf => !(`session.${leaf}` in SETTINGS_SCHEMA));
		expect(orphans, "each machine limit has no per-session counterpart").toEqual([]);
	});

	it("defaults every limit at both scopes to no limit", () => {
		for (const leaf of GLOBAL_RESOURCE_LIMITS) {
			// A resource limit that defaults to a number is a limit nobody chose,
			// applied to a machine that was working before the upgrade.
			expect(SETTINGS_SCHEMA[`machine.${leaf}` as keyof typeof SETTINGS_SCHEMA].default).toBe(0);
			expect(SETTINGS_SCHEMA[`session.${leaf}` as keyof typeof SETTINGS_SCHEMA].default).toBe(0);
		}
	});

	it("treats each resource on its own when deciding whether a machine tier is needed", () => {
		expect(anyMachineLimitActive(noLimits())).toBe(false);
		for (const leaf of GLOBAL_RESOURCE_LIMITS) {
			// One resource at a time, from the source list: a predicate that
			// checked three of four would leave the fourth creating no group and
			// therefore bounding nothing.
			expect(anyMachineLimitActive({ ...noLimits(), [leaf]: 1 }), `${leaf} alone does not activate`).toBe(true);
		}
	});
});

describe("the machine write budget counts what no single session can see", () => {
	beforeEach(() => {
		resetMachineWriteTally();
	});

	afterEach(() => {
		resetMachineWriteTally();
	});

	it("reads the subtree total from the machine group, not from one session", async () => {
		const dir = withMachineDirControllers(parentDir, ["cpu", "io"]);
		// io.stat is per-device lines of key=value pairs; the budget is the sum
		// of wbytes across devices, because a machine writing to two disks is
		// writing twice as much and not half as much.
		fs.writeFileSync(
			path.join(dir, "io.stat"),
			"8:0 rbytes=1024 wbytes=2048 rios=1 wios=1\n253:0 rbytes=0 wbytes=1024 rios=0 wios=1\n",
		);

		expect(await machineSpawnedWrittenBytes(dir)).toBe(3072);
	});

	it("counts zero rather than throwing when io accounting is not delegated", async () => {
		const dir = withMachineDirControllers(parentDir, ["cpu"]);

		// A missing io.stat means the total is unknown, and an unknown total must
		// not refuse every write on a host that simply has no io controller.
		expect(await machineSpawnedWrittenBytes(dir)).toBe(0);
		expect(await machineSpawnedWrittenBytes(undefined)).toBe(0);
	});

	it("accumulates harness writes across instances instead of resetting with the process", () => {
		addMachineHarnessWrite(1000);
		addMachineHarnessWrite(2500);

		// The tally is a file, not a field. Two veyyon processes writing files at
		// the same time each hold the lock in turn, so neither total is lost —
		// an in-memory counter would give each instance its own budget.
		expect(machineHarnessWrittenBytes()).toBe(3500);
	});

	it("ignores a negative or non-finite byte count rather than corrupting the tally", () => {
		addMachineHarnessWrite(500);
		addMachineHarnessWrite(-100);
		addMachineHarnessWrite(Number.NaN);
		addMachineHarnessWrite(Number.POSITIVE_INFINITY);

		// A budget that can be lowered by writing is a budget that can be lifted
		// by writing, which is the opposite of what it is for.
		expect(machineHarnessWrittenBytes()).toBe(500);
	});

	it("charges the machine budget for both halves, since neither alone is the total", async () => {
		const dir = withMachineDirControllers(parentDir, ["cpu", "io"]);
		fs.writeFileSync(path.join(dir, "io.stat"), "8:0 wbytes=4096\n");
		addMachineHarnessWrite(1024);

		// The harness writes from the veyyon process, which is not a member of
		// the group it created, so io.stat will never see those bytes. Counting
		// only one half under-charges by whichever half is larger that day.
		expect(await machineWrittenBytes(dir)).toBe(5120);
	});
});

describe("a machine limit with no session limit still binds", () => {
	let configRoot = "";
	let previousConfigDir: string | undefined;

	/** Point the global config readers at a temp root holding `machine:` limits. */
	function machineConfig(limits: Partial<MachineBudgetLimits>): void {
		configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vey-machine-cfg-"));
		fs.writeFileSync(path.join(configRoot, "config.yml"), YAML.stringify({ machine: limits }));
		previousConfigDir = process.env.VEYYON_CONFIG_DIR;
		process.env.VEYYON_CONFIG_DIR = configRoot;
	}

	afterEach(async () => {
		if (previousConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
		else process.env.VEYYON_CONFIG_DIR = previousConfigDir;
		previousConfigDir = undefined;
		if (configRoot) fs.rmSync(configRoot, { recursive: true, force: true });
		configRoot = "";
		await removeCgroupRoots();
	});

	it("creates a session budget group even when every session limit is off", async () => {
		machineConfig({ cpuLimitCores: 2 });
		const cgroupRoot = await makeCgroupRoot();
		await makeDelegatedParent(cgroupRoot);
		const host = makeFakeHost(cgroupRoot);
		const created: string[] = [];

		const limiter = new SessionCpuLimit({
			sessionId: "machine-only",
			// Every session limit at its default. Before the machine tier existed
			// this was the "nothing to enforce" case and no group was made.
			cores: 0,
			kill: false,
			writeBudgetGb: 0,
			maxProcesses: 0,
			memoryLimitGb: 0,
			probe: await probeCpuLimitSupport(host.env),
			env: host.env,
			createGroup: spec => {
				created.push(spec.name);
				return {
					throttles: true,
					adopt: () => {},
					usageUsec: () => 0,
					throttledPeriods: () => 0,
					members: () => [],
					setCores: () => {},
					renice: () => {},
					dispose: () => {},
				};
			},
			windowSamples: 3,
			watchIntervalMs: 1_000,
		});

		await limiter.ensureGroup();

		// THE defect this whole tier can have. A machine cgroup bounds its
		// MEMBERS, and the only things ever placed in it are session groups. With
		// no session group, the setting is written, the cgroup exists, `cpu.max`
		// reads back correctly, every command runs outside it, and nothing
		// anywhere reports a problem.
		expect(created, "a machine limit alone created no session group to bound").toHaveLength(1);
		await limiter.dispose();
	});

	it("creates no group when neither scope sets a limit", async () => {
		machineConfig({});
		const cgroupRoot = await makeCgroupRoot();
		await makeDelegatedParent(cgroupRoot);
		const host = makeFakeHost(cgroupRoot);
		const created: string[] = [];

		const limiter = new SessionCpuLimit({
			sessionId: "no-limits",
			cores: 0,
			kill: false,
			writeBudgetGb: 0,
			maxProcesses: 0,
			memoryLimitGb: 0,
			probe: await probeCpuLimitSupport(host.env),
			env: host.env,
			createGroup: spec => {
				created.push(spec.name);
				throw new Error("unreachable");
			},
			windowSamples: 3,
			watchIntervalMs: 1_000,
		});

		await limiter.ensureGroup();

		// The other half of the same predicate: an unlimited session must not pay
		// for a cgroup, a watcher and a poll timer it has no use for.
		expect(created).toHaveLength(0);
		await limiter.dispose();
	});
});
