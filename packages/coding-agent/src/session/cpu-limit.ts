/**
 * The per-session-TREE budget group: CPU, disk writes, live processes, memory.
 *
 * The file is still called cpu-limit.ts and still exports `sessionCpuLimit` /
 * `initSessionCpuLimit`, because dozens of spawn sites resolve those names and
 * a rename is churn. What it actually is now is one budget group per session
 * tree with four policies hanging off it, so read `SessionCpuLimit` as "the
 * session's budget", not "the session's CPU limiter".
 *
 * WHAT THIS CAPS. Every OS process a session spawns: bash commands (brush
 * shells and the interactive PTY), MCP stdio servers, custom tool and hook
 * `exec` calls, `launch` background processes, and the shared worker
 * subprocesses. WHAT IT NEVER CAPS: the harness process itself. The budget
 * group never contains the harness, so in-process compute (agent turns, Bun
 * Worker threads such as the JS eval worker, shell builtins) is unaffected.
 * Shared harness service workers (tiny title model, embeddings, speech)
 * belong to no single session, so they join the root session's budget. The
 * one thing the harness DOES contribute is its own tool writes, which it
 * reports into the group's write accountant, because no group counter can see
 * a process that is not in the group.
 *
 * ONE GROUP PER SESSION TREE, NOT PER AGENT. A subagent opens its own
 * `SessionManager` and therefore its own `AgentSession`, so registering by
 * session id alone gave every subagent a group of its own and multiplied the
 * operator's cap by the number of live subagents. The task executor pins an
 * inherited group id around subagent session creation
 * ({@link withInheritedBudgetGroup}); a session that registers inside that
 * scope becomes an ALIAS of the root group instead of an owner of a new one,
 * at any depth. Aliases live in their own table, never in `limiters` or
 * `registrationOrder`: pointing a child id at the root limiter object would
 * make the first child to finish tear the root group down through the
 * owned-resource disposer, and would let `rekeySessionCpuLimit` mistake an
 * alias for a superseded occupant and dispose the root on `/new`.
 *
 * OWNERSHIP SPLIT WITH THE NATIVE SIDE. This module owns POLICY: probing the
 * host, picking a backend, the once-a-second watcher, deny/kill decisions,
 * and lifecycle. The OS mechanics (create the group, adopt a pid, read
 * usage, tear down) live in `veyyon_shell::cpu_budget`, reached through the
 * `CpuBudgetGroup` napi class, because the spawn points that first see a
 * child pid (the brush spawn observer, the PTY spawner) are native. Policy
 * never crosses into Rust; syscalls never appear here. The three newer limits
 * are the documented exception: `pids.max`, `memory.max` and `io.stat` are
 * ordinary reads and writes of files in a directory this side already knows
 * the path of, exactly like the delegation probe below, so they stay here
 * rather than growing a native surface for four file operations.
 *
 * BACKENDS, PROBED ONCE PER PROCESS. Linux: a cgroup v2 directory written
 * directly when a delegated parent is writable, else a `systemd-run --user`
 * transient service when a user manager answers. Windows: a Job Object with a hard CPU
 * rate cap. macOS: no per-group quota exists, so the budget is POLICY-ONLY
 * (the watcher refuses new commands, renices the group, and optionally
 * kills) and `throttles` is false so the settings row and startup warning
 * say so. Anything else: unsupported, reported, never silently off.
 *
 * WHICH LIMIT EACH BACKEND ACTUALLY ENFORCES, and what happens where it
 * cannot. Delegation is per controller and is NOT implied by the backend: a
 * stock systemd user session delegates `cpu memory pids` and not `io`, so the
 * probe tests each controller for real against a probe child instead of
 * assuming one implies another.
 *
 * - CPU: kernel `cpu.max` (cgroup) or the Job Object rate cap; policy-only on
 *   macOS. Over budget refuses new spawns, and kills with `cpuLimitKill`.
 * - Disk writes: metered from `io.stat` where the `io` controller is
 *   delegated, else summed from `/proc/<pid>/io` over the group's members,
 *   plus the harness's own tool writes either way. Over budget refuses new
 *   spawns AND further tool writes, and kills with `writeBudgetKill`. A host
 *   with neither spawned source still enforces the harness half and says the
 *   spawned half is unenforceable.
 * - Processes: kernel `pids.max` where writable. The refusal is policy in
 *   every case, because a fork failing with EAGAIN does not tell an operator
 *   which budget they hit.
 * - Memory: kernel `memory.max` where writable, and nothing else can stand in
 *   for it. Exceeding it makes the kernel reclaim and then OOM-kill INSIDE the
 *   group, which is the enforcement; there is no kill knob because the kernel
 *   already owns that decision. Where `memory.max` is not writable the limit
 *   is reported unenforceable and new spawns are refused, because silently
 *   running unbounded is the one thing a memory cap is set to prevent.
 *
 * THE KERNEL CAP IS THE ENFORCEMENT OF LAST RESORT on Linux and Windows. The
 * watcher is only the policy layer: if it lags or dies, the group keeps
 * throttling. A watcher gap means slower, never uncapped.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CpuBudgetGroup as NativeCpuBudgetGroup } from "@veyyon/natives";
// Owners, not the `@veyyon/utils` barrel: 2 modules against 81.
import { formatBytes, formatCount } from "@veyyon/utils/format";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { Settings } from "../config/settings";
import { settingsOrNull } from "../config/settings-instance";
import { formatLimitFileValue, formatSystemdCpuQuota, memoryCapControls } from "./cgroup-format";
import {
	type CpuLimitEnvironment,
	type CpuLimitProbe,
	probeCpuLimitSupport,
	resolveCpuLimitEnvironment,
} from "./cgroup-host";
import {
	addMachineHarnessWrite,
	anyMachineLimitActive,
	ensureMachineBudget,
	type MachineBudgetLimits,
	type MachineBudgetPlacement,
	machineBudgetLimits,
	machineHarnessWrittenBytes,
	machineSpawnedWrittenBytes,
} from "./machine-budget";
import { registerOwnedResourceDisposer } from "./owned-resources";
import { BYTES_PER_GB, type SpawnedWriteSource, sampleSpawnedWrites, WriteAccountant } from "./write-accounting";

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

/**
 * Thrown by spawn paths when a budget refuses a new process: the CPU watcher
 * is in a saturated window, the write budget is spent, the process cap is
 * reached, or a configured limit cannot be enforced on this host at all. One
 * error type because every spawn site already catches it and the operator
 * reads the message, not the class.
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
	/**
	 * The MACHINE group this session's group sits inside, when one exists.
	 * Undefined on every host and configuration with no machine tier, which is
	 * what makes every machine check below a no-op there.
	 */
	#machineDir: string | undefined;
	/** The machine write budget in GB, 0 when none is set. Read with the placement. */
	#machineWriteBudgetGb = 0;
	/** Bytes the machine cgroup subtree has written, from the last watcher sample. */
	#machineSpawnedWrittenBytes = 0;
	#setupFailed = false;
	#timer: NodeJS.Timeout | undefined;
	#lastSample: WatcherSample | undefined;
	#window: boolean[] = [];
	#denied = false;
	/** 0 idle, 1 SIGTERM sent this episode, 2 SIGKILL sent. */
	#killWave = 0;
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
	/**
	 * Whether the MACHINE tier has any limit set. Read once here, synchronously
	 * from the global config, because it decides whether a group is created at
	 * all — a question that has to be answered before the first spawn, not
	 * after the async placement resolves.
	 */
	readonly #machineLimitActive: boolean;

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
		// An unreadable global config is reported by the placement, which names
		// the file. Here it must only decide whether to bother with a group, and
		// "no machine limit" is the safe reading of a config nobody can parse.
		let machineLimits: MachineBudgetLimits | undefined;
		try {
			machineLimits = machineBudgetLimits();
		} catch {
			machineLimits = undefined;
		}
		this.#machineLimitActive = machineLimits !== undefined && anyMachineLimitActive(machineLimits);
		this.#machineWriteBudgetGb = machineLimits?.writeBudgetGb ?? 0;
		this.#probe = Promise.resolve(options.probe);
	}

	/**
	 * Apply the operator's non-CPU limits when no gate has supplied them yet.
	 *
	 * `agent-session.ts` registers a session with cores and kill only, so a
	 * session that never runs bash, launch, write or edit would reach a spawn
	 * with the disk, memory and process caps still unset: an eval kernel or an
	 * MCP server would join a group carrying no `memory.max` and no `pids.max`,
	 * and a runaway allocation in a Python cell would meet no ceiling at all.
	 *
	 * A gate that DOES supply limits wins permanently, because a subagent's
	 * cloned settings are a better answer than the process-wide singleton.
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
		if (!probe.supported)
			return `configured for ${formatCount("core", this.#cores)} but unavailable: ${probe.detail}${suffix}`;
		if (this.#setupFailed)
			return `configured for ${formatCount("core", this.#cores)} but group setup failed${suffix}`;
		const mode = probe.throttles ? "kernel-throttled" : "policy-only (no kernel throttle on this OS)";
		const state = this.#group ? "enforcing" : "armed, group created on first spawn";
		return `${formatCount("core", this.#cores)}, ${mode}, via ${probe.detail}; ${state}${this.#denied ? "; saturated, refusing new commands" : ""}${suffix}`;
	}

	#extraStatusParts(): string[] {
		const parts: string[] = [];
		if (this.#writeBudgetGb > 0) {
			const source =
				this.#writes.source === "none"
					? "harness tool writes only, spawned writes unmeterable here"
					: `spawned writes via ${this.#writes.source}`;
			parts.push(`write budget ${this.#writeBudgetGb} GB, ${formatBytes(this.#writes.totalBytes)} used (${source})`);
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
	 * Whether ANY limit is set, at EITHER scope. The group exists for the union
	 * of them, not for CPU alone: a write budget needs the group's `io.stat`
	 * and member list, a process cap needs `pids.max`, and a memory cap needs
	 * `memory.max`, none of which exist without a group.
	 *
	 * A machine limit counts even when every session limit is 0. The machine
	 * cgroup bounds its MEMBERS, and the only things that ever become members
	 * are processes adopted into a session group inside it — so without a
	 * session group there is nothing in the machine group and the machine limit
	 * bounds an empty set. Leaving this out is the silent failure where the
	 * setting is written, the cgroup exists with the right quota, and every
	 * command runs outside it.
	 */
	get #anyLimitActive(): boolean {
		return (
			this.#cores > 0 ||
			this.#writeBudgetGb > 0 ||
			this.#maxProcesses > 0 ||
			this.#memoryLimitGb > 0 ||
			this.#machineLimitActive
		);
	}

	/**
	 * Pick up a change to the three non-CPU limits. Partial on purpose:
	 * `undefined` means "leave this one alone", because the session's own
	 * settings watcher knows about CPU only and must not wipe the others by
	 * omitting them. Turning a limit off never destroys the group and never
	 * resets the cumulative write total, which is the only reading of
	 * "cumulative" that an operator cannot clear by toggling a setting.
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
	 * Create the group if needed, then refuse the spawn when any budget says so.
	 * Spawn sites call this instead of `ensureGroup` then `assertMaySpawn`: the
	 * gate is sync and cannot see a setup failure until the group has been asked
	 * for, so the order is part of the contract, not a local habit.
	 */
	async gateSpawn(what: string): Promise<void> {
		await this.ensureGroup();
		this.assertMaySpawn(what);
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
	 * Refuse a new spawn when any budget says so: the CPU watcher is in a
	 * saturated window, the write budget is spent, the process cap is reached,
	 * or a configured memory cap cannot be enforced on this host.
	 *
	 * Synchronous on purpose: spawn paths must not await to learn they are
	 * refused, and every verdict here is already computed (the watcher's, the
	 * accountant's running total, and the group's live member list).
	 */
	assertMaySpawn(what: string): void {
		if (this.#setupFailed && this.#anyLimitActive) {
			throw new CpuLimitDeniedError(
				`Refused to start ${what}: this session's resource budget group could not be created, ` +
					`so a configured limit cannot be enforced. New commands are refused rather than run uncapped. ` +
					`Fix: wait until the host can create the group, or set the limit to 0.`,
			);
		}
		if (this.#denied) {
			throw new CpuLimitDeniedError(
				`Refused to start ${what}: this session's CPU budget of ${formatCount("core", this.#cores)} is saturated ` +
					`(spawned commands used ~${this.#lastCoresUsed.toFixed(2)} cores for the last ${this.#windowSeconds()}s). ` +
					`New commands run again once usage drops below the budget. ` +
					`Fix: wait for the running command to finish, or raise session.cpuLimitCores.`,
			);
		}
		if (this.#writeBudgetGb > 0 && this.#writes.totalBytes >= this.#writeLimitBytes) {
			throw new CpuLimitDeniedError(
				`Refused to start ${what}: this session tree's write budget of ${this.#writeBudgetGb} GB is spent ` +
					`(${formatBytes(this.#writes.totalBytes)} written). ` +
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
					`(${formatCount("live process", this.#liveMemberCount())} in the budget group). ` +
					`Fix: wait for a running command to finish, or raise session.maxProcesses.`,
			);
		}
		const machineWritten = this.#machineWrittenBytes();
		if (machineWritten !== undefined && machineWritten >= this.#machineWriteLimitBytes()) {
			throw new CpuLimitDeniedError(
				`Refused to start ${what}: this machine's veyyon write budget of ${this.#machineWriteBudgetGb} GB is ` +
					`spent (${formatBytes(machineWritten)} written across every session on this machine). ` +
					`Fix: raise machine.writeBudgetGb, or clear it to lift the machine limit.`,
			);
		}
	}

	/**
	 * Refuse a harness tool write that the budget cannot afford, counting the
	 * bytes it is ABOUT to write: a budget that only notices after the write
	 * lets a single oversized write blow through it by any amount.
	 *
	 * Both tiers are checked, and the session tier first: when a write breaches
	 * both, the session budget is the one the person can act on without
	 * touching a machine-wide setting.
	 */
	assertMayWrite(bytes: number, what: string): void {
		if (this.#writeBudgetGb > 0) {
			const total = this.#writes.totalBytes;
			if (total + bytes > this.#writeLimitBytes) {
				throw new WriteBudgetDeniedError(
					`Refused to write ${what}: this session tree's write budget of ${this.#writeBudgetGb} GB does not ` +
						`cover it (${formatBytes(total)} already written, this write is ${formatBytes(bytes)}). ` +
						`Fix: raise session.writeBudgetGb, or start a new session.`,
				);
			}
		}
		const machineWritten = this.#machineWrittenBytes();
		if (machineWritten !== undefined && machineWritten + bytes > this.#machineWriteLimitBytes()) {
			throw new WriteBudgetDeniedError(
				`Refused to write ${what}: this machine's veyyon write budget of ${this.#machineWriteBudgetGb} GB does ` +
					`not cover it (${formatBytes(machineWritten)} already written across every session on this ` +
					`machine, this write is ${formatBytes(bytes)}). ` +
					`Fix: raise machine.writeBudgetGb, or clear it to lift the machine limit.`,
			);
		}
	}

	/**
	 * Count bytes veyyon's own tools wrote, against both tiers.
	 *
	 * The harness is not a member of either budget group by design, so no
	 * kernel counter will ever see these bytes; the machine half goes to a
	 * cross-process tally so a second veyyon's writes are in the same total.
	 */
	recordHarnessWrite(bytes: number): void {
		if (this.#machineWriteBudgetGb > 0) addMachineHarnessWrite(bytes);
		if (this.#writeBudgetGb <= 0) return;
		this.#writes.recordHarnessWrite(bytes);
		this.#evaluateWriteBudget();
	}

	/** The machine write budget in bytes, or infinity when none is set. */
	#machineWriteLimitBytes(): number {
		return this.#machineWriteBudgetGb > 0 ? this.#machineWriteBudgetGb * BYTES_PER_GB : Number.POSITIVE_INFINITY;
	}

	/**
	 * Bytes charged to the machine write budget, or undefined when no machine
	 * write budget is set. The spawned half comes from the last watcher sample
	 * of the machine cgroup's `io.stat`; the harness half is read fresh, because
	 * another veyyon may have written since this one last sampled.
	 */
	#machineWrittenBytes(): number | undefined {
		if (this.#machineWriteBudgetGb <= 0) return undefined;
		return this.#machineSpawnedWrittenBytes + machineHarnessWrittenBytes();
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
				this.#killOverBudget("SIGTERM");
			} else {
				if (!group.throttles) {
					group.renice(CPU_LIMIT_SATURATION_NICE);
					this.#reniced = true;
				}
				this.#emitNotice(
					`Session CPU budget saturated: limit ${formatCount("core", this.#cores)}, spawned commands used ` +
						`~${this.#lastCoresUsed.toFixed(2)} cores for ${this.#windowSeconds()}s. ` +
						`New commands are being refused until usage drops. ` +
						`Fix: raise session.cpuLimitCores, or set session.cpuLimitKill to terminate over-budget commands instead.`,
				);
			}
		} else if (sustained && this.#denied && this.#killEnabled && this.#killWave === 1) {
			this.#killOverBudget("SIGKILL");
		} else if (!sustained && this.#denied) {
			this.#denied = false;
			this.#killWave = 0;
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
	 *
	 * The machine total is sampled on the same tick and from the machine
	 * cgroup's own `io.stat`, which aggregates every session's subtree — so it
	 * counts what another veyyon spawned too, which is the whole point of a
	 * machine budget and is not derivable from this session's numbers.
	 */
	async #pollWriteBudget(group: CpuBudgetGroupHandle): Promise<void> {
		if (this.#machineWriteBudgetGb > 0) {
			this.#machineSpawnedWrittenBytes = await machineSpawnedWrittenBytes(this.#machineDir).catch(
				() => this.#machineSpawnedWrittenBytes,
			);
		}
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
				`${formatBytes(total)} (${formatBytes(this.#writes.harnessBytes)} by veyyon's tools, ` +
				`${formatBytes(this.#writes.spawnedBytes)} by spawned commands, metered from ${this.#writes.source}). ` +
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
			`${formatBytes(total)}. Sent SIGTERM to ${formatCount("process", killed)} because session.writeBudgetKill is on. ` +
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
		if (!probe.supported || !probe.backend) {
			// Same fail-closed contract as a thrown create: a configured limit
			// must not silently let the first command run unbounded.
			if (this.#anyLimitActive) this.#setupFailed = true;
			return undefined;
		}
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
				const cpuQuota = formatSystemdCpuQuota(this.#cores);
				const launched = await this.#options.env.run([
					"systemd-run",
					"--user",
					"--quiet",
					"--collect",
					`--unit=${unitBase}`,
					// Without Delegate=yes, systemd owns the unit cgroup and rejects
					// native writes to cgroup.procs, so adopt was a silent no-op.
					"-p",
					"Delegate=yes",
					// A oneshot that has already exited leaves an empty delegated
					// cgroup (RemainAfterExit keeps the unit). `sleep infinity` as a
					// service would occupy pids.max and never return under --scope;
					// the service form returns, but the sleeper still sat in the
					// group as a live member.
					"-p",
					"Type=oneshot",
					"-p",
					"RemainAfterExit=yes",
					// A group can exist for the write, process or memory limit with
					// no CPU limit at all, and `CPUQuota=0%` is a quota of no CPU
					// rather than an absent one.
					...(cpuQuota ? ["-p", cpuQuota] : []),
					"--",
					"true",
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
				// The machine tier is a cgroup BETWEEN the delegated parent and this
				// session's group, so the kernel bounds every session at once. It
				// returns the delegated parent unchanged when no machine limit is
				// set or the host cannot host one, which is why this reads the
				// placement rather than branching on whether a limit exists.
				const placement = await machineBudgetPlacement(this.#options.env, probe.backend.parentDir);
				this.#machineDir = placement.machineDir;
				// Once per session, not once per group creation: a machine limit
				// nobody is holding is exactly the silent failure a limit must not
				// have, and the notice names which resource and why.
				if (placement.unenforceable) this.#emitNoticeOnce("machine-budget", placement.unenforceable);
				// The native Linux backend creates `<parent>/<name>`; the other
				// three limits are ordinary files in that same directory, so the
				// path is derived here rather than round-tripped through napi.
				this.#cgroupDir = path.join(placement.parentDir, this.budgetName);
				this.#group = create({
					name: this.budgetName,
					cores: this.#cores,
					cgroupParentDir: placement.parentDir,
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
					`${errorMessage(error)}. New commands are refused rather than run uncapped.`,
			);
			return undefined;
		}
	}

	/**
	 * Write `pids.max` and `memory.max` on the live group, and record whether
	 * the kernel actually took them.
	 *
	 * The write is the probe. Delegation is per controller and can differ from
	 * what the parent directory advertised (a systemd unit's cgroup is not the
	 * directory the startup probe measured), so believing the earlier reading
	 * here would report a cap that does not exist. A failure is not fatal:
	 * `pids` degrades to the policy refusal in `assertMaySpawn`, and `memory`
	 * has no policy stand-in, so it refuses spawns outright and says why.
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
		this.#pidsEnforced = await this.#writeCgroupFile(dir, "pids.max", formatLimitFileValue(this.#maxProcesses));
		const memory = memoryCapControls(this.#memoryLimitGb);
		this.#memoryEnforced = await this.#writeCgroupFile(dir, "memory.max", memory.max);
		// The cap above bounds RESIDENT memory; without this the overflow goes to
		// swap and the group runs on past the limit. See memoryCapControls.
		await this.#writeCgroupFile(dir, "memory.swap.max", memory.swapMax);
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
				const quota = formatSystemdCpuQuota(cores) ?? "CPUQuota=";
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

	#killOverBudget(signal: "SIGTERM" | "SIGKILL"): void {
		if (!this.#group) return;
		if (signal === "SIGTERM" && this.#killWave !== 0) return;
		if (signal === "SIGKILL" && this.#killWave !== 1) return;
		this.#killWave = signal === "SIGTERM" ? 1 : 2;
		let killed = 0;
		for (const pid of this.#group.members()) {
			try {
				this.#options.env.kill(pid, signal);
				killed++;
			} catch {
				// The process exited between listing and signal; nothing to report.
			}
		}
		const report =
			`Session CPU budget exceeded: limit ${formatCount("core", this.#cores)}, spawned commands used ` +
			`~${this.#lastCoresUsed.toFixed(2)} cores for ${this.#windowSeconds()}s. Sent ${signal} to ${formatCount("process", killed)} ` +
			`because session.cpuLimitKill is on. A command that just stopped was killed by the CPU budget, not a crash.`;
		this.#lastKillReport = report;
		this.#emitNotice(report);
	}
}

/** The startup warning when a configured limit cannot be enforced. */
function unsupportedText(cores: number, probe: CpuLimitProbe): string {
	return (
		`session.cpuLimitCores is set to ${cores} but a CPU limit cannot be enforced here: ${probe.detail}. ` +
		`New commands are refused rather than run uncapped.`
	);
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

const limiters = new Map<string, SessionCpuLimit>();
/** Registration order, so the root session's limiter is findable for shared workers. */
const registrationOrder: string[] = [];

/**
 * Session ids that BORROW another session's group: alias id -> owner id.
 *
 * A separate table on purpose, and this is load-bearing rather than tidiness.
 * Pointing a child id at the root limiter inside `limiters` would break two
 * things that read that map as "one entry, one owned group":
 *
 * - the owned-resource disposer below resolves by id and calls `dispose()`
 *   unconditionally, so the FIRST subagent to finish would tear the root
 *   group down and silently stop enforcing for the whole tree, with a kill
 *   knob turning a normal child exit into a SIGTERM path;
 * - `rekeySessionCpuLimit` treats an existing entry at the destination id as
 *   a superseded occupant and disposes the source, so an alias sitting in
 *   `limiters` could get the root disposed on `/new`.
 *
 * Aliases also stay out of `registrationOrder`, because that is what
 * `primarySessionCpuLimit` reads: a subagent must never become the process's
 * "root session" for shared spawns.
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
 * The id of the session that OWNS this session's budget group: itself for a
 * root session, its spawner's owner for a subagent at any depth. Undefined
 * before registration.
 *
 * This is the process's one answer to "which session tree is this", and
 * anything else that has to be shared by a whole tree keys on it rather than
 * inventing a second notion of the same thing.
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
 * Follow a session whose id changed. `/new`, `/resume`, a fork and a branch all
 * mint a fresh id on the same live process, and spawn sites resolve the limiter
 * by the session's CURRENT id, so a limiter registered under the old one stops
 * being found: the group keeps enforcing under a name nothing looks up, and the
 * conversation the operator is now in is unlimited.
 *
 * The limiter, its group, and every pid already adopted into it are kept as
 * they are; only the key moves. A fresh group would be the wrong reading of the
 * setting: a background command launched before `/new` is still running in this
 * process, and two groups of N cores would let the operator's one budget be
 * exceeded by the act of starting a new conversation.
 *
 * Aliases move with their owner, and an alias id being rekeyed moves as an
 * alias. An alias is never mistaken for an occupant: it owns no group, so
 * disposing anything over it would tear down a group the rest of the tree is
 * still enforcing against.
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
 * Refuse a new eval kernel cell (or any other caller that has a session id
 * but not the limiter object) when the session budget is saturated or setup
 * failed. No-op when the session has no limiter.
 */
export async function gateSessionCpuSpawn(sessionId: string | null | undefined, what: string): Promise<void> {
	const limiter = sessionCpuLimit(sessionId);
	if (!limiter) return;
	await limiter.gateSpawn(what);
}

/**
 * Spawn hooks for `exec` wrappers (custom tools, commands, extensions, hooks).
 * `adoptPid` joins the child to the session group; `gate` refuses the spawn
 * when the group is saturated or could not be created. Call `gate` before
 * the process exists — adopting afterwards cannot un-run an uncapped child.
 */
export function sessionCpuExecHooks(getSessionId: () => string | null): {
	adoptPid: (pid: number) => void;
	gate: (what: string) => Promise<void>;
} {
	return {
		adoptPid: sessionCpuAdoption(getSessionId),
		gate: what => gateSessionCpuSpawn(getSessionId(), what),
	};
}

/**
 * Adopt one pid into the root session's budget. Used by spawns that belong to
 * the process as a whole rather than to one session: shared service workers,
 * language servers, debug adapters, the managed browser, speech, and plugin
 * installs. Every session in the process shares those, so pinning them to
 * whichever session happened to trigger them would be arbitrary; the root
 * session's budget is the one that outlives them all.
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
	cachedProbe ??= probeCpuLimitSupport(resolveCpuLimitEnvironment());
	return cachedProbe;
}

/**
 * The machine budget group, resolved once per process.
 *
 * Memoized on the delegated parent because every session in this process
 * lands in the same machine group, and re-running the mkdir and the three
 * control writes per session would be the same work for the same answer. It
 * is NOT memoized across processes: a second veyyon runs this too, finds the
 * directory already there, and rewrites the same values from the same config,
 * which is what keeps the cap shared rather than duplicated.
 *
 * A machine limit that cannot be parsed is reported as unenforceable rather
 * than thrown: a broken global config must not stop a session from starting,
 * and a limit nobody can read is a limit nobody is holding.
 */
const machinePlacements = new Map<string, Promise<MachineBudgetPlacement>>();

export function machineBudgetPlacement(env: CpuLimitEnvironment, parentDir: string): Promise<MachineBudgetPlacement> {
	const existing = machinePlacements.get(parentDir);
	if (existing) return existing;
	const resolved = (async (): Promise<MachineBudgetPlacement> => {
		let limits: MachineBudgetLimits;
		try {
			limits = machineBudgetLimits();
		} catch (error) {
			return {
				parentDir,
				machineDir: undefined,
				kernelHeld: { cpu: false, pids: false, memory: false },
				unenforceable: `A machine-wide resource limit could not be read, so none is held: ${errorMessage(error)}`,
			};
		}
		return ensureMachineBudget({ platform: env.platform, parentDir }, limits);
	})();
	machinePlacements.set(parentDir, resolved);
	return resolved;
}

/**
 * The machine placement this process already resolved, or undefined when no
 * session has needed one yet.
 *
 * Never creates the group. A report must not have the side effect of applying
 * a limit, and "nothing has needed the budget yet" is itself the honest answer
 * for a session that has spawned nothing. Every session in this process shares
 * one delegated parent, so the map holds at most one entry in practice; the
 * first is the one every session is bounded by.
 */
export function resolvedMachineBudgetPlacement(): Promise<MachineBudgetPlacement> | undefined {
	for (const placement of machinePlacements.values()) return placement;
	return undefined;
}

/** Reset the registry, probe cache and machine placement. Test-only. */
export function resetSessionCpuLimitsForTests(): void {
	limiters.clear();
	registrationOrder.length = 0;
	aliasOwners.clear();
	aliasesByOwner.clear();
	cachedProbe = undefined;
	machinePlacements.clear();
}

/**
 * The budget group a session registering RIGHT NOW should join instead of
 * creating its own.
 *
 * An AsyncLocalStorage scope rather than a parameter because the session that
 * needs to read it is constructed several layers below the code that knows the
 * answer: `runSubprocess` -> `createAgentSession` -> `new AgentSession` ->
 * `initSessionCpuLimit`, and `AgentSession` belongs to another lane. The
 * constructor runs synchronously inside the scope, so the store is visible
 * without threading an argument through the composition root.
 */
const inheritedBudgetGroup = new AsyncLocalStorage<string>();

/**
 * Run `fn` with sessions created inside it joining `rootSessionId`'s budget
 * group as aliases. The task executor wraps subagent session creation in this.
 *
 * Depth is unbounded because the pinned id is resolved through the alias
 * table: a depth-2 spawn pins its own (already aliased) session id, which
 * resolves to the same owner, so a subagent of a subagent lands in the root
 * group rather than in its parent's copy of it.
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
 * Create and register a session's limiter. Always registers, even with every
 * limit at 0, so a mid-session settings change can activate enforcement;
 * raises the startup warning when a configured limit cannot be enforced on
 * this host.
 *
 * A session registering inside a pinned scope ({@link withInheritedBudgetGroup})
 * becomes an ALIAS of that group and gets no limiter of its own: it must not
 * re-apply its own settings over the root's either, because the operator set
 * one budget for the tree and the root owns it.
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
	// The same environment the probe measured. They were resolved separately,
	// and only the probe's copy carried `ownCgroupPath`, so anything reading it
	// off the limiter's copy saw "unknown" for the directory the probe had just
	// selected. Nothing does today; resolving once means nothing can.
	//
	// Resolved synchronously so this function reaches `limiters.set` before it
	// yields: `AgentSession` launches it with `void`, and a spawn site that
	// resolves the limiter by session id in the same tick would otherwise find
	// nothing registered and run the command outside every budget.
	const env = options.env ?? resolveCpuLimitEnvironment();
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
 * Wrap a file-committing callback so the session tree's write budget both
 * gates it and counts it.
 *
 * This is the whole harness half of the write budget. The write and edit
 * tools run IN the veyyon process, which is deliberately never a member of
 * the budget group, so no `io.stat` and no `/proc/<pid>/io` reading will ever
 * attribute a byte of theirs to the group. Wrapping the one callback both
 * tools commit through means a new caller of that callback is covered by
 * construction instead of by remembering.
 *
 * Generic over the tail of the signature so it fits the LSP writethrough
 * (which carries a BunFile, a batch request and a deferred-diagnostics hook)
 * without this module importing the LSP layer.
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
 * The operator's non-CPU limits, or undefined when settings are not loaded.
 *
 * The slot is empty before the config file is read, which is not an error here:
 * it means nothing has been configured for this process yet, so the group has no
 * limits to write. Asking the SLOT rather than `Settings.instance` also keeps the
 * store off this module's import graph, and off every graph that reaches a spawn
 * site through it (see `test/architecture/leveraged-imports-stay-cut.test.ts`).
 */
function configuredBudgetLimits(): SessionBudgetLimits | undefined {
	const settings = settingsOrNull();
	return settings ? sessionBudgetLimits(settings) : undefined;
}
