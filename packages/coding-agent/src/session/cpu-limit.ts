/**
 * Per-session-tree budget group enforcing CPU, disk write, process, and memory limits.
 * Caps spawned OS processes while leaving in-process harness execution unthrottled.
 * Subagents inherit the root session's budget group as aliases.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CpuBudgetGroup as NativeCpuBudgetGroup } from "@veyyon/natives";
// Owners, not the `@veyyon/utils` barrel: 2 modules against 81.
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { Settings } from "../config/settings";
import { settingsOrNull } from "../config/settings-instance";
import { registerOwnedResourceDisposer } from "./owned-resources";
import {
	BYTES_PER_GB,
	formatWriteBytes,
	type SpawnedWriteSource,
	sampleSpawnedWrites,
	WriteAccountant,
} from "./write-accounting";

/** cgroup v2 cpu.max period the quota is expressed against (microseconds). */
export const CPU_LIMIT_PERIOD_USEC = 100_000;

/** Default watcher cadence: one usage sample per second. */
export const CPU_LIMIT_WATCH_INTERVAL_MS = 1_000;

/**
 * Consecutive saturated samples before the watcher acts. One spike denies
 * nothing; three seconds at the wall does.
 */
export const CPU_LIMIT_WINDOW_SAMPLES = 3;

/** Fraction of the budget that counts as "at the wall" for a single sample. */
const SATURATION_RATIO = 0.95;

/** Nice level applied to budget members on sustained saturation where no kernel quota exists. */
export const CPU_LIMIT_SATURATION_NICE = 10;

/** The `cpu.max` value for `cores` cores: quota over the fixed period. */
export function formatCpuMaxValue(cores: number): string {
	return `${Math.round(cores * CPU_LIMIT_PERIOD_USEC)} ${CPU_LIMIT_PERIOD_USEC}`;
}

/** Result of running a helper binary (systemd-run, systemctl) during probe or setup. */
export interface CpuLimitCommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Everything the limiter needs from the host that is NOT part of the native
 * budget surface, injected so tests drive a tmpdir cgroup tree, a scripted
 * `run`, and a fixed clock.
 */
export interface CpuLimitEnvironment {
	platform: string;
	uid: number;
	/** cgroup v2 mount root; `/sys/fs/cgroup` in production, a tmpdir in tests. */
	cgroupRoot: string;
	/** The harness's own cgroup path relative to the root ("" when unknown). */
	ownCgroupPath: string;
	run(cmd: string[]): Promise<CpuLimitCommandResult>;
	kill(pid: number, signal: "SIGTERM"): void;
	now(): number;
	/**
	 * procfs mount, `/proc` in production and a tmpdir in tests. Read for the
	 * `/proc/<pid>/io` write fallback when the `io` controller is not delegated.
	 */
	procRoot: string;
	/**
	 * Remove a probe directory. On a real cgroupfs this is `rmdir` (the
	 * controller files are virtual); a tmpdir stand-in must remove the real
	 * files the probe's writes created.
	 */
	removeDir(dir: string): Promise<void>;
}

/** Which enforcement mechanism the probe selected. */
export type CpuLimitBackend =
	| { kind: "direct"; parentDir: string }
	| { kind: "systemd-run" }
	| { kind: "job-object" }
	| { kind: "tracked" };

/**
 * Kernel controller enforcement capabilities measured via live probe child.
 * Distinguishes delegated controllers (`cpu`, `memory`, `pids`, `io`) from backend presence.
 */
export interface CgroupControllerCapabilities {
	cpu: boolean;
	pids: boolean;
	memory: boolean;
}

/** Outcome of the once-per-process capability probe. */
export interface CpuLimitProbe {
	supported: boolean;
	/** Whether the selected backend makes the kernel throttle the group. */
	throttles: boolean;
	backend: CpuLimitBackend | null;
	/** Which limits this backend's kernel can hold, measured not assumed. */
	kernelLimits: CgroupControllerCapabilities;
	/** Which backend was selected, or WHY none works. Shown verbatim. */
	detail: string;
}

/** The piece of the native `CpuBudgetGroup` the limiter drives. */
export interface CpuBudgetGroupHandle {
	readonly throttles: boolean;
	adopt(pid: number): void;
	usageUsec(): number | undefined;
	throttledPeriods(): number | undefined;
	members(): number[];
	setCores(cores: number): void;
	renice(level: number): void;
	dispose(): void;
}

/** What the group factory needs; mirrors the napi `CpuBudgetCreateOptions`. */
export interface CpuBudgetGroupSpec {
	name: string;
	cores: number;
	cgroupParentDir?: string;
	existingCgroupDir?: string;
	trackedOnly?: boolean;
}

/** Production factory: the real napi class. */
function createNativeBudgetGroup(spec: CpuBudgetGroupSpec): CpuBudgetGroupHandle {
	const group = new NativeCpuBudgetGroup({
		name: spec.name,
		cores: spec.cores,
		...(spec.cgroupParentDir !== undefined ? { cgroupParentDir: spec.cgroupParentDir } : {}),
		...(spec.existingCgroupDir !== undefined ? { existingCgroupDir: spec.existingCgroupDir } : {}),
		...(spec.trackedOnly !== undefined ? { trackedOnly: spec.trackedOnly } : {}),
	});
	return {
		throttles: group.throttles,
		adopt: pid => group.adopt(pid),
		usageUsec: () => group.usageUsec() ?? undefined,
		throttledPeriods: () => group.throttledPeriods() ?? undefined,
		members: () => group.members(),
		setCores: cores => group.setCores(cores),
		renice: level => group.renice(level),
		dispose: () => group.dispose(),
	};
}

async function readOptional(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, "utf8");
	} catch {
		return undefined;
	}
}

/** The `pids.max` / `memory.max` value for a limit, or the kernel's "no cap". */
function limitFileValue(value: number): string {
	return value > 0 ? String(Math.floor(value)) : "max";
}

/**
 * Probe whether `dir` can host a session cgroup with required controller capabilities.
 * Tests controllers with a temporary probe child to verify cgroup v2 delegation rules.
 */
async function tryDirectParent(env: CpuLimitEnvironment, dir: string): Promise<CgroupControllerCapabilities | null> {
	const controllers = (await readOptional(path.join(dir, "cgroup.controllers")))?.split(/\s+/) ?? [];
	if (!controllers.includes("cpu")) return null;
	const probeChild = path.join(dir, `.veyyon-cpu-probe-${env.uid}`);
	const subtreeControlFile = path.join(dir, "cgroup.subtree_control");
	const delegate = async (controller: string, probeFile: string, probeValue: string): Promise<boolean> => {
		if (!controllers.includes(controller)) return false;
		try {
			const subtreeControl = await readOptional(subtreeControlFile);
			if (!subtreeControl?.split(/\s+/).includes(controller)) {
				await fs.writeFile(subtreeControlFile, `+${controller}`);
			}
			await fs.writeFile(path.join(probeChild, probeFile), probeValue);
			return true;
		} catch {
			return false;
		}
	};
	try {
		await fs.mkdir(probeChild);
		const cpu = await delegate("cpu", "cpu.max", formatCpuMaxValue(1));
		if (!cpu) return null;
		return {
			cpu,
			pids: await delegate("pids", "pids.max", "max"),
			memory: await delegate("memory", "memory.max", "max"),
		};
	} catch {
		return null;
	} finally {
		await env.removeDir(probeChild).catch(() => {});
	}
}

function unsupported(detail: string): CpuLimitProbe {
	return {
		supported: false,
		throttles: false,
		backend: null,
		kernelLimits: { cpu: false, pids: false, memory: false },
		detail,
	};
}

/** Probe the host once: platform, controller availability, backend. */
export async function probeCpuLimitSupport(env: CpuLimitEnvironment): Promise<CpuLimitProbe> {
	if (env.platform === "win32") {
		return {
			supported: true,
			throttles: true,
			backend: { kind: "job-object" },
			// A Job Object caps CPU rate and nothing else the native surface
			// exposes: no process limit, no commit limit, no I/O counters. The
			// process cap still holds as policy; memory and the spawned half of
			// the write budget do not, and say so.
			kernelLimits: { cpu: true, pids: false, memory: false },
			detail: "Windows Job Object with a hard CPU rate cap",
		};
	}
	if (env.platform === "darwin") {
		return {
			supported: true,
			throttles: false,
			backend: { kind: "tracked" },
			kernelLimits: { cpu: false, pids: false, memory: false },
			detail:
				"macOS has no per-group CPU quota, so the budget is enforced as policy only: " +
				"new commands are refused while the group is saturated, and members are reniced " +
				"(or killed, with session.cpuLimitKill). There is no kernel throttle.",
		};
	}
	if (env.platform !== "linux") {
		return unsupported(`per-session CPU limits are unimplemented on ${env.platform}`);
	}
	const rootControllers = await readOptional(path.join(env.cgroupRoot, "cgroup.controllers"));
	if (rootControllers === undefined) {
		return unsupported(`cgroups v2 is not mounted at ${env.cgroupRoot} (a v1 or hybrid hierarchy has no cpu.max)`);
	}
	const userService = path.join(env.cgroupRoot, "user.slice", `user-${env.uid}.slice`, `user@${env.uid}.service`);
	const ownDir = env.ownCgroupPath ? path.join(env.cgroupRoot, env.ownCgroupPath) : undefined;
	// The harness's own cgroup usually holds processes, and cgroup v2 refuses to
	// enable a controller for the children of a cgroup that has member processes.
	// Its PARENT is the delegated directory in that layout, so try both.
	const ownParent = ownDir && path.dirname(ownDir).startsWith(env.cgroupRoot) ? path.dirname(ownDir) : undefined;
	const candidates = [ownDir, ownParent, path.join(userService, "app.slice"), userService].filter(
		(dir): dir is string => dir !== undefined,
	);
	for (const dir of candidates) {
		const kernelLimits = await tryDirectParent(env, dir);
		if (kernelLimits) {
			return {
				supported: true,
				throttles: true,
				backend: { kind: "direct", parentDir: dir },
				kernelLimits,
				detail: `direct cgroup writes under ${dir}`,
			};
		}
	}
	const systemctl = await env
		.run(["systemctl", "--user", "show-environment"])
		.catch((error): CpuLimitCommandResult => ({ code: 1, stdout: "", stderr: errorMessage(error) }));
	if (systemctl.code === 0) {
		// The unit's own cgroup does not exist yet, so the closest measurable
		// stand-in is what the user manager itself was delegated: systemd hands
		// a transient unit the controllers it holds. Optimism here would be
		// worse than pessimism, so a controller the manager does not have is
		// reported unenforceable and corrected upward only if the real write to
		// the unit's cgroup later succeeds.
		const managerControllers = (await readOptional(path.join(userService, "cgroup.controllers")))?.split(/\s+/) ?? [];
		return {
			supported: true,
			throttles: true,
			backend: { kind: "systemd-run" },
			kernelLimits: {
				cpu: true,
				pids: managerControllers.includes("pids"),
				memory: managerControllers.includes("memory"),
			},
			detail: "systemd user services via systemd-run --user",
		};
	}
	return unsupported(
		"no writable cgroup has the cpu controller delegated, and no systemd user manager answered " +
			`(systemctl --user failed: ${systemctl.stderr.trim() || `exit ${systemctl.code}`})`,
	);
}

/**
 * Thrown when process spawn is refused due to an exceeded or unenforceable budget limit
 * (CPU saturation, write budget, process cap, or memory cap).
 */
export class CpuLimitDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CpuLimitDeniedError";
	}
}

/** Thrown by the write and edit tools when the session tree's write budget is spent. */
export class WriteBudgetDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WriteBudgetDeniedError";
	}
}

/**
 * The limits beyond CPU, as the settings rows spell them. Every one is 0 =
 * off, and `undefined` on an update means "leave this one alone" so a caller
 * that only knows about CPU (the session's own settings watcher) cannot wipe
 * the others.
 */
export interface SessionBudgetLimits {
	writeBudgetGb?: number;
	writeBudgetKill?: boolean;
	maxProcesses?: number;
	memoryLimitGb?: number;
}

interface WatcherSample {
	at: number;
	usageUsec: number;
	throttledPeriods: number | undefined;
}

export interface SessionCpuLimitOptions extends SessionBudgetLimits {
	sessionId: string;
	cores: number;
	kill: boolean;
	probe: CpuLimitProbe | Promise<CpuLimitProbe>;
	env: CpuLimitEnvironment;
	/** Operator-visible events (saturation begins, budget kills). */
	onNotice?: (text: string) => void;
	/** Group factory; defaults to the real native class. The test seam. */
	createGroup?: (spec: CpuBudgetGroupSpec) => CpuBudgetGroupHandle;
	watchIntervalMs?: number;
	windowSamples?: number;
}

/** The budget group name the native spawn hooks resolve for this session. */
export function sessionCpuBudgetName(sessionId: string): string {
	const safe = sessionId.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
	return `veyyon-cpu-${safe.length > 0 ? safe : "session"}`;
}

/**
 * One session tree's budget: the group (lazily created on the first capped
 * spawn), the watcher, the four limits and their deny/kill policy.
 */
export class SessionCpuLimit {
	readonly #options: SessionCpuLimitOptions;
	#cores: number;
	#killEnabled: boolean;
	#writeBudgetGb: number;
	#writeBudgetKill: boolean;
	#maxProcesses: number;
	#memoryLimitGb: number;
	readonly #probe: Promise<CpuLimitProbe>;
	#group: CpuBudgetGroupHandle | undefined;
	#ensurePromise: Promise<CpuBudgetGroupHandle | undefined> | undefined;
	#systemdUnit: string | undefined;
	/** The group's own cgroup directory, when the backend has one. */
	#cgroupDir: string | undefined;
	#setupFailed = false;
	#timer: NodeJS.Timeout | undefined;
	#lastSample: WatcherSample | undefined;
	#window: boolean[] = [];
	#denied = false;
	#killedThisEpisode = false;
	#reniced = false;
	#lastCoresUsed = 0;
	#lastKillReport: string | undefined;
	#disposed = false;
	readonly #writes = new WriteAccountant();
	#writeOverBudget = false;
	#writeKilledThisEpisode = false;
	/** Live member count from the last poll; the process cap is judged against it. */
	#memberCount = 0;
	/** Whether the live group's `pids.max` / `memory.max` actually took a write. */
	#pidsEnforced = false;
	#memoryEnforced = false;
	/** Notice keys already shown, so a refused limit reports once and not per attempt. */
	readonly #noticed = new Set<string>();
	/**
	 * Whether a caller has supplied the non-CPU limits. Until one has, the group
	 * falls back to the configured values, so a spawn path that never passes
	 * through a gate is still capped.
	 */
	#limitsSupplied: boolean;

	constructor(options: SessionCpuLimitOptions) {
		this.#options = options;
		this.#cores = options.cores;
		this.#killEnabled = options.kill;
		this.#writeBudgetGb = options.writeBudgetGb ?? 0;
		this.#writeBudgetKill = options.writeBudgetKill ?? false;
		this.#maxProcesses = options.maxProcesses ?? 0;
		this.#memoryLimitGb = options.memoryLimitGb ?? 0;
		this.#limitsSupplied =
			options.writeBudgetGb !== undefined ||
			options.maxProcesses !== undefined ||
			options.memoryLimitGb !== undefined;
		this.#probe = Promise.resolve(options.probe);
	}

	/**
	 * Apply non-CPU limits from configuration if not already supplied by a gate.
	 * Ensures memory, disk write, and PID limits are enforced for early spawns.
	 */
	async #applyConfiguredLimits(): Promise<void> {
		if (this.#limitsSupplied) return;
		const limits = configuredBudgetLimits();
		if (limits) await this.updateLimits(limits);
	}

	get cores(): number {
		return this.#cores;
	}

	/** The budget group name, whether or not the group exists yet. */
	get budgetName(): string {
		return sessionCpuBudgetName(this.#options.sessionId);
	}

	/** Cumulative bytes this session tree has written: harness tools plus the group. */
	get writtenBytes(): number {
		return this.#writes.totalBytes;
	}

	/** Which source the spawned half of the write budget is being metered from. */
	get writeSource(): SpawnedWriteSource {
		return this.#writes.source;
	}

	/** A one-line state summary for diagnostics (doctor, logs). */
	async statusLine(): Promise<string> {
		const probe = await this.#probe;
		const extras = this.#extraStatusParts();
		const suffix = extras.length > 0 ? `. ${extras.join(". ")}` : "";
		if (this.#cores <= 0) return `off (session.cpuLimitCores is 0)${suffix}`;
		if (!probe.supported) return `configured for ${this.#cores} core(s) but unavailable: ${probe.detail}${suffix}`;
		if (this.#setupFailed) return `configured for ${this.#cores} core(s) but group setup failed${suffix}`;
		const mode = probe.throttles ? "kernel-throttled" : "policy-only (no kernel throttle on this OS)";
		const state = this.#group ? "enforcing" : "armed, group created on first spawn";
		return `${this.#cores} core(s), ${mode}, via ${probe.detail}; ${state}${this.#denied ? "; saturated, refusing new commands" : ""}${suffix}`;
	}

	#extraStatusParts(): string[] {
		const parts: string[] = [];
		if (this.#writeBudgetGb > 0) {
			const source =
				this.#writes.source === "none"
					? "harness tool writes only, spawned writes unmeterable here"
					: `spawned writes via ${this.#writes.source}`;
			parts.push(
				`write budget ${this.#writeBudgetGb} GB, ${formatWriteBytes(this.#writes.totalBytes)} used (${source})`,
			);
		}
		if (this.#maxProcesses > 0) {
			parts.push(
				`process cap ${this.#maxProcesses}, ${this.#memberCount} live` +
					`${this.#pidsEnforced ? " (pids.max)" : " (policy refusal only)"}`,
			);
		}
		if (this.#memoryLimitGb > 0) {
			parts.push(
				this.#memoryEnforced
					? `memory limit ${this.#memoryLimitGb} GB via memory.max`
					: `memory limit ${this.#memoryLimitGb} GB UNENFORCEABLE here, refusing new commands`,
			);
		}
		return parts;
	}

	/**
	 * Whether ANY limit is set. The group exists for the union of them, not
	 * for CPU alone: a write budget needs the group's `io.stat` and member
	 * list, a process cap needs `pids.max`, and a memory cap needs
	 * `memory.max`, none of which exist without a group.
	 */
	get #anyLimitActive(): boolean {
		return this.#cores > 0 || this.#writeBudgetGb > 0 || this.#maxProcesses > 0 || this.#memoryLimitGb > 0;
	}

	/**
	 * Update non-CPU limits from settings changes without resetting cumulative counters.
	 * Undefined values leave corresponding limits unchanged.
	 */
	async updateLimits(limits: SessionBudgetLimits): Promise<void> {
		this.#limitsSupplied = true;
		const previousWriteBudget = this.#writeBudgetGb;
		const previousMaxProcesses = this.#maxProcesses;
		const previousMemory = this.#memoryLimitGb;
		if (limits.writeBudgetGb !== undefined) this.#writeBudgetGb = limits.writeBudgetGb;
		if (limits.writeBudgetKill !== undefined) this.#writeBudgetKill = limits.writeBudgetKill;
		if (limits.maxProcesses !== undefined) this.#maxProcesses = limits.maxProcesses;
		if (limits.memoryLimitGb !== undefined) this.#memoryLimitGb = limits.memoryLimitGb;
		if (
			this.#writeBudgetGb === previousWriteBudget &&
			this.#maxProcesses === previousMaxProcesses &&
			this.#memoryLimitGb === previousMemory
		) {
			return;
		}
		// A raised write budget un-refuses: the total did not shrink, but the
		// wall it is measured against moved, and leaving the refusal latched
		// would make raising the setting do nothing until restart.
		this.#writeOverBudget = this.#writeBudgetGb > 0 && this.#writes.totalBytes >= this.#writeLimitBytes;
		if (!this.#writeOverBudget) this.#writeKilledThisEpisode = false;
		// Only the CHANGED limit gets to speak again. Clearing every key here
		// meant an unrelated settings change re-narrated a cap that had already
		// been reported, which is the "one notice, not one per attempt" contract
		// leaking out through a side door.
		if (this.#writeBudgetGb !== previousWriteBudget) this.#noticed.delete("write-source");
		if (this.#maxProcesses !== previousMaxProcesses) this.#noticed.delete("pids-unenforceable");
		if (this.#memoryLimitGb !== previousMemory) this.#noticed.delete("memory-unenforceable");
		await this.#applyCgroupResourceLimits();
	}

	/**
	 * Pick up a settings change. Raising or lowering the CPU limit re-expresses
	 * the quota on the live group; setting 0 lifts it without destroying the
	 * group (processes already inside stay accounted).
	 */
	async update(cores: number, kill: boolean, limits?: SessionBudgetLimits): Promise<void> {
		const changed = cores !== this.#cores;
		this.#killEnabled = kill;
		if (limits) await this.updateLimits(limits);
		if (!changed) return;
		const wasOff = this.#cores <= 0;
		this.#cores = cores;
		if (this.#setupFailed) {
			// One failure used to disable the budget for the whole session: a
			// momentarily unwritable cgroup parent or a busy systemd left
			// #setupFailed set and #ensurePromise memoised, so nothing re-armed
			// even after the operator fixed the host and re-set the value. A
			// changed setting is exactly that request, and `changed` above keeps
			// this from retrying on every spawn.
			this.#setupFailed = false;
			this.#ensurePromise = undefined;
		}
		if (cores <= 0) {
			this.#denied = false;
			this.#window = [];
			if (this.#reniced) {
				this.#group?.renice(0);
				this.#reniced = false;
			}
			if (this.#group) await this.#setQuota(0);
			return;
		}
		if (wasOff && !this.#group) {
			// Lazy creation happens on the next capped spawn; nothing to do yet.
			const probe = await this.#probe;
			if (!probe.supported) this.#emitNotice(unsupportedText(cores, probe));
			return;
		}
		await this.#setQuota(cores);
	}

	/**
	 * Create the session group on first use and arm the watcher. Returns the
	 * group a spawn should join, or undefined when every budget is off or
	 * enforcement is impossible (already reported; never throws).
	 */
	async ensureGroup(): Promise<CpuBudgetGroupHandle | undefined> {
		if (this.#disposed) return undefined;
		// Before the active check, not after: a limit nobody has told this limiter
		// about yet still has to create the group that will carry it.
		await this.#applyConfiguredLimits();
		if (!this.#anyLimitActive) return undefined;
		if (this.#group) return this.#group;
		if (this.#setupFailed) return undefined;
		this.#ensurePromise ??= this.#createGroup();
		return this.#ensurePromise;
	}

	/**
	 * Move a spawned child into the session group. Fire-and-forget at spawn
	 * sites: membership is inherited across fork (and job-object children
	 * inherit the job), so adopting the direct child caps its whole tree.
	 */
	async adoptPid(pid: number): Promise<void> {
		const group = await this.ensureGroup();
		if (!group) return;
		group.adopt(pid);
	}

	/** Bytes the write budget allows, or Infinity when the budget is off. */
	get #writeLimitBytes(): number {
		return this.#writeBudgetGb > 0 ? this.#writeBudgetGb * BYTES_PER_GB : Number.POSITIVE_INFINITY;
	}

	/**
	 * Synchronously assert that spawn is permitted under current budget limits.
	 * Checks CPU saturation, write limits, PID caps, and memory limits.
	 */
	assertMaySpawn(what: string): void {
		if (this.#denied) {
			throw new CpuLimitDeniedError(
				`Refused to start ${what}: this session's CPU budget of ${this.#cores} core(s) is saturated ` +
					`(spawned commands used ~${this.#lastCoresUsed.toFixed(2)} cores for the last ${this.#windowSeconds()}s). ` +
					`New commands run again once usage drops below the budget. ` +
					`Fix: wait for the running command to finish, or raise session.cpuLimitCores.`,
			);
		}
		if (this.#writeBudgetGb > 0 && this.#writes.totalBytes >= this.#writeLimitBytes) {
			throw new CpuLimitDeniedError(
				`Refused to start ${what}: this session tree's write budget of ${this.#writeBudgetGb} GB is spent ` +
					`(${formatWriteBytes(this.#writes.totalBytes)} written). ` +
					`Fix: raise session.writeBudgetGb, or start a new session.`,
			);
		}
		if (this.#memoryLimitGb > 0 && this.#group && !this.#memoryEnforced) {
			throw new CpuLimitDeniedError(
				`Refused to start ${what}: session.memoryLimitGb is set to ${this.#memoryLimitGb} but a memory cap ` +
					`cannot be enforced on this host (${this.#memoryUnenforceableReason}). Running the command anyway ` +
					`would be unbounded, which is what the limit is set to prevent. ` +
					`Fix: set session.memoryLimitGb to 0, or run where cgroup v2 delegates the memory controller.`,
			);
		}
		if (this.#maxProcesses > 0 && this.#liveMemberCount() >= this.#maxProcesses) {
			throw new CpuLimitDeniedError(
				`Refused to start ${what}: this session tree's process cap of ${this.#maxProcesses} is reached ` +
					`(${this.#liveMemberCount()} live process(es) in the budget group). ` +
					`Fix: wait for a running command to finish, or raise session.maxProcesses.`,
			);
		}
	}

	/**
	 * Refuse a harness tool write that the budget cannot afford, counting the
	 * bytes it is ABOUT to write: a budget that only notices after the write
	 * lets a single oversized write blow through it by any amount.
	 */
	assertMayWrite(bytes: number, what: string): void {
		if (this.#writeBudgetGb <= 0) return;
		const total = this.#writes.totalBytes;
		if (total + bytes <= this.#writeLimitBytes) return;
		throw new WriteBudgetDeniedError(
			`Refused to write ${what}: this session tree's write budget of ${this.#writeBudgetGb} GB does not cover it ` +
				`(${formatWriteBytes(total)} already written, this write is ${formatWriteBytes(bytes)}). ` +
				`Fix: raise session.writeBudgetGb, or start a new session.`,
		);
	}

	/**
	 * Count bytes veyyon's own tools wrote. The harness is not in the budget
	 * group by design, so no group counter will ever see these.
	 */
	recordHarnessWrite(bytes: number): void {
		if (this.#writeBudgetGb <= 0) return;
		this.#writes.recordHarnessWrite(bytes);
		this.#evaluateWriteBudget();
	}

	/** Live processes in the group, from the group itself rather than a stale sample. */
	#liveMemberCount(): number {
		if (!this.#group) return 0;
		try {
			this.#memberCount = this.#group.members().length;
		} catch {
			// A group whose cgroup.procs vanished under us (teardown race) has no
			// members worth refusing over.
		}
		return this.#memberCount;
	}

	get #memoryUnenforceableReason(): string {
		return this.#cgroupDir
			? "the memory controller is not delegated to this session's cgroup"
			: "this backend has no cgroup to write memory.max into";
	}

	/**
	 * The kill report for the episode in flight, consumed once. The bash tool
	 * appends it to a SIGTERM'd command so a budget kill never reads as a
	 * crash.
	 */
	consumeKillReport(): string | undefined {
		const report = this.#lastKillReport;
		this.#lastKillReport = undefined;
		return report;
	}

	/**
	 * One watcher step: sample the group's CPU usage and its disk writes,
	 * update the saturation window and the cumulative write total, and deny,
	 * renice or kill on a breach. Public so tests drive it without waiting on
	 * the interval; the production timer calls it once a second.
	 */
	async pollOnce(): Promise<void> {
		const group = this.#group;
		if (!group || this.#disposed) return;
		this.#memberCount = group.members().length;
		await this.#pollWriteBudget(group);
		if (this.#cores <= 0) return;
		const usageUsec = group.usageUsec();
		if (usageUsec === undefined) return;
		const throttledPeriods = group.throttledPeriods();
		const now = this.#options.env.now();
		const previous = this.#lastSample;
		this.#lastSample = { at: now, usageUsec, throttledPeriods };
		if (!previous) return;
		const elapsedSec = (now - previous.at) / 1_000;
		if (elapsedSec <= 0) return;
		const usageRate = (usageUsec - previous.usageUsec) / elapsedSec;
		this.#lastCoresUsed = Math.max(0, usageRate / 1_000_000);
		// A throttling backend saturates at the quota, so "at the wall" alone
		// cannot tell "the budget is too small" from "fully used but enough".
		// The throttled-period count can: it rises only when demand exceeded the
		// quota. Where the platform does not count throttling (Windows), the
		// wall alone has to do. A policy-only backend has no quota at all, so
		// the signal is plain demand past the budget.
		const throttled =
			throttledPeriods === undefined ||
			previous.throttledPeriods === undefined ||
			throttledPeriods > previous.throttledPeriods;
		const over = group.throttles
			? usageRate >= SATURATION_RATIO * this.#cores * 1_000_000 && throttled
			: usageRate > this.#cores * 1_000_000;
		const windowSize = this.#options.windowSamples ?? CPU_LIMIT_WINDOW_SAMPLES;
		this.#window.push(over);
		if (this.#window.length > windowSize) this.#window.shift();
		const sustained = this.#window.length === windowSize && this.#window.every(flag => flag);
		if (sustained && !this.#denied) {
			this.#denied = true;
			if (this.#killEnabled) {
				this.#killOverBudget();
			} else {
				if (!group.throttles) {
					group.renice(CPU_LIMIT_SATURATION_NICE);
					this.#reniced = true;
				}
				this.#emitNotice(
					`Session CPU budget saturated: limit ${this.#cores} core(s), spawned commands used ` +
						`~${this.#lastCoresUsed.toFixed(2)} cores for ${this.#windowSeconds()}s. ` +
						`New commands are being refused until usage drops. ` +
						`Fix: raise session.cpuLimitCores, or set session.cpuLimitKill to terminate over-budget commands instead.`,
				);
			}
		} else if (!sustained && this.#denied) {
			this.#denied = false;
			this.#killedThisEpisode = false;
			if (this.#reniced) {
				group.renice(0);
				this.#reniced = false;
			}
		}
	}

	/**
	 * Read the spawned half of this group's writes and re-judge the budget.
	 * Runs on every tick while the budget is on, INCLUDING while a process is
	 * still alive, because `/proc/<pid>/io` disappears with the process and a
	 * once-at-exit reading would lose everything a finished command wrote.
	 */
	async #pollWriteBudget(group: CpuBudgetGroupHandle): Promise<void> {
		if (this.#writeBudgetGb <= 0) return;
		const sample = await sampleSpawnedWrites({
			cgroupDir: this.#cgroupDir,
			procRoot: this.#options.env.procRoot,
			members: group.members(),
		});
		this.#writes.applySample(sample);
		if (sample.source === "none") {
			this.#emitNoticeOnce(
				"write-source",
				`session.writeBudgetGb is set to ${this.#writeBudgetGb} but the SPAWNED half of it cannot be ` +
					`metered on this host: the budget group has no readable io.stat and no readable /proc/<pid>/io. ` +
					`veyyon's own write and edit tools are still counted and still refused past the budget; ` +
					`bytes written by commands are not.`,
			);
		}
		this.#evaluateWriteBudget();
	}

	/**
	 * Latch the over-budget verdict, notice once, and kill once when the
	 * operator asked for it. A cumulative total never falls, so there is no
	 * recovery edge to mirror: over is over until the budget is raised.
	 */
	#evaluateWriteBudget(): void {
		if (this.#writeBudgetGb <= 0) return;
		const total = this.#writes.totalBytes;
		if (total < this.#writeLimitBytes) return;
		const wasOver = this.#writeOverBudget;
		this.#writeOverBudget = true;
		if (this.#writeBudgetKill) {
			this.#killOverWriteBudget(total);
			return;
		}
		if (wasOver) return;
		this.#emitNotice(
			`Session write budget exceeded: limit ${this.#writeBudgetGb} GB, this session tree has written ` +
				`${formatWriteBytes(total)} (${formatWriteBytes(this.#writes.harnessBytes)} by veyyon's tools, ` +
				`${formatWriteBytes(this.#writes.spawnedBytes)} by spawned commands, metered from ${this.#writes.source}). ` +
				`Further writes and new commands are refused. ` +
				`Fix: raise session.writeBudgetGb, or set session.writeBudgetKill to terminate the over-budget commands.`,
		);
	}

	/** SIGTERM the group once for a spent write budget, reported as a budget action. */
	#killOverWriteBudget(total: number): void {
		if (this.#writeKilledThisEpisode || !this.#group) return;
		this.#writeKilledThisEpisode = true;
		let killed = 0;
		for (const pid of this.#group.members()) {
			try {
				this.#options.env.kill(pid, "SIGTERM");
				killed++;
			} catch {
				// The process exited between listing and signal; nothing to report.
			}
		}
		const report =
			`Session write budget exceeded: limit ${this.#writeBudgetGb} GB, this session tree has written ` +
			`${formatWriteBytes(total)}. Sent SIGTERM to ${killed} process(es) because session.writeBudgetKill is on. ` +
			`A command that just stopped was killed by the write budget, not a crash.`;
		this.#lastKillReport = report;
		this.#emitNotice(report);
	}

	/**
	 * Whether this limiter has been retired. A retired limiter holds no group,
	 * no watcher and no unit, and nothing may resolve it again; the rekey path
	 * retires the limiter it supersedes, and this is how that is checked.
	 */
	get disposed(): boolean {
		return this.#disposed;
	}

	/** Stop the watcher and release the group. Surviving children are reparented, never killed. */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		await this.#releaseGroup();
	}

	/**
	 * Stop the transient unit, if any, and release the group handle.
	 *
	 * Shared with the disposed-mid-creation path in `#createGroup`, which has a
	 * group `dispose()` never saw.
	 */
	async #releaseGroup(): Promise<void> {
		if (this.#systemdUnit) {
			await this.#options.env
				.run(["systemctl", "--user", "stop", this.#systemdUnit])
				.catch(error => logger.debug("CPU limit: unit stop failed", { error: errorMessage(error) }));
			this.#systemdUnit = undefined;
		}
		this.#group?.dispose();
		this.#group = undefined;
	}

	#windowSeconds(): number {
		return (
			((this.#options.windowSamples ?? CPU_LIMIT_WINDOW_SAMPLES) *
				(this.#options.watchIntervalMs ?? CPU_LIMIT_WATCH_INTERVAL_MS)) /
			1_000
		);
	}

	#emitNotice(text: string): void {
		this.#options.onNotice?.(text);
		logger.warn("CPU limit", { text });
	}

	/** Report `text` at most once per `key`, so a refused limit does not narrate every attempt. */
	#emitNoticeOnce(key: string, text: string): void {
		if (this.#noticed.has(key)) return;
		this.#noticed.add(key);
		this.#emitNotice(text);
	}

	async #createGroup(): Promise<CpuBudgetGroupHandle | undefined> {
		const probe = await this.#probe;
		if (!probe.supported || !probe.backend) return undefined;
		const create = this.#options.createGroup ?? createNativeBudgetGroup;
		try {
			if (probe.backend.kind === "systemd-run") {
				const unitBase = this.budgetName;
				const unit = `${unitBase}.service`;
				// A transient SERVICE, never `--scope`. `systemd-run --scope` runs the command in the
				// foreground, so with a `sleep infinity` placeholder it never returns: the 10s execFile
				// deadline killed it, setup was marked failed for the whole session, and the budget
				// silently did nothing on every host that reached this backend. A service forks, so
				// systemd-run returns as soon as the unit is registered and the quota is in place.
				const launched = await this.#options.env.run([
					"systemd-run",
					"--user",
					"--quiet",
					"--collect",
					`--unit=${unitBase}`,
					// A group can exist for the write, process or memory limit with
					// no CPU limit at all, and `CPUQuota=0%` is a quota of no CPU
					// rather than an absent one.
					...(this.#cores > 0 ? ["-p", `CPUQuota=${this.#cores * 100}%`] : []),
					"--",
					"sleep",
					"infinity",
				]);
				if (launched.code !== 0) {
					throw new Error(`systemd-run failed: ${launched.stderr.trim() || `exit ${launched.code}`}`);
				}
				const shown = await this.#options.env.run([
					"systemctl",
					"--user",
					"show",
					unit,
					"-p",
					"ControlGroup",
					"--value",
				]);
				const relative = shown.stdout.trim();
				if (shown.code !== 0 || !relative.startsWith("/")) {
					throw new Error(`could not resolve the unit cgroup: ${shown.stderr.trim() || "empty ControlGroup"}`);
				}
				this.#systemdUnit = unit;
				this.#cgroupDir = path.join(this.#options.env.cgroupRoot, relative);
				this.#group = create({
					name: this.budgetName,
					cores: this.#cores,
					existingCgroupDir: this.#cgroupDir,
				});
			} else if (probe.backend.kind === "direct") {
				// The native Linux backend creates `<parent>/<name>`; the other
				// three limits are ordinary files in that same directory, so the
				// path is derived here rather than round-tripped through napi.
				this.#cgroupDir = path.join(probe.backend.parentDir, this.budgetName);
				this.#group = create({
					name: this.budgetName,
					cores: this.#cores,
					cgroupParentDir: probe.backend.parentDir,
				});
			} else {
				this.#group = create({ name: this.budgetName, cores: this.#cores });
			}
			// dispose() can land while the probe, systemd-run or systemctl above is
			// in flight, on `/exit` or `/new` during the first capped command, which
			// is exactly when this runs. It found #group undefined and had nothing
			// to release, so without this the group is created after the session is
			// gone and a setInterval polls it for the life of the process.
			if (this.#disposed) {
				await this.#releaseGroup();
				return undefined;
			}
			await this.#applyCgroupResourceLimits();
			this.#startWatcher();
			return this.#group;
		} catch (error) {
			this.#setupFailed = true;
			this.#emitNotice(
				`session.cpuLimitCores is set to ${this.#cores} but the session CPU budget group could not be created: ` +
					`${errorMessage(error)}. Spawned commands will run uncapped.`,
			);
			return undefined;
		}
	}

	/**
	 * Apply `pids.max` and `memory.max` to the live cgroup.
	 * Probes controller delegation directly on write, falling back to policy checks on failure.
	 */
	async #applyCgroupResourceLimits(): Promise<void> {
		if (!this.#group) return;
		const dir = this.#cgroupDir;
		if (!dir) {
			this.#pidsEnforced = false;
			this.#memoryEnforced = false;
			if (this.#memoryLimitGb > 0) {
				this.#emitNoticeOnce(
					"memory-unenforceable",
					`session.memoryLimitGb is set to ${this.#memoryLimitGb} but this host has no cgroup to write ` +
						`memory.max into, so a memory cap cannot be enforced. New commands are refused rather than ` +
						`run unbounded. Fix: set session.memoryLimitGb to 0.`,
				);
			}
			return;
		}
		this.#pidsEnforced = await this.#writeCgroupFile(dir, "pids.max", limitFileValue(this.#maxProcesses));
		this.#memoryEnforced = await this.#writeCgroupFile(
			dir,
			"memory.max",
			limitFileValue(this.#memoryLimitGb > 0 ? this.#memoryLimitGb * BYTES_PER_GB : 0),
		);
		if (this.#maxProcesses > 0 && !this.#pidsEnforced) {
			this.#emitNoticeOnce(
				"pids-unenforceable",
				`session.maxProcesses is set to ${this.#maxProcesses} but the pids controller is not delegated to ` +
					`this session's cgroup, so the kernel will not cap forks. veyyon still refuses to START a new ` +
					`command past the cap; a process that forks on its own is not stopped.`,
			);
		}
		if (this.#memoryLimitGb > 0 && !this.#memoryEnforced) {
			this.#emitNoticeOnce(
				"memory-unenforceable",
				`session.memoryLimitGb is set to ${this.#memoryLimitGb} but the memory controller is not delegated ` +
					`to this session's cgroup, so memory.max cannot be written and a memory cap cannot be enforced. ` +
					`New commands are refused rather than run unbounded. ` +
					`Fix: set session.memoryLimitGb to 0, or run where cgroup v2 delegates the memory controller.`,
			);
		}
	}

	async #writeCgroupFile(dir: string, file: string, value: string): Promise<boolean> {
		try {
			await fs.writeFile(path.join(dir, file), value);
			return true;
		} catch (error) {
			logger.debug("Session budget: controller file not writable", {
				file: path.join(dir, file),
				error: errorMessage(error),
			});
			return false;
		}
	}

	/** Re-express the quota for a changed core count (0 lifts it). */
	async #setQuota(cores: number): Promise<void> {
		try {
			if (this.#systemdUnit) {
				const quota = cores > 0 ? `CPUQuota=${cores * 100}%` : "CPUQuota=";
				await this.#options.env.run(["systemctl", "--user", "set-property", this.#systemdUnit, quota]);
			} else {
				this.#group?.setCores(cores);
			}
		} catch (error) {
			logger.warn("CPU limit: failed to update quota", { error: errorMessage(error) });
		}
	}

	#startWatcher(): void {
		if (this.#timer) return;
		const intervalMs = this.#options.watchIntervalMs ?? CPU_LIMIT_WATCH_INTERVAL_MS;
		this.#timer = setInterval(() => {
			this.pollOnce().catch(error => logger.warn("CPU limit watcher tick failed", { error: errorMessage(error) }));
		}, intervalMs);
		this.#timer.unref();
	}

	#killOverBudget(): void {
		if (this.#killedThisEpisode || !this.#group) return;
		this.#killedThisEpisode = true;
		let killed = 0;
		for (const pid of this.#group.members()) {
			try {
				this.#options.env.kill(pid, "SIGTERM");
				killed++;
			} catch {
				// The process exited between listing and signal; nothing to report.
			}
		}
		const report =
			`Session CPU budget exceeded: limit ${this.#cores} core(s), spawned commands used ` +
			`~${this.#lastCoresUsed.toFixed(2)} cores for ${this.#windowSeconds()}s. Sent SIGTERM to ${killed} process(es) ` +
			`because session.cpuLimitKill is on. A command that just stopped was killed by the CPU budget, not a crash.`;
		this.#lastKillReport = report;
		this.#emitNotice(report);
	}
}

/** The startup warning when a configured limit cannot be enforced. */
function unsupportedText(cores: number, probe: CpuLimitProbe): string {
	return (
		`session.cpuLimitCores is set to ${cores} but a CPU limit cannot be enforced here: ${probe.detail}. ` +
		`Spawned commands will run uncapped.`
	);
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

const limiters = new Map<string, SessionCpuLimit>();
/** Registration order, so the root session's limiter is findable for shared workers. */
const registrationOrder: string[] = [];

/**
 * Maps alias session IDs to their owner session ID.
 * Kept distinct from `limiters` so subagent disposal does not tear down root groups.
 */
const aliasOwners = new Map<string, string>();
/** The reverse index, so retiring or rekeying an owner can find its aliases. */
const aliasesByOwner = new Map<string, Set<string>>();

/**
 * The limiter for a live session, undefined before registration or after
 * dispose. An alias resolves to the group it borrows, which is what makes a
 * subagent's spawns land in the root session tree's budget.
 */
export function sessionCpuLimit(sessionId: string | null | undefined): SessionCpuLimit | undefined {
	if (!sessionId) return undefined;
	const owned = limiters.get(sessionId);
	if (owned) return owned;
	const owner = aliasOwners.get(sessionId);
	return owner ? limiters.get(owner) : undefined;
}

/**
 * Returns the owning session tree ID for a session (self for root, owner for aliases).
 * Canonical session identifier for budget grouping and shared tree resources.
 */
export function sessionTreeId(sessionId: string | null | undefined): string | undefined {
	if (!sessionId) return undefined;
	if (limiters.has(sessionId)) return sessionId;
	const owner = aliasOwners.get(sessionId);
	return owner !== undefined && limiters.has(owner) ? owner : undefined;
}

/** Drop one alias, leaving the group it borrowed untouched. */
function unregisterAlias(aliasId: string): boolean {
	const owner = aliasOwners.get(aliasId);
	if (owner === undefined) return false;
	aliasOwners.delete(aliasId);
	const siblings = aliasesByOwner.get(owner);
	siblings?.delete(aliasId);
	if (siblings?.size === 0) aliasesByOwner.delete(owner);
	return true;
}

/**
 * Rekey a budget limiter and its aliases when a session ID changes (e.g. `/new`, `/resume`, forks).
 * Preserves the underlying group and adopted processes across ID changes.
 */
export function rekeySessionCpuLimit(previousId: string, nextId: string): SessionCpuLimit | undefined {
	if (previousId === nextId) return sessionCpuLimit(nextId);
	if (aliasOwners.has(previousId)) {
		const owner = aliasOwners.get(previousId);
		unregisterAlias(previousId);
		if (owner !== undefined && limiters.has(owner)) {
			aliasOwners.set(nextId, owner);
			aliasesByOwner.get(owner)?.add(nextId);
		}
		return sessionCpuLimit(nextId);
	}
	const limiter = limiters.get(previousId);
	if (!limiter) return sessionCpuLimit(nextId);
	const unregister = (id: string): void => {
		limiters.delete(id);
		const at = registrationOrder.indexOf(id);
		if (at >= 0) registrationOrder.splice(at, 1);
	};
	const occupant = limiters.get(nextId);
	if (occupant) {
		// The id being moved onto already has its own limiter, so the source is
		// now unreachable: nothing resolves it, and the session it belonged to
		// is gone. Left in the map it kept a cgroup, a transient systemd unit
		// and a once-a-second watcher alive for the life of the process, and,
		// being first in registration order, it kept collecting every shared
		// spawn (language servers, the browser, service workers) into a budget
		// no live session could see or lift.
		unregister(previousId);
		for (const alias of aliasesByOwner.get(previousId) ?? new Set<string>()) aliasOwners.delete(alias);
		aliasesByOwner.delete(previousId);
		void limiter
			.dispose()
			.catch(error =>
				logger.debug("CPU limit: retiring a superseded limiter failed", { error: errorMessage(error) }),
			);
		return occupant;
	}
	// A live session taking over an id that was somebody's alias: the real
	// registration wins, or the map would answer two ways for one id.
	unregisterAlias(nextId);
	// In place, not delete-then-append: registration order is what
	// `primarySessionCpuLimit` reads, so moving the root session to the back on
	// `/new` would hand every shared spawn to a different session's budget.
	limiters.delete(previousId);
	limiters.set(nextId, limiter);
	const index = registrationOrder.indexOf(previousId);
	if (index >= 0) registrationOrder[index] = nextId;
	const aliases = aliasesByOwner.get(previousId);
	if (aliases) {
		aliasesByOwner.delete(previousId);
		aliasesByOwner.set(nextId, aliases);
		for (const alias of aliases) aliasOwners.set(alias, nextId);
	}
	return limiter;
}

/**
 * An adoption closure for spawn sites that know their session only by a
 * live id lookup. Resolves the limiter at each call, so a limiter registered
 * after the closure is created (session construction order) still applies.
 */
export function sessionCpuAdoption(getSessionId: () => string | null): (pid: number) => void {
	return pid => {
		const limiter = sessionCpuLimit(getSessionId());
		if (!limiter) return;
		void limiter
			.adoptPid(pid)
			.catch(error => logger.debug("CPU limit: adoption failed", { error: errorMessage(error) }));
	};
}

/**
 * Adopt a PID into the primary root session budget.
 * Used for shared long-lived processes like language servers, debuggers, and workers.
 */
export function adoptIntoPrimarySessionCpuBudget(pid: number): void {
	const limiter = primarySessionCpuLimit();
	if (!limiter) return;
	void limiter
		.adoptPid(pid)
		.catch(error => logger.debug("CPU limit: adoption failed", { error: errorMessage(error) }));
}

/** The closure form of {@link adoptIntoPrimarySessionCpuBudget}, for `onSpawnPid` hooks. */
export function primarySessionCpuAdoption(): (pid: number) => void {
	return adoptIntoPrimarySessionCpuBudget;
}

/**
 * The session id that OWNS the root budget group, for a spawn path that knows
 * it is starting a subagent but was not told whose child it is. Aliases are
 * never in `registrationOrder`, so this is always a real owner.
 */
export function rootBudgetGroupOwnerId(): string | undefined {
	return registrationOrder[0];
}

/**
 * The first registered (root) session's limiter. Shared harness worker
 * subprocesses (tiny title model, embeddings, speech) serve every session and
 * belong to no single one, so they join the root session's budget.
 */
export function primarySessionCpuLimit(): SessionCpuLimit | undefined {
	const first = registrationOrder[0];
	return first ? limiters.get(first) : undefined;
}

let cachedProbe: Promise<CpuLimitProbe> | undefined;

/** The process-wide probe result, computed once. */
export function probeSessionCpuLimitSupport(env?: CpuLimitEnvironment): Promise<CpuLimitProbe> {
	if (env) return probeCpuLimitSupport(env);
	cachedProbe ??= defaultResolvedEnvironment().then(probeCpuLimitSupport);
	return cachedProbe;
}

/** Reset the registry and probe cache. Test-only. */
export function resetSessionCpuLimitsForTests(): void {
	limiters.clear();
	registrationOrder.length = 0;
	aliasOwners.clear();
	aliasesByOwner.clear();
	cachedProbe = undefined;
}

/**
 * Storage for propagating the inherited root budget group ID to newly constructed sessions.
 * Allows nested sessions to alias root budgets without explicit parameter plumbing.
 */
const inheritedBudgetGroup = new AsyncLocalStorage<string>();

/**
 * Run `fn` with newly created sessions inheriting `rootSessionId`'s budget group as aliases.
 * Supports arbitrary subagent nesting depths.
 */
export function withInheritedBudgetGroup<T>(rootSessionId: string | null | undefined, fn: () => T): T {
	if (!rootSessionId) return fn();
	return inheritedBudgetGroup.run(rootSessionId, fn);
}

/** The owner id a session registering now should alias, or undefined for a root. */
function pinnedBudgetOwner(sessionId: string): string | undefined {
	const pinned = inheritedBudgetGroup.getStore();
	if (!pinned || pinned === sessionId) return undefined;
	const owner = limiters.has(pinned) ? pinned : aliasOwners.get(pinned);
	if (owner === undefined) return undefined;
	return limiters.get(owner)?.disposed === false ? owner : undefined;
}

export interface InitSessionCpuLimitOptions extends SessionBudgetLimits {
	sessionId: string;
	cores: number;
	kill: boolean;
	onNotice: (text: string) => void;
	env?: CpuLimitEnvironment;
}

/**
 * Initialize and register a session's budget limiter, or attach as an alias if inside an inherited scope.
 * Warns if configured limits are unenforceable on the host.
 */
export async function initSessionCpuLimit(options: InitSessionCpuLimitOptions): Promise<SessionCpuLimit> {
	const existing = limiters.get(options.sessionId);
	if (existing) {
		await existing.update(options.cores, options.kill, options);
		return existing;
	}
	const owner = pinnedBudgetOwner(options.sessionId);
	const inherited = owner === undefined ? undefined : limiters.get(owner);
	if (owner !== undefined && inherited) {
		aliasOwners.set(options.sessionId, owner);
		let siblings = aliasesByOwner.get(owner);
		if (!siblings) {
			siblings = new Set<string>();
			aliasesByOwner.set(owner, siblings);
		}
		siblings.add(options.sessionId);
		return inherited;
	}
	const env = options.env ?? defaultCpuLimitEnvironment();
	const probe = probeSessionCpuLimitSupport(options.env);
	const limiter = new SessionCpuLimit({
		sessionId: options.sessionId,
		cores: options.cores,
		kill: options.kill,
		writeBudgetGb: options.writeBudgetGb,
		writeBudgetKill: options.writeBudgetKill,
		maxProcesses: options.maxProcesses,
		memoryLimitGb: options.memoryLimitGb,
		probe,
		env,
		onNotice: options.onNotice,
	});
	limiters.set(options.sessionId, limiter);
	registrationOrder.push(options.sessionId);
	if (options.cores > 0) {
		const result = await probe;
		if (!result.supported) options.onNotice(unsupportedText(options.cores, result));
	}
	if ((options.memoryLimitGb ?? 0) > 0) {
		const result = await probe;
		if (!result.kernelLimits.memory) {
			options.onNotice(
				`session.memoryLimitGb is set to ${options.memoryLimitGb} but the memory controller is not ` +
					`available here (${result.detail}), so a memory cap cannot be enforced. New commands will be ` +
					`refused rather than run unbounded. Fix: set session.memoryLimitGb to 0.`,
			);
		}
	}
	return limiter;
}

registerOwnedResourceDisposer({
	name: "session-cpu-limit",
	scope: "session",
	dispose: async ownerId => {
		// A subagent finishing must not tear down the group its whole tree is
		// still enforcing against: an alias drops its own entry and nothing else.
		if (unregisterAlias(ownerId)) return;
		const limiter = limiters.get(ownerId);
		if (!limiter) return;
		limiters.delete(ownerId);
		const index = registrationOrder.indexOf(ownerId);
		if (index >= 0) registrationOrder.splice(index, 1);
		// The owner's group is going away, so its borrowers must stop resolving
		// to it rather than holding a disposed limiter.
		for (const alias of aliasesByOwner.get(ownerId) ?? new Set<string>()) aliasOwners.delete(alias);
		aliasesByOwner.delete(ownerId);
		await limiter.dispose();
	},
});

// ---------------------------------------------------------------------------
// Production environment
// ---------------------------------------------------------------------------

let cachedOwnCgroupPath: string | undefined;

async function ownCgroupPath(): Promise<string> {
	if (cachedOwnCgroupPath !== undefined) return cachedOwnCgroupPath;
	const text = await readOptional("/proc/self/cgroup");
	// cgroup v2 collapses the hierarchy to one line: `0::/user.slice/...`.
	const v2Line = text?.split("\n").find(line => line.startsWith("0::"));
	cachedOwnCgroupPath = v2Line ? v2Line.slice(3).trim() : "";
	return cachedOwnCgroupPath;
}

async function defaultResolvedEnvironment(): Promise<CpuLimitEnvironment> {
	return { ...defaultCpuLimitEnvironment(), ownCgroupPath: await ownCgroupPath() };
}

function runHostCommand(cmd: string[]): Promise<CpuLimitCommandResult> {
	const { promise, resolve } = Promise.withResolvers<CpuLimitCommandResult>();
	// `execFile` can fault SYNCHRONOUSLY, before it ever returns a promise or calls back: a
	// spawn implementation that rejects the argument shape, EMFILE, a bad executable path. Every
	// caller treats this as "the host cannot answer" and guards the async rejection only, so a
	// synchronous throw escapes past those guards as an unhandled error and takes the process
	// down while a probe of an OPTIONAL capability is all that failed. A failed spawn is a
	// nonzero exit with the reason on stderr, which is exactly what the callers already read.
	try {
		execFile(cmd[0], cmd.slice(1), { timeout: 10_000 }, (error, stdout, stderr) => {
			const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || "") });
		});
	} catch (error) {
		resolve({ code: 1, stdout: "", stderr: errorMessage(error) });
	}
	return promise;
}

/** The production environment: real /sys/fs/cgroup, real systemctl, real SIGTERM. */
export function defaultCpuLimitEnvironment(): CpuLimitEnvironment {
	return {
		platform: process.platform,
		uid: typeof process.getuid === "function" ? process.getuid() : -1,
		cgroupRoot: "/sys/fs/cgroup",
		ownCgroupPath: "",
		procRoot: "/proc",
		run: runHostCommand,
		kill: (pid, signal) => process.kill(pid, signal),
		now: () => Date.now(),
		removeDir: dir => fs.rmdir(dir),
	};
}

// ---------------------------------------------------------------------------
// Harness write accounting
// ---------------------------------------------------------------------------

/**
 * What the write and edit tools need to charge their bytes to the right
 * budget. The session id is read per call rather than captured, because the
 * tool outlives an id change (`/new`, a branch) and the limiter follows it.
 */
export interface HarnessWriteSource {
	sessionId(): string | null;
	limits(): SessionBudgetLimits;
}

/**
 * Wrap a file-commit callback to enforce and record write budget usage for in-process tools.
 * Tracks harness write operations that bypass OS cgroup metrics.
 */
export function budgetedFileCommit<A extends unknown[], R>(
	source: HarnessWriteSource,
	commit: (dst: string, content: string, ...rest: A) => Promise<R>,
): (dst: string, content: string, ...rest: A) => Promise<R> {
	return async (dst, content, ...rest) => {
		const limiter = sessionCpuLimit(source.sessionId());
		const bytes = Buffer.byteLength(content, "utf8");
		if (limiter) {
			await limiter.updateLimits(source.limits());
			limiter.assertMayWrite(bytes, dst);
		}
		const result = await commit(dst, content, ...rest);
		// After the commit, and only on success: a refused or failed write costs
		// the operator no disk, and charging for it would make a full disk look
		// like a spent budget.
		limiter?.recordHarnessWrite(bytes);
		return result;
	};
}

/**
 * The three non-CPU limits as the operator set them. One reader so every
 * gate (bash, launch, the write and edit tools) sees the same values, and so
 * a new row is wired in one place rather than four.
 */
export function sessionBudgetLimits(settings: Settings): SessionBudgetLimits {
	return {
		writeBudgetGb: settings.get("session.writeBudgetGb"),
		writeBudgetKill: settings.get("session.writeBudgetKill"),
		maxProcesses: settings.get("session.maxProcesses"),
		memoryLimitGb: settings.get("session.memoryLimitGb"),
	};
}

/**
 * Read configured non-CPU budget limits from global settings without loading dependencies.
 * Returns undefined if settings are not yet loaded.
 */
function configuredBudgetLimits(): SessionBudgetLimits | undefined {
	const settings = settingsOrNull();
	return settings ? sessionBudgetLimits(settings) : undefined;
}
