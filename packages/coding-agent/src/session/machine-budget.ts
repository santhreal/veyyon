/**
 * The machine-wide budget: one cgroup that every session budget group is
 * created INSIDE, so a single cap covers every session, every profile and
 * every veyyon running at once.
 *
 * WHY A PARENT CGROUP RATHER THAN A SECOND LIMITER. cgroup v2 already caps a
 * subtree: `cpu.max`, `memory.max` and `pids.max` on a directory bound every
 * descendant of it, whoever created them. Nesting the session groups one level
 * down therefore buys the whole machine tier from the kernel with no second
 * watcher, no second policy and no arithmetic that could disagree with the
 * per-session tier. A session limit larger than the machine limit is bounded
 * by it rather than raising it, because that is what the kernel does with a
 * child quota wider than its parent's, not because a rule here says so.
 *
 * WHY IT SPANS PROCESSES. The directory is derived from the delegated parent
 * and the uid, never from a pid or a session id, so a second veyyon starting
 * later finds the SAME directory and puts its sessions in it. That is what
 * makes the cap machine-wide instead of instance-wide: two copies running at
 * once share one quota rather than getting one each. Creation tolerates an
 * existing directory for the same reason, and nothing here ever removes it —
 * a live instance's sessions are inside it.
 *
 * WHAT THE KERNEL DOES NOT DO. A write budget is a cumulative total, and no
 * cgroup controller caps one: `io.max` throttles a RATE and `io.stat` only
 * counts. The machine write budget is therefore a refusal, computed from the
 * subtree's own `io.stat` plus a small cross-process counter for bytes the
 * harness writes itself (the veyyon process is not a member of the group it
 * creates, so its own writes are not in `io.stat`).
 *
 * SCOPE BOUNDARY. This module owns the machine tier and knows nothing about a
 * session. `session/cpu-limit.ts` depends on it and not the reverse, so the
 * per-session limiter keeps one owner and this stays testable against a
 * tmpdir cgroup tree.
 */
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
// Owners, not the `@veyyon/utils` barrel: 3 modules against 81.
import { type GlobalResourceLimit, getGlobalConfigFilePath, resolveGlobalResourceLimit } from "@veyyon/utils/dirs";
import { withFileLockSync } from "@veyyon/utils/file-lock";
import * as logger from "@veyyon/utils/logger";
import { BYTES_PER_GB, parseIoStatWrittenBytes } from "./write-accounting";

/**
 * The directory name for the machine group, under the delegated parent the
 * host probe selected. Fixed rather than derived from anything per-instance:
 * two veyyon processes must resolve the same path or the cap is not shared.
 */
export const MACHINE_BUDGET_DIR_NAME = "veyyon.machine";

/** The cross-process tally of bytes veyyon processes wrote themselves. */
export const MACHINE_WRITE_TALLY_FILE = "machine-writes";

/** Every machine-wide limit, as the settings rows spell them. 0 is no limit. */
export interface MachineBudgetLimits {
	cpuLimitCores: number;
	memoryLimitGb: number;
	writeBudgetGb: number;
	maxProcesses: number;
}

/**
 * The machine limits from the GLOBAL config.
 *
 * Read through the strict resolver, not the safe one: a limit is a safety
 * control, and a config whose value cannot be parsed must be reported rather
 * than silently read as "no limit". The caller turns the throw into a startup
 * notice naming the file, which is the one place a person can act on it.
 */
export function machineBudgetLimits(): MachineBudgetLimits {
	const read = (limit: GlobalResourceLimit): number => resolveGlobalResourceLimit(limit);
	return {
		cpuLimitCores: read("cpuLimitCores"),
		memoryLimitGb: read("memoryLimitGb"),
		writeBudgetGb: read("writeBudgetGb"),
		maxProcesses: read("maxProcesses"),
	};
}

/** True when any machine limit is set, so the group is worth creating at all. */
export function anyMachineLimitActive(limits: MachineBudgetLimits): boolean {
	return limits.cpuLimitCores > 0 || limits.memoryLimitGb > 0 || limits.writeBudgetGb > 0 || limits.maxProcesses > 0;
}

/** Which machine caps the kernel actually took, per controller. */
export interface MachineKernelHold {
	cpu: boolean;
	pids: boolean;
	memory: boolean;
}

/** Where a session budget group should be created, and what bounds it. */
export interface MachineBudgetPlacement {
	/**
	 * The directory session groups are created under. The machine group when
	 * one exists, otherwise the delegated parent unchanged, so a host with no
	 * machine tier behaves exactly as it did before there was one.
	 */
	parentDir: string;
	/** The machine group itself, or undefined when none was created. */
	machineDir: string | undefined;
	kernelHeld: MachineKernelHold;
	/**
	 * A limit is configured that nothing here can hold. The caller reports it
	 * once at startup; an unheld cap must never pass silently as a held one.
	 */
	unenforceable: string | undefined;
}

/** The placement for a host with no machine tier: the parent, unchanged. */
function passthrough(parentDir: string, unenforceable?: string): MachineBudgetPlacement {
	return {
		parentDir,
		machineDir: undefined,
		kernelHeld: { cpu: false, pids: false, memory: false },
		unenforceable,
	};
}

/** The `cpu.max`, `memory.max` or `pids.max` body for a limit, or the kernel's "no cap". */
function limitValue(value: number, scale = 1): string {
	return value > 0 ? String(Math.floor(value * scale)) : "max";
}

/**
 * Write one cgroup control file, reporting whether the kernel took it.
 *
 * The write IS the probe. Controller delegation differs per controller and per
 * host, and a directory that advertised a controller can still refuse the
 * write, so believing an earlier reading here would report a cap that does not
 * exist.
 */
async function writeControl(dir: string, file: string, value: string): Promise<boolean> {
	try {
		await fs.writeFile(path.join(dir, file), value);
		return true;
	} catch (error) {
		logger.debug("machine budget control write failed", { file, value, error: String(error) });
		return false;
	}
}

/**
 * Enable the controllers the session groups below will need.
 *
 * Without this a child of the machine directory has no `cpu.max` to write at
 * all, so the per-session tier would silently stop working the moment a
 * machine group appeared between it and the delegated parent. Failure is not
 * fatal and not silent: the caller degrades to the delegated parent.
 */
async function enableSubtreeControllers(dir: string): Promise<boolean> {
	const available = await fs
		.readFile(path.join(dir, "cgroup.controllers"), "utf8")
		.then(text => text.split(/\s+/).filter(Boolean))
		.catch(() => [] as string[]);
	if (!available.includes("cpu")) return false;
	const current = await fs
		.readFile(path.join(dir, "cgroup.subtree_control"), "utf8")
		.then(text => text.split(/\s+/).filter(Boolean))
		.catch(() => [] as string[]);
	const wanted = ["cpu", "pids", "memory"].filter(c => available.includes(c) && !current.includes(c));
	if (wanted.length === 0) return true;
	// One controller at a time: cgroup v2 rejects the whole write if any single
	// controller in it cannot be enabled, so a batched "+cpu +pids +memory"
	// loses cpu because memory was not delegated.
	let cpuEnabled = current.includes("cpu");
	for (const controller of wanted) {
		const ok = await writeControl(dir, "cgroup.subtree_control", `+${controller}`);
		if (controller === "cpu") cpuEnabled ||= ok;
	}
	return cpuEnabled;
}

/** What {@link ensureMachineBudget} needs from the host. */
export interface MachineBudgetHost {
	/**
	 * `string`, not `NodeJS.Platform`, to match `CpuLimitEnvironment.platform`:
	 * the limiter's host environment is injectable so a test can drive a
	 * platform this build was not compiled for, and narrowing here would only
	 * force a cast at the one call site.
	 */
	platform: string;
	/** The delegated directory the session groups would otherwise be created in. */
	parentDir: string;
}

/**
 * Create or adopt the machine group and apply the machine limits to it.
 *
 * Idempotent and safe to run concurrently with another veyyon: `mkdir` on an
 * existing directory is not an error here, and the limit writes are the same
 * values from the same file, so whichever instance writes last writes what the
 * others would have. Nothing is removed — another instance's sessions live
 * inside it, and an empty cgroup costs nothing until the next one starts.
 *
 * Returns the delegated parent unchanged when there is no machine limit to
 * apply, when the platform has no cgroup tier, or when the group cannot be
 * made. A configured limit that ends up unheld is named in `unenforceable`
 * rather than dropped.
 */
export async function ensureMachineBudget(
	host: MachineBudgetHost,
	limits: MachineBudgetLimits,
): Promise<MachineBudgetPlacement> {
	if (!anyMachineLimitActive(limits)) return passthrough(host.parentDir);
	if (host.platform !== "linux") {
		return passthrough(
			host.parentDir,
			`A machine-wide resource limit is set, but ${host.platform} has no per-group kernel quota, so it ` +
				`cannot be held across veyyon processes. Per-session limits still apply. Fix: clear the machine.* ` +
				`limits, or accept that they bound nothing on this host.`,
		);
	}
	const dir = path.join(host.parentDir, MACHINE_BUDGET_DIR_NAME);
	try {
		await fs.mkdir(dir, { recursive: true });
	} catch (error) {
		return passthrough(
			host.parentDir,
			`A machine-wide resource limit is set, but the machine budget group ${dir} could not be created ` +
				`(${String(error)}), so the limit is not held. Per-session limits still apply.`,
		);
	}
	if (!(await enableSubtreeControllers(dir))) {
		// Without the cpu controller delegated downward, a session group created
		// in here would have no quota file at all. Falling back to the delegated
		// parent keeps the per-session tier working, which matters more than a
		// machine tier this host cannot support.
		return passthrough(
			host.parentDir,
			`A machine-wide resource limit is set, but ${dir} cannot delegate the cpu controller to the session ` +
				`groups below it, so the machine limit is not held and sessions were placed outside it. ` +
				`Per-session limits still apply.`,
		);
	}
	const kernelHeld: MachineKernelHold = {
		cpu: await writeControl(dir, "cpu.max", cpuMaxValue(limits.cpuLimitCores)),
		pids: await writeControl(dir, "pids.max", limitValue(limits.maxProcesses)),
		memory: await writeControl(dir, "memory.max", limitValue(limits.memoryLimitGb, BYTES_PER_GB)),
	};
	return {
		parentDir: dir,
		machineDir: dir,
		kernelHeld,
		unenforceable: describeUnheld(limits, kernelHeld),
	};
}

/** cgroup v2 `cpu.max` period the machine quota is expressed against (microseconds). */
export const MACHINE_CPU_PERIOD_USEC = 100_000;

/** The `cpu.max` body for `cores` cores, or the kernel's "no cap". */
export function cpuMaxValue(cores: number): string {
	if (cores <= 0) return `max ${MACHINE_CPU_PERIOD_USEC}`;
	return `${Math.floor(cores * MACHINE_CPU_PERIOD_USEC)} ${MACHINE_CPU_PERIOD_USEC}`;
}

/**
 * The message for limits that are configured but unheld, or undefined when
 * every configured limit is held. Named per resource: "the machine limit did
 * not apply" is not actionable, and the controllers fail independently.
 */
function describeUnheld(limits: MachineBudgetLimits, held: MachineKernelHold): string | undefined {
	const unheld: string[] = [];
	if (limits.cpuLimitCores > 0 && !held.cpu) unheld.push("machine.cpuLimitCores (no cpu controller)");
	if (limits.maxProcesses > 0 && !held.pids) unheld.push("machine.maxProcesses (no pids controller)");
	if (limits.memoryLimitGb > 0 && !held.memory) unheld.push("machine.memoryLimitGb (no memory controller)");
	if (unheld.length === 0) return undefined;
	return (
		`These machine-wide limits are set but the kernel is not holding them: ${unheld.join(", ")}. ` +
		`Per-session limits still apply. Fix: clear those machine.* limits, or delegate the controllers to ` +
		`this user's cgroup.`
	);
}

// ---------------------------------------------------------------------------
// Machine write budget
// ---------------------------------------------------------------------------

/**
 * Bytes veyyon processes wrote THEMSELVES, tallied across instances.
 *
 * The harness writes files from its own process, which is not a member of the
 * machine cgroup (only spawned children are adopted into it), so those bytes
 * never reach `io.stat`. Counting them in memory would also reset every
 * restart, which a cumulative machine budget must not do. One small file under
 * the global config root, mutated under the same advisory lock the global
 * config uses, gives one total that survives a restart and is shared by every
 * instance.
 */
function machineWriteTallyPath(): string {
	return path.join(path.dirname(getGlobalConfigFilePath()), MACHINE_WRITE_TALLY_FILE);
}

/** Read the tally, treating any unreadable or malformed file as zero. */
function readTally(file: string): number {
	try {
		const text = fsSync.readFileSync(file, "utf8");
		const value = Number.parseInt(text.trim(), 10);
		return Number.isFinite(value) && value >= 0 ? value : 0;
	} catch {
		return 0;
	}
}

/**
 * Add harness-written bytes to the machine tally.
 *
 * Synchronous and lock-held because two instances committing a file at the
 * same moment would otherwise read the same total and each write back their
 * own, losing one of the two. The lock is the same advisory file lock the
 * global config writer uses, so the cost is one uncontended open in the common
 * case.
 */
export function addMachineHarnessWrite(bytes: number): void {
	if (!Number.isFinite(bytes) || bytes <= 0) return;
	const file = machineWriteTallyPath();
	try {
		withFileLockSync(file, () => {
			const next = readTally(file) + Math.floor(bytes);
			fsSync.writeFileSync(file, String(next));
		});
	} catch (error) {
		// A tally that cannot be written must not fail the write it was counting.
		// The budget under-counts rather than the edit failing, and the reason is
		// in the log rather than in the user's way.
		logger.debug("machine write tally update failed", { file, error: String(error) });
	}
}

/** The harness half of the machine write total. */
export function machineHarnessWrittenBytes(): number {
	return readTally(machineWriteTallyPath());
}

/**
 * Bytes the machine cgroup subtree has written, from its own `io.stat`.
 *
 * `io.stat` aggregates every descendant, so this counts what every session in
 * every veyyon on this machine spawned, which is what a machine budget bounds
 * and what no single session can compute. It accumulates from the moment the
 * cgroup was created and the directory is never removed here, so the total
 * survives a restart and resets only when the cgroup itself goes (a reboot, or
 * someone removing it by hand). That is the intended reset: a machine budget
 * that emptied whenever veyyon restarted would bound a session, not a machine.
 *
 * Zero when there is no machine cgroup, or when `io.stat` cannot be read
 * because the io controller is not delegated.
 */
export async function machineSpawnedWrittenBytes(machineDir: string | undefined): Promise<number> {
	if (!machineDir) return 0;
	const text = await fs.readFile(path.join(machineDir, "io.stat"), "utf8").catch(() => undefined);
	return (text === undefined ? undefined : parseIoStatWrittenBytes(text)) ?? 0;
}

/** Every byte charged to the machine write budget: the subtree's plus the harness's. */
export async function machineWrittenBytes(machineDir: string | undefined): Promise<number> {
	return machineHarnessWrittenBytes() + (await machineSpawnedWrittenBytes(machineDir));
}

/** Reset the machine write tally. Test-only, and the manual reset path. */
export function resetMachineWriteTally(): void {
	try {
		fsSync.rmSync(machineWriteTallyPath(), { force: true });
	} catch {
		// Nothing to reset is the same outcome as a successful reset.
	}
}
