/**
 * Per-session CPU budget.
 *
 * WHAT THIS CAPS. Every OS process a session spawns: bash commands (brush
 * shells and the interactive PTY), MCP stdio servers, custom tool and hook
 * `exec` calls, `launch` background processes, and the shared worker
 * subprocesses. WHAT IT NEVER CAPS: the harness process itself. The budget
 * group never contains the harness, so in-process compute (agent turns, Bun
 * Worker threads such as the JS eval worker, shell builtins) is unaffected.
 * Shared harness service workers (tiny title model, embeddings, speech)
 * belong to no single session, so they join the root session's budget.
 *
 * OWNERSHIP SPLIT WITH THE NATIVE SIDE. This module owns POLICY: probing the
 * host, picking a backend, the once-a-second watcher, deny/kill decisions,
 * and lifecycle. The OS mechanics (create the group, adopt a pid, read
 * usage, tear down) live in `veyyon_shell::cpu_budget`, reached through the
 * `CpuBudgetGroup` napi class, because the spawn points that first see a
 * child pid (the brush spawn observer, the PTY spawner) are native. Policy
 * never crosses into Rust; syscalls never appear here.
 *
 * BACKENDS, PROBED ONCE PER PROCESS. Linux: a cgroup v2 directory written
 * directly when a delegated parent is writable, else a `systemd-run --user`
 * transient service when a user manager answers. Windows: a Job Object with a hard CPU
 * rate cap. macOS: no per-group quota exists, so the budget is POLICY-ONLY
 * (the watcher refuses new commands, renices the group, and optionally
 * kills) and `throttles` is false so the settings row and startup warning
 * say so. Anything else: unsupported, reported, never silently off.
 *
 * THE KERNEL CAP IS THE ENFORCEMENT OF LAST RESORT on Linux and Windows. The
 * watcher is only the policy layer: if it lags or dies, the group keeps
 * throttling. A watcher gap means slower, never uncapped.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CpuBudgetGroup as NativeCpuBudgetGroup } from "@veyyon/natives";
// Owners, not the `@veyyon/utils` barrel: 2 modules against 81.
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { registerOwnedResourceDisposer } from "./owned-resources";

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

/** Outcome of the once-per-process capability probe. */
export interface CpuLimitProbe {
	supported: boolean;
	/** Whether the selected backend makes the kernel throttle the group. */
	throttles: boolean;
	backend: CpuLimitBackend | null;
	/** Which backend was selected, or WHY none works. Shown to the operator verbatim. */
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

/**
 * Whether `dir` can host a session cgroup: the `cpu` controller is delegated
 * to it, a child directory can be created, the controller can be enabled for
 * that child, and `cpu.max` accepts a write. Each step is tried for real
 * against a probe child because the cgroup v2 delegation rules (no internal
 * processes, controller must be delegated by the parent) are not visible from
 * permission bits alone. The probe child is removed before returning, pass or
 * fail.
 */
async function tryDirectParent(env: CpuLimitEnvironment, dir: string): Promise<boolean> {
	const controllers = await readOptional(path.join(dir, "cgroup.controllers"));
	if (!controllers?.split(/\s+/).includes("cpu")) return false;
	const probeChild = path.join(dir, `.veyyon-cpu-probe-${env.uid}`);
	try {
		await fs.mkdir(probeChild);
		const subtreeControl = await readOptional(path.join(dir, "cgroup.subtree_control"));
		if (!subtreeControl?.split(/\s+/).includes("cpu")) {
			await fs.writeFile(path.join(dir, "cgroup.subtree_control"), "+cpu");
		}
		await fs.writeFile(path.join(probeChild, "cpu.max"), formatCpuMaxValue(1));
		return true;
	} catch {
		return false;
	} finally {
		await env.removeDir(probeChild).catch(() => {});
	}
}

function unsupported(detail: string): CpuLimitProbe {
	return { supported: false, throttles: false, backend: null, detail };
}

/** Probe the host once: platform, controller availability, backend. */
export async function probeCpuLimitSupport(env: CpuLimitEnvironment): Promise<CpuLimitProbe> {
	if (env.platform === "win32") {
		return {
			supported: true,
			throttles: true,
			backend: { kind: "job-object" },
			detail: "Windows Job Object with a hard CPU rate cap",
		};
	}
	if (env.platform === "darwin") {
		return {
			supported: true,
			throttles: false,
			backend: { kind: "tracked" },
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
		if (await tryDirectParent(env, dir)) {
			return {
				supported: true,
				throttles: true,
				backend: { kind: "direct", parentDir: dir },
				detail: `direct cgroup writes under ${dir}`,
			};
		}
	}
	const systemctl = await env
		.run(["systemctl", "--user", "show-environment"])
		.catch((error): CpuLimitCommandResult => ({ code: 1, stdout: "", stderr: errorMessage(error) }));
	if (systemctl.code === 0) {
		return {
			supported: true,
			throttles: true,
			backend: { kind: "systemd-run" },
			detail: "systemd user services via systemd-run --user",
		};
	}
	return unsupported(
		"no writable cgroup has the cpu controller delegated, and no systemd user manager answered " +
			`(systemctl --user failed: ${systemctl.stderr.trim() || `exit ${systemctl.code}`})`,
	);
}

/** Thrown by spawn paths when the watcher has the session in a saturated window. */
export class CpuLimitDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CpuLimitDeniedError";
	}
}

interface WatcherSample {
	at: number;
	usageUsec: number;
	throttledPeriods: number | undefined;
}

export interface SessionCpuLimitOptions {
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
 * One session's budget: the group (lazily created on the first capped
 * spawn), the watcher, and the deny/kill policy.
 */
export class SessionCpuLimit {
	readonly #options: SessionCpuLimitOptions;
	#cores: number;
	#killEnabled: boolean;
	readonly #probe: Promise<CpuLimitProbe>;
	#group: CpuBudgetGroupHandle | undefined;
	#ensurePromise: Promise<CpuBudgetGroupHandle | undefined> | undefined;
	#systemdUnit: string | undefined;
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

	constructor(options: SessionCpuLimitOptions) {
		this.#options = options;
		this.#cores = options.cores;
		this.#killEnabled = options.kill;
		this.#probe = Promise.resolve(options.probe);
	}

	get cores(): number {
		return this.#cores;
	}

	/** The budget group name, whether or not the group exists yet. */
	get budgetName(): string {
		return sessionCpuBudgetName(this.#options.sessionId);
	}

	/** A one-line state summary for diagnostics (doctor, logs). */
	async statusLine(): Promise<string> {
		const probe = await this.#probe;
		if (this.#cores <= 0) return "off (session.cpuLimitCores is 0)";
		if (!probe.supported) return `configured for ${this.#cores} core(s) but unavailable: ${probe.detail}`;
		if (this.#setupFailed) return `configured for ${this.#cores} core(s) but group setup failed`;
		const mode = probe.throttles ? "kernel-throttled" : "policy-only (no kernel throttle on this OS)";
		const state = this.#group ? "enforcing" : "armed, group created on first spawn";
		return `${this.#cores} core(s), ${mode}, via ${probe.detail}; ${state}${this.#denied ? "; saturated, refusing new commands" : ""}`;
	}

	/**
	 * Pick up a settings change. Raising or lowering the limit re-expresses
	 * the quota on the live group; setting 0 lifts it without destroying the
	 * group (processes already inside stay accounted).
	 */
	async update(cores: number, kill: boolean): Promise<void> {
		const changed = cores !== this.#cores;
		this.#killEnabled = kill;
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
	 * group a spawn should join, or undefined when the budget is off or
	 * enforcement is impossible (already reported; never throws).
	 */
	async ensureGroup(): Promise<CpuBudgetGroupHandle | undefined> {
		if (this.#cores <= 0 || this.#disposed) return undefined;
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

	/**
	 * Refuse a new spawn while the watcher reports sustained saturation.
	 * Synchronous on purpose: spawn paths must not await to learn they are
	 * refused, and the watcher's verdict is already computed.
	 */
	assertMaySpawn(what: string): void {
		if (!this.#denied) return;
		throw new CpuLimitDeniedError(
			`Refused to start ${what}: this session's CPU budget of ${this.#cores} core(s) is saturated ` +
				`(spawned commands used ~${this.#lastCoresUsed.toFixed(2)} cores for the last ${this.#windowSeconds()}s). ` +
				`New commands run again once usage drops below the budget. ` +
				`Fix: wait for the running command to finish, or raise session.cpuLimitCores.`,
		);
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
	 * One watcher step: sample group usage, update the saturation window, and
	 * deny, renice, or kill on a sustained breach. Public so tests drive it
	 * without waiting on the interval; the production timer calls it once a
	 * second.
	 */
	async pollOnce(): Promise<void> {
		const group = this.#group;
		if (!group || this.#cores <= 0 || this.#disposed) return;
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
					"-p",
					`CPUQuota=${this.#cores * 100}%`,
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
				this.#group = create({
					name: this.budgetName,
					cores: this.#cores,
					existingCgroupDir: path.join(this.#options.env.cgroupRoot, relative),
				});
			} else if (probe.backend.kind === "direct") {
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

/** The limiter for a live session, undefined before registration or after dispose. */
export function sessionCpuLimit(sessionId: string | null | undefined): SessionCpuLimit | undefined {
	return sessionId ? limiters.get(sessionId) : undefined;
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
 */
export function rekeySessionCpuLimit(previousId: string, nextId: string): SessionCpuLimit | undefined {
	if (previousId === nextId) return limiters.get(nextId);
	const limiter = limiters.get(previousId);
	if (!limiter || limiters.has(nextId)) return limiters.get(nextId);
	limiters.delete(previousId);
	limiters.set(nextId, limiter);
	const index = registrationOrder.indexOf(previousId);
	if (index >= 0) registrationOrder[index] = nextId;
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
	void limiter.adoptPid(pid).catch(error => logger.debug("CPU limit: adoption failed", { error: errorMessage(error) }));
}

/** The closure form of {@link adoptIntoPrimarySessionCpuBudget}, for `onSpawnPid` hooks. */
export function primarySessionCpuAdoption(): (pid: number) => void {
	return adoptIntoPrimarySessionCpuBudget;
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
	cachedProbe = undefined;
}

export interface InitSessionCpuLimitOptions {
	sessionId: string;
	cores: number;
	kill: boolean;
	onNotice: (text: string) => void;
	env?: CpuLimitEnvironment;
}

/**
 * Create and register a session's limiter. Always registers, even at 0 cores,
 * so a mid-session settings change can activate enforcement; raises the
 * startup warning when a configured limit cannot be enforced on this host.
 */
export async function initSessionCpuLimit(options: InitSessionCpuLimitOptions): Promise<SessionCpuLimit> {
	const existing = limiters.get(options.sessionId);
	if (existing) {
		await existing.update(options.cores, options.kill);
		return existing;
	}
	const env = options.env ?? defaultCpuLimitEnvironment();
	const probe = probeSessionCpuLimitSupport(options.env);
	const limiter = new SessionCpuLimit({
		sessionId: options.sessionId,
		cores: options.cores,
		kill: options.kill,
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
	return limiter;
}

registerOwnedResourceDisposer({
	name: "session-cpu-limit",
	scope: "session",
	dispose: async ownerId => {
		const limiter = limiters.get(ownerId);
		if (!limiter) return;
		limiters.delete(ownerId);
		const index = registrationOrder.indexOf(ownerId);
		if (index >= 0) registrationOrder.splice(index, 1);
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
	execFile(cmd[0], cmd.slice(1), { timeout: 10_000 }, (error, stdout, stderr) => {
		const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
		resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || "") });
	});
	return promise;
}

/** The production environment: real /sys/fs/cgroup, real systemctl, real SIGTERM. */
export function defaultCpuLimitEnvironment(): CpuLimitEnvironment {
	return {
		platform: process.platform,
		uid: typeof process.getuid === "function" ? process.getuid() : -1,
		cgroupRoot: "/sys/fs/cgroup",
		ownCgroupPath: "",
		run: runHostCommand,
		kill: (pid, signal) => process.kill(pid, signal),
		now: () => Date.now(),
		removeDir: dir => fs.rmdir(dir),
	};
}
