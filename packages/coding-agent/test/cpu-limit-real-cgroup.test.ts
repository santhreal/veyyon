/**
 * Real-cgroup enforcement proof for the session CPU budget.
 *
 * ## The bug this locks out
 *
 * Everything else in the CPU-budget suite runs against a tmpdir standing in for
 * `/sys/fs/cgroup`. A tmpdir accepts every byte the backend writes and enforces
 * none of them, so the whole suite stays green in a world where `cpu.max` is
 * written with the wrong quota, written to the wrong file, written to a cgroup
 * whose parent never delegated `cpu`, or written to a directory that is not a
 * cgroup at all. In that world the budget is a settings row and a log line, and
 * every process runs at full speed. This file is the only thing standing
 * between that world and a green build.
 *
 * ## Why the assertions are absolute and not ratios
 *
 * The first version compared a capped burner against an uncapped twin and
 * asserted the capped one used less than 75% and more than 25% of the twin. A
 * quota half the size of the demand should produce 50%, so the band admitted
 * everything from a 25% error to a 50% error in the enforced rate, and it never
 * looked at the quota it claimed to be testing. A cap of 0.9 cores instead of
 * 0.5, an off-by-ten period, or a group that throttled for an unrelated reason
 * all passed. The assertions below name the configured cap, the measured
 * microseconds, and the tolerance, so a wrong quota is a wrong number rather
 * than a ratio still inside a wide band.
 *
 * ## What is measured
 *
 * A single-threaded burner runs for a fixed WALL window and reports the CPU it
 * consumed. Its group's `cpu.stat` is read before and after, so the kernel's
 * own accounting for the group is compared against the child's accounting for
 * itself: two independent meters that must agree, which is what proves the pid
 * that was adopted is the pid being metered.
 *
 * Skips, with the reason stated, when the host has no cgroup v2 delegation, and
 * on non-Linux where the budget is not a kernel throttle at all.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import { CGROUP_CPU_PERIOD_USEC } from "../src/session/cgroup-format";
import {
	type CpuBudgetGroupHandle,
	probeCpuLimitSupport,
	resolveCpuLimitEnvironment,
	SessionCpuLimit,
} from "../src/session/cpu-limit";
import { resetMachineWriteTally } from "../src/session/machine-budget";
import { hermeticSpawnEnv } from "./helpers/hermetic-spawn-env";

/**
 * Report that the kernel assertions below could not run, and decide whether
 * that is acceptable.
 *
 * A skip printed beside "4 pass" reads as a proof that ran. It is not one, and
 * the ordinary place this suite executes cannot run it at all: the test sandbox
 * mounts `/sys/fs/cgroup` read-only and answers no systemd user bus, so every
 * kernel assertion here skipped while the file reported green. Somewhere has to
 * fail instead, and that somewhere sets VEYYON_REQUIRE_CGROUP_PROOF=1 — a host
 * with real cgroup v2 delegation, which is what `bun run test:cgroup-proof`
 * runs on.
 */
function cannotProve(reason: string): void {
	if (process.env.VEYYON_REQUIRE_CGROUP_PROOF === "1") {
		throw new Error(
			`VEYYON_REQUIRE_CGROUP_PROOF is set and the kernel proof could not run: ${reason}. ` +
				`Run this on a host with cgroup v2 delegation, or unset the variable and accept that ` +
				`this run proves nothing about kernel enforcement.`,
		);
	}
	console.log(`NOT PROOF, skipped: ${reason}`);
}
/** Wall window the burner spins for. Long enough to span 30 quota periods. */
const WINDOW_MS = 3_000;

/** The cap under test, in cores. Half a core against a full-core demand. */
const CAP_CORES = 0.5;

/** The machine memory cap under test, in gigabytes. */
const MEMORY_CAP_GB = 0.25;

/**
 * Where the hog gives up. Eight times the cap: far enough past it that no
 * tolerance explains reaching it, close enough that a regression costs bounded
 * swap on the host running the suite rather than however much it has.
 */
const HOG_CEILING_MB = MEMORY_CAP_GB * 1024 * 8;

/**
 * The burner: a single thread that spins for exactly WINDOW_MS of WALL time,
 * then prints the CPU it used.
 *
 * Wall-bounded rather than work-bounded on purpose. A work-bounded loop under a
 * quota simply takes longer and consumes the same CPU, which would measure
 * nothing. Bounded by the clock, a throttled thread gets less CPU in the same
 * window, and that difference is the thing being proved. The `setImmediate`
 * chunking keeps the event loop alive so the process can still print.
 */
const BURNER = `
const started = process.cpuUsage();
const deadline = Date.now() + ${WINDOW_MS};
function chunk() {
	while (Date.now() < deadline) {
		const stop = Date.now() + 20;
		while (Date.now() < stop) Math.sqrt(Math.random());
		if (Date.now() >= deadline) break;
		setImmediate(chunk);
		return;
	}
	const used = process.cpuUsage(started);
	console.log(JSON.stringify({ cpuUsec: used.user + used.system }));
}
chunk();
`;

interface BurnResult {
	/** CPU the child says it used, microseconds. */
	selfUsec: number;
	/** Wall time from spawn to exit, microseconds. */
	wallUsec: number;
}

async function runBurner(adopt?: (pid: number) => void): Promise<BurnResult> {
	// The burner is a spawned `bun -e` child, so it gets a hermetic HOME and no provider
	// credentials like every other spawning suite here. It only spins the CPU, but a child
	// that inherits the operator's HOME can read and migrate their real ~/.veyyon the moment
	// the script it runs changes, and `hermetic-spawn-env.test.ts` is the standing gate that
	// no spawning suite is exempt from that.
	const hermetic = hermeticSpawnEnv();
	const startedAt = Bun.nanoseconds();
	const proc = Bun.spawn([process.execPath, "-e", BURNER], {
		stdout: "pipe",
		stderr: "pipe",
		env: hermetic.env,
	});
	adopt?.(proc.pid);
	try {
		const [stdout, exitCode] = await Promise.all([
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			proc.exited,
		]);
		const wallUsec = (Bun.nanoseconds() - startedAt) / 1_000;
		if (exitCode !== 0) throw new Error(`burner exited ${exitCode}: ${await new Response(proc.stderr).text()}`);
		const match = /"cpuUsec":(\d+)/.exec(stdout);
		if (!match) throw new Error(`burner printed no usage report: ${stdout}`);
		return { selfUsec: Number(match[1]), wallUsec };
	} finally {
		hermetic.cleanup();
	}
}

/**
 * The hog: allocates 16 MB at a time, TOUCHING every page (an untouched
 * allocation is not charged to the cgroup at all), and prints its high-water
 * mark as it goes so the parent can read how far it got from a child the kernel
 * killed without warning.
 */
const MEMORY_HOG = `
const chunks = [];
const ceilingMb = ${HOG_CEILING_MB};
while (chunks.length * 16 < ceilingMb) {
	chunks.push(Buffer.alloc(16 * 1024 * 1024, chunks.length % 251));
	console.log("mb " + chunks.length * 16);
}
console.log("CEILING");
`;

interface HogResult {
	/** The largest allocation the child reported before it stopped, megabytes. */
	highWaterMb: number;
	/** True when the child reached HOG_CEILING_MB under its own power. */
	survived: boolean;
}

async function runMemoryHog(adopt: (pid: number) => void): Promise<HogResult> {
	const hermetic = hermeticSpawnEnv();
	const proc = Bun.spawn([process.execPath, "-e", MEMORY_HOG], {
		stdout: "pipe",
		stderr: "pipe",
		env: hermetic.env,
	});
	adopt(proc.pid);
	try {
		const [stdout] = await Promise.all([new Response(proc.stdout as ReadableStream<Uint8Array>).text(), proc.exited]);
		const marks = [...stdout.matchAll(/mb (\d+)/g)].map(match => Number(match[1]));
		return { highWaterMb: marks.at(-1) ?? 0, survived: stdout.includes("CEILING") };
	} finally {
		hermetic.cleanup();
	}
}

/** `usageUsec()` and `throttledPeriods()`, or a failure naming which one the backend withheld. */
function meter(group: CpuBudgetGroupHandle): { usageUsec: number; throttledPeriods: number } {
	const usageUsec = group.usageUsec();
	const throttledPeriods = group.throttledPeriods();
	expect(usageUsec, "a throttling backend must report cpu.stat usage_usec").toBeDefined();
	expect(throttledPeriods, "a throttling backend must report cpu.stat nr_throttled").toBeDefined();
	return { usageUsec: usageUsec as number, throttledPeriods: throttledPeriods as number };
}

describe("real cgroup enforcement", () => {
	/**
	 * The kernel holds a CPU-bound child to the configured quota, and says so.
	 *
	 * Three independent facts, because each rules out a different failure:
	 *
	 * 1. The group's CPU is at most `cap * wall`. This is the kernel's own
	 *    guarantee and the thing a wrong quota breaks. An unenforced cap lands
	 *    at twice this figure.
	 * 2. The group's CPU is at least 85% of `cap * WINDOW_MS`. The burner
	 *    demands a full core for the whole window, so a working quota is spent
	 *    almost entirely. This rules out "the child never ran", "the child was
	 *    stopped", and a quota far SMALLER than configured.
	 * 3. `nr_throttled` grew. Usage inside the cap could also mean the child
	 *    simply never asked for more; a nonzero throttle count is the kernel
	 *    saying it actively held the group back, which is the difference
	 *    between enforcement and mere accounting.
	 *
	 * A fourth check cross-references the child's own `process.cpuUsage()`
	 * against the group's `cpu.stat`. They must agree, which is what proves the
	 * adopted pid is the pid being metered rather than some other process.
	 */
	it("holds a CPU-bound child to the configured quota and reports the throttling", async () => {
		const env = resolveCpuLimitEnvironment();
		if (env.platform !== "linux") {
			cannotProve(`kernel CPU throttling is Linux-only; this host is ${env.platform}`);
			return;
		}
		const probe = await probeCpuLimitSupport(env);
		if (!probe.supported) {
			cannotProve(`no cgroup delegation available: ${probe.detail}`);
			return;
		}
		console.log(`backend under test: ${probe.detail}`);

		const limiter = new SessionCpuLimit({
			sessionId: `real-${process.pid}`,
			cores: CAP_CORES,
			kill: false,
			probe,
			env,
			windowSamples: 3,
		});
		try {
			const group = await limiter.ensureGroup();
			if (!group) {
				cannotProve("the probed backend could not create a budget group");
				return;
			}
			expect(group.throttles).toBe(true);

			const before = meter(group);
			const burn = await runBurner(pid => {
				void limiter.adoptPid(pid);
			});
			const after = meter(group);

			const groupUsec = after.usageUsec - before.usageUsec;
			const throttled = after.throttledPeriods - before.throttledPeriods;

			// TOLERANCE, and why it is this size. The kernel refills the quota
			// once per `cpu.max` period, so at any instant the group can be up to
			// one full period's allowance ahead of a perfectly proportional
			// figure; the sample straddles a period boundary at each end, so two
			// periods is the honest bound. At 0.5 cores over a 100ms period that
			// is 100_000us against a ~1_500_000us expectation, under 7%. It is
			// derived from the period, not tuned until the test went green.
			const slackUsec = 2 * CAP_CORES * CGROUP_CPU_PERIOD_USEC;
			const ceilingUsec = CAP_CORES * burn.wallUsec + slackUsec;
			// The burner demands a full core for the whole window, so a working
			// quota is nearly all spent. The 15% shortfall covers the runtime's
			// own startup inside the wall window, during which it is not
			// CPU-saturating.
			const floorUsec = 0.85 * CAP_CORES * WINDOW_MS * 1_000;

			console.log(
				`cap ${CAP_CORES} cores | group ${groupUsec}us over ${Math.round(burn.wallUsec)}us wall | ` +
					`self-reported ${burn.selfUsec}us | ceiling ${Math.round(ceilingUsec)}us (tolerance ${slackUsec}us) | ` +
					`floor ${floorUsec}us | throttled periods ${throttled}`,
			);

			expect(groupUsec).toBeLessThanOrEqual(ceilingUsec);
			expect(groupUsec).toBeGreaterThanOrEqual(floorUsec);
			expect(throttled).toBeGreaterThan(0);

			// The two meters are independent: one is the kernel's per-cgroup
			// accounting, the other is the child asking the kernel about itself.
			// 10% covers the child's exit accounting landing after the last
			// `cpu.stat` read. A larger gap means the group is metering a
			// different process than the one that was adopted.
			expect(Math.abs(groupUsec - burn.selfUsec)).toBeLessThanOrEqual(0.1 * burn.selfUsec);
		} finally {
			await limiter.dispose();
		}
	}, 30_000);

	/**
	 * A child that is NEVER adopted contributes nothing to the group's meter.
	 *
	 * The control for the case above. Without it, a `cpu.stat` that counted
	 * every process on the host, or a group that swallowed children the test
	 * never handed it, would satisfy every assertion there while proving the
	 * adoption did nothing. It also pins the other half of the cap's meaning: a
	 * process outside the budget is not slowed, which is the behaviour the
	 * exemption list in cpu-limit-spawn-sites.test.ts depends on.
	 */
	it("an unadopted child is neither metered nor throttled by the group", async () => {
		const env = resolveCpuLimitEnvironment();
		if (env.platform !== "linux") {
			cannotProve(`kernel CPU throttling is Linux-only; this host is ${env.platform}`);
			return;
		}
		const probe = await probeCpuLimitSupport(env);
		if (!probe.supported) {
			cannotProve(`no cgroup delegation available: ${probe.detail}`);
			return;
		}

		const limiter = new SessionCpuLimit({
			sessionId: `real-unadopted-${process.pid}`,
			cores: CAP_CORES,
			kill: false,
			probe,
			env,
			windowSamples: 3,
		});
		try {
			const group = await limiter.ensureGroup();
			if (!group) {
				cannotProve("the probed backend could not create a budget group");
				return;
			}
			const before = meter(group);
			const burn = await runBurner();
			const after = meter(group);

			console.log(
				`unadopted: group delta ${after.usageUsec - before.usageUsec}us, ` +
					`throttled delta ${after.throttledPeriods - before.throttledPeriods}, ` +
					`child self-reported ${burn.selfUsec}us`,
			);

			// The group ran nothing, so its counters must not move at all.
			expect(after.usageUsec).toBe(before.usageUsec);
			expect(after.throttledPeriods).toBe(before.throttledPeriods);
			// And the child, being outside the cap, gets a whole core: far more
			// than the 0.5-core ceiling the adopted twin above is held to.
			expect(burn.selfUsec).toBeGreaterThan(CAP_CORES * WINDOW_MS * 1_000 * 1.5);
		} finally {
			await limiter.dispose();
		}
	}, 30_000);
});

/**
 * The machine tier's one load-bearing claim, against a real kernel.
 *
 * ## What would be fiction without this
 *
 * A machine limit is not enforced by a watcher of its own. It is a parent
 * cgroup that session groups are created inside, and the entire design rests on
 * the kernel bounding a child that carries no cap of its own. Every session
 * limit defaults to zero, so the common case for a machine limit IS an uncapped
 * child: if the parent does not bound it, the feature caps nothing on the one
 * configuration operators will actually run, while the settings row, the status
 * output and the whole fake-cgroup suite stay green.
 *
 * The fake-cgroup suite proves the bytes reach the right files. Only a kernel
 * proves the bytes mean anything.
 *
 * ## What this does not catch
 *
 * It skips where no delegation exists, so a host without cgroup v2 delegation
 * gets no machine-tier proof from this file. `pids.max` inherits the same
 * nesting and its enforcement is not measured here.
 */
describe("a machine limit bounds a session that has no limit of its own", () => {
	it("throttles an uncapped session group to the machine cap", async () => {
		const env = resolveCpuLimitEnvironment();
		if (env.platform !== "linux") {
			cannotProve(`kernel CPU throttling is Linux-only; this host is ${env.platform}`);
			return;
		}
		const probe = await probeCpuLimitSupport(env);
		if (!probe.supported) {
			cannotProve(`no cgroup delegation available: ${probe.detail}`);
			return;
		}

		// Seed the machine limit the way an operator does — the global config
		// file — rather than handing the limiter a directory. The nesting is then
		// the production path's own work, so this fails if configuration stops
		// reaching it, not only if the kernel stops enforcing.
		const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vey-machine-kernel-"));
		fs.writeFileSync(path.join(configRoot, "config.yml"), YAML.stringify({ machine: { cpuLimitCores: CAP_CORES } }));
		const previousConfigDir = process.env.VEYYON_CONFIG_DIR;
		process.env.VEYYON_CONFIG_DIR = configRoot;

		// The session carries NO cap. Its group exists only to hold the pid, and
		// its own cpu.max reads `max`. Anything that throttles the burner below
		// comes from the machine group above it.
		const limiter = new SessionCpuLimit({
			sessionId: `real-machine-${process.pid}`,
			cores: 0,
			kill: false,
			probe,
			env,
			windowSamples: 3,
		});
		try {
			// The session group must exist even though every session limit is off:
			// a machine limit with no group beneath it bounds an empty set.
			const group = await limiter.ensureGroup();
			expect(group, "a machine limit must still create a session group to hold the pid").toBeDefined();
			if (!group) return;

			const before = meter(group);
			const burn = await runBurner(pid => {
				void limiter.adoptPid(pid);
			});
			const after = meter(group);
			const groupUsec = after.usageUsec - before.usageUsec;

			// Same tolerance derivation as the session case: two refill periods
			// of slack, because the sample straddles a period boundary at each
			// end. An unbounded child lands at roughly twice the ceiling.
			const slackUsec = 2 * CAP_CORES * CGROUP_CPU_PERIOD_USEC;
			const ceilingUsec = CAP_CORES * burn.wallUsec + slackUsec;
			const floorUsec = 0.85 * CAP_CORES * WINDOW_MS * 1_000;

			console.log(
				`machine cap ${CAP_CORES} cores, session uncapped | group ${groupUsec}us over ` +
					`${Math.round(burn.wallUsec)}us wall | ceiling ${Math.round(ceilingUsec)}us | floor ${floorUsec}us`,
			);

			expect(groupUsec).toBeLessThanOrEqual(ceilingUsec);
			// Rules out "the burner never ran", which would satisfy the ceiling
			// while proving nothing about the parent.
			expect(groupUsec).toBeGreaterThanOrEqual(floorUsec);
		} finally {
			await limiter.dispose();
			resetMachineWriteTally();
			if (previousConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
			else process.env.VEYYON_CONFIG_DIR = previousConfigDir;
			fs.rmSync(configRoot, { recursive: true, force: true });
		}
	}, 30_000);

	/**
	 * A memory cap is a MEMORY cap, not a resident-set cap with a swap escape.
	 *
	 * `memory.max` on its own bounds resident pages. At the limit the kernel
	 * reclaims and pushes anonymous pages to swap, so a process allocating past
	 * the cap keeps running: measured on a host with 8 GB of swap, a group
	 * capped at 256 MB reached 5,520 MB and pushed 2.9 GB into swap before the
	 * kernel OOM-killed it. Both memory settings exist to stop the machine
	 * swapping, so that reading of the cap is the opposite of the feature.
	 * `memoryCapControls` pairs `memory.swap.max` with every cap, and this is
	 * what says the pair reaches the kernel and means something.
	 *
	 * The hog stops itself at HOG_CEILING_MB so a regression costs bounded swap
	 * rather than the host's: reaching the ceiling IS the failure, and the
	 * assertion reads the high-water mark rather than the exit status, because
	 * a process killed at 5 GB and a process killed at 272 MB both die.
	 */
	it("kills an uncapped session's memory hog at the machine cap instead of swapping past it", async () => {
		const env = resolveCpuLimitEnvironment();
		if (env.platform !== "linux") {
			cannotProve(`cgroup memory caps are Linux-only; this host is ${env.platform}`);
			return;
		}
		const probe = await probeCpuLimitSupport(env);
		if (!probe.supported) {
			cannotProve(`no cgroup delegation available: ${probe.detail}`);
			return;
		}
		if (!probe.kernelLimits.memory) {
			cannotProve(`the memory controller is not delegated here: ${probe.detail}`);
			return;
		}

		const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vey-machine-memory-"));
		fs.writeFileSync(
			path.join(configRoot, "config.yml"),
			YAML.stringify({ machine: { memoryLimitGb: MEMORY_CAP_GB } }),
		);
		const previousConfigDir = process.env.VEYYON_CONFIG_DIR;
		process.env.VEYYON_CONFIG_DIR = configRoot;

		const limiter = new SessionCpuLimit({
			sessionId: `real-machine-memory-${process.pid}`,
			cores: 0,
			kill: false,
			probe,
			env,
			windowSamples: 3,
		});
		try {
			const group = await limiter.ensureGroup();
			expect(group, "a machine memory limit must still create a session group to hold the pid").toBeDefined();
			if (!group) return;

			const hog = await runMemoryHog(pid => {
				void limiter.adoptPid(pid);
			});
			const capMb = MEMORY_CAP_GB * 1024;
			console.log(
				`machine memory cap ${capMb} MB, session uncapped | hog high-water ${hog.highWaterMb} MB | ` +
					`survived to ceiling: ${hog.survived}`,
			);

			// The child dies. A hog that finishes its allocation is a cap that
			// held nothing, whatever the group's own counters say.
			expect(hog.survived, `the hog reached ${HOG_CEILING_MB} MB under a ${capMb} MB cap`).toBe(false);
			// Twice the cap is slack for the runtime's own footprint and for the
			// chunk in flight when the kernel fires. A swap escape lands an order
			// of magnitude above this, not just outside it.
			expect(hog.highWaterMb).toBeLessThanOrEqual(2 * capMb);
		} finally {
			await limiter.dispose();
			resetMachineWriteTally();
			if (previousConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
			else process.env.VEYYON_CONFIG_DIR = previousConfigDir;
			fs.rmSync(configRoot, { recursive: true, force: true });
		}
	}, 60_000);
});
