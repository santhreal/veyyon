import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { Settings } from "../config/settings";
import { settingsOrNull } from "../config/settings-instance";
import type {
	CpuBudgetGroupHandle,
	CpuBudgetGroupSpec,
	CpuLimitCommandResult,
	CpuLimitEnvironment,
	CpuLimitProbe,
} from "./cpu-limit-helpers";
import {
	CPU_LIMIT_SATURATION_NICE,
	CPU_LIMIT_WATCH_INTERVAL_MS,
	CPU_LIMIT_WINDOW_SAMPLES,
	createNativeBudgetGroup,
	formatSystemdCpuQuota,
	limitFileValue,
	probeCpuLimitSupport,
	readOptional,
	SATURATION_RATIO,
} from "./cpu-limit-helpers";
import { registerOwnedResourceDisposer } from "./owned-resources";
import {
	BYTES_PER_GB,
	formatWriteBytes,
	type SpawnedWriteSource,
	sampleSpawnedWrites,
	WriteAccountant,
} from "./write-accounting";

export { CPU_LIMIT_PERIOD_USEC, formatCpuMaxValue } from "./cpu-limit-helpers";
export type { CpuBudgetGroupHandle, CpuLimitCommandResult, CpuLimitEnvironment, CpuLimitProbe };
export { CPU_LIMIT_SATURATION_NICE, formatSystemdCpuQuota, probeCpuLimitSupport };

export class CpuLimitDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CpuLimitDeniedError";
	}
}

export class WriteBudgetDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WriteBudgetDeniedError";
	}
}

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
	onNotice?: (text: string) => void;
	createGroup?: (spec: CpuBudgetGroupSpec) => CpuBudgetGroupHandle;
	watchIntervalMs?: number;
	windowSamples?: number;
}

export function sessionCpuBudgetName(sessionId: string): string {
	const safe = sessionId.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
	return `veyyon-cpu-${safe.length > 0 ? safe : "session"}`;
}

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
	#cgroupDir: string | undefined;
	#setupFailed = false;
	#timer: NodeJS.Timeout | undefined;
	#lastSample: WatcherSample | undefined;
	#window: boolean[] = [];
	#denied = false;
	#killWave = 0;
	#reniced = false;
	#lastCoresUsed = 0;
	#lastKillReport: string | undefined;
	#disposed = false;
	readonly #writes = new WriteAccountant();
	#writeOverBudget = false;
	#writeKilledThisEpisode = false;
	#memberCount = 0;
	#pidsEnforced = false;
	#memoryEnforced = false;
	readonly #noticed = new Set<string>();
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

	async #applyConfiguredLimits(): Promise<void> {
		if (this.#limitsSupplied) return;
		const limits = configuredBudgetLimits();
		if (limits) await this.updateLimits(limits);
	}

	get cores(): number {
		return this.#cores;
	}

	get budgetName(): string {
		return sessionCpuBudgetName(this.#options.sessionId);
	}

	get writtenBytes(): number {
		return this.#writes.totalBytes;
	}

	get writeSource(): SpawnedWriteSource {
		return this.#writes.source;
	}

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

	get #anyLimitActive(): boolean {
		return this.#cores > 0 || this.#writeBudgetGb > 0 || this.#maxProcesses > 0 || this.#memoryLimitGb > 0;
	}

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
		this.#writeOverBudget = this.#writeBudgetGb > 0 && this.#writes.totalBytes >= this.#writeLimitBytes;
		if (!this.#writeOverBudget) this.#writeKilledThisEpisode = false;
		if (this.#writeBudgetGb !== previousWriteBudget) this.#noticed.delete("write-source");
		if (this.#maxProcesses !== previousMaxProcesses) this.#noticed.delete("pids-unenforceable");
		if (this.#memoryLimitGb !== previousMemory) this.#noticed.delete("memory-unenforceable");
		await this.#applyCgroupResourceLimits();
	}

	async update(cores: number, kill: boolean, limits?: SessionBudgetLimits): Promise<void> {
		const changed = cores !== this.#cores;
		this.#killEnabled = kill;
		if (limits) await this.updateLimits(limits);
		if (!changed) return;
		const wasOff = this.#cores <= 0;
		this.#cores = cores;
		if (this.#setupFailed) {
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
			const probe = await this.#probe;
			if (!probe.supported) this.#emitNotice(unsupportedText(cores, probe));
			return;
		}
		await this.#setQuota(cores);
	}

	async ensureGroup(): Promise<CpuBudgetGroupHandle | undefined> {
		if (this.#disposed) return undefined;
		await this.#applyConfiguredLimits();
		if (!this.#anyLimitActive) return undefined;
		if (this.#group) return this.#group;
		if (this.#setupFailed) return undefined;
		this.#ensurePromise ??= this.#createGroup();
		return this.#ensurePromise;
	}

	async gateSpawn(what: string): Promise<void> {
		await this.ensureGroup();
		this.assertMaySpawn(what);
	}

	async adoptPid(pid: number): Promise<void> {
		const group = await this.ensureGroup();
		if (!group) return;
		group.adopt(pid);
	}

	get #writeLimitBytes(): number {
		return this.#writeBudgetGb > 0 ? this.#writeBudgetGb * BYTES_PER_GB : Number.POSITIVE_INFINITY;
	}

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

	recordHarnessWrite(bytes: number): void {
		if (this.#writeBudgetGb <= 0) return;
		this.#writes.recordHarnessWrite(bytes);
		this.#evaluateWriteBudget();
	}

	#liveMemberCount(): number {
		if (!this.#group) return 0;
		try {
			this.#memberCount = this.#group.members().length;
		} catch {}
		return this.#memberCount;
	}

	get #memoryUnenforceableReason(): string {
		return this.#cgroupDir
			? "the memory controller is not delegated to this session's cgroup"
			: "this backend has no cgroup to write memory.max into";
	}

	consumeKillReport(): string | undefined {
		const report = this.#lastKillReport;
		this.#lastKillReport = undefined;
		return report;
	}

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
					`Session CPU budget saturated: limit ${this.#cores} core(s), spawned commands used ` +
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

	#killOverWriteBudget(total: number): void {
		if (this.#writeKilledThisEpisode || !this.#group) return;
		this.#writeKilledThisEpisode = true;
		let killed = 0;
		for (const pid of this.#group.members()) {
			try {
				this.#options.env.kill(pid, "SIGTERM");
				killed++;
			} catch {}
		}
		const report =
			`Session write budget exceeded: limit ${this.#writeBudgetGb} GB, this session tree has written ` +
			`${formatWriteBytes(total)}. Sent SIGTERM to ${killed} process(es) because session.writeBudgetKill is on. ` +
			`A command that just stopped was killed by the write budget, not a crash.`;
		this.#lastKillReport = report;
		this.#emitNotice(report);
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		await this.#releaseGroup();
	}

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

	#emitNoticeOnce(key: string, text: string): void {
		if (this.#noticed.has(key)) return;
		this.#noticed.add(key);
		this.#emitNotice(text);
	}

	async #createGroup(): Promise<CpuBudgetGroupHandle | undefined> {
		const probe = await this.#probe;
		if (!probe.supported || !probe.backend) {
			if (this.#anyLimitActive) this.#setupFailed = true;
			return undefined;
		}
		const create = this.#options.createGroup ?? createNativeBudgetGroup;
		try {
			if (probe.backend.kind === "systemd-run") {
				const unitBase = this.budgetName;
				const unit = `${unitBase}.service`;
				const cpuQuota = formatSystemdCpuQuota(this.#cores);
				const launched = await this.#options.env.run([
					"systemd-run",
					"--user",
					"--quiet",
					"--collect",
					`--unit=${unitBase}`,
					"-p",
					"Delegate=yes",
					"-p",
					"Type=oneshot",
					"-p",
					"RemainAfterExit=yes",
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
				this.#cgroupDir = path.join(probe.backend.parentDir, this.budgetName);
				this.#group = create({
					name: this.budgetName,
					cores: this.#cores,
					cgroupParentDir: probe.backend.parentDir,
				});
			} else {
				this.#group = create({ name: this.budgetName, cores: this.#cores });
			}
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
			} catch {}
		}
		const report =
			`Session CPU budget exceeded: limit ${this.#cores} core(s), spawned commands used ` +
			`~${this.#lastCoresUsed.toFixed(2)} cores for ${this.#windowSeconds()}s. Sent ${signal} to ${killed} process(es) ` +
			`because session.cpuLimitKill is on. A command that just stopped was killed by the CPU budget, not a crash.`;
		this.#lastKillReport = report;
		this.#emitNotice(report);
	}
}

function unsupportedText(cores: number, probe: CpuLimitProbe): string {
	return (
		`session.cpuLimitCores is set to ${cores} but a CPU limit cannot be enforced here: ${probe.detail}. ` +
		`New commands are refused rather than run uncapped.`
	);
}

const limiters = new Map<string, SessionCpuLimit>();
const registrationOrder: string[] = [];

const aliasOwners = new Map<string, string>();
const aliasesByOwner = new Map<string, Set<string>>();

export function sessionCpuLimit(sessionId: string | null | undefined): SessionCpuLimit | undefined {
	if (!sessionId) return undefined;
	const owned = limiters.get(sessionId);
	if (owned) return owned;
	const owner = aliasOwners.get(sessionId);
	return owner ? limiters.get(owner) : undefined;
}

export function sessionTreeId(sessionId: string | null | undefined): string | undefined {
	if (!sessionId) return undefined;
	if (limiters.has(sessionId)) return sessionId;
	const owner = aliasOwners.get(sessionId);
	return owner !== undefined && limiters.has(owner) ? owner : undefined;
}

function unregisterAlias(aliasId: string): boolean {
	const owner = aliasOwners.get(aliasId);
	if (owner === undefined) return false;
	aliasOwners.delete(aliasId);
	const siblings = aliasesByOwner.get(owner);
	siblings?.delete(aliasId);
	if (siblings?.size === 0) aliasesByOwner.delete(owner);
	return true;
}

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
	unregisterAlias(nextId);
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

export function sessionCpuAdoption(getSessionId: () => string | null): (pid: number) => void {
	return pid => {
		const limiter = sessionCpuLimit(getSessionId());
		if (!limiter) return;
		void limiter
			.adoptPid(pid)
			.catch(error => logger.debug("CPU limit: adoption failed", { error: errorMessage(error) }));
	};
}

export async function gateSessionCpuSpawn(sessionId: string | null | undefined, what: string): Promise<void> {
	const limiter = sessionCpuLimit(sessionId);
	if (!limiter) return;
	await limiter.gateSpawn(what);
}

export function sessionCpuExecHooks(getSessionId: () => string | null): {
	adoptPid: (pid: number) => void;
	gate: (what: string) => Promise<void>;
} {
	return {
		adoptPid: sessionCpuAdoption(getSessionId),
		gate: what => gateSessionCpuSpawn(getSessionId(), what),
	};
}

export function adoptIntoPrimarySessionCpuBudget(pid: number): void {
	const limiter = primarySessionCpuLimit();
	if (!limiter) return;
	void limiter
		.adoptPid(pid)
		.catch(error => logger.debug("CPU limit: adoption failed", { error: errorMessage(error) }));
}

export function primarySessionCpuAdoption(): (pid: number) => void {
	return adoptIntoPrimarySessionCpuBudget;
}

export function rootBudgetGroupOwnerId(): string | undefined {
	return registrationOrder[0];
}

export function primarySessionCpuLimit(): SessionCpuLimit | undefined {
	const first = registrationOrder[0];
	return first ? limiters.get(first) : undefined;
}

let cachedProbe: Promise<CpuLimitProbe> | undefined;

export function probeSessionCpuLimitSupport(env?: CpuLimitEnvironment): Promise<CpuLimitProbe> {
	if (env) return probeCpuLimitSupport(env);
	cachedProbe ??= defaultResolvedEnvironment().then(probeCpuLimitSupport);
	return cachedProbe;
}

export function resetSessionCpuLimitsForTests(): void {
	limiters.clear();
	registrationOrder.length = 0;
	aliasOwners.clear();
	aliasesByOwner.clear();
	cachedProbe = undefined;
}

const inheritedBudgetGroup = new AsyncLocalStorage<string>();

export function withInheritedBudgetGroup<T>(rootSessionId: string | null | undefined, fn: () => T): T {
	if (!rootSessionId) return fn();
	return inheritedBudgetGroup.run(rootSessionId, fn);
}

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
		if (unregisterAlias(ownerId)) return;
		const limiter = limiters.get(ownerId);
		if (!limiter) return;
		limiters.delete(ownerId);
		const index = registrationOrder.indexOf(ownerId);
		if (index >= 0) registrationOrder.splice(index, 1);
		for (const alias of aliasesByOwner.get(ownerId) ?? new Set<string>()) aliasOwners.delete(alias);
		aliasesByOwner.delete(ownerId);
		await limiter.dispose();
	},
});

let cachedOwnCgroupPath: string | undefined;

async function ownCgroupPath(): Promise<string> {
	if (cachedOwnCgroupPath !== undefined) return cachedOwnCgroupPath;
	const text = await readOptional("/proc/self/cgroup");
	const v2Line = text?.split("\n").find(line => line.startsWith("0::"));
	cachedOwnCgroupPath = v2Line ? v2Line.slice(3).trim() : "";
	return cachedOwnCgroupPath;
}

async function defaultResolvedEnvironment(): Promise<CpuLimitEnvironment> {
	return { ...defaultCpuLimitEnvironment(), ownCgroupPath: await ownCgroupPath() };
}

function runHostCommand(cmd: string[]): Promise<CpuLimitCommandResult> {
	const { promise, resolve } = Promise.withResolvers<CpuLimitCommandResult>();
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

export interface HarnessWriteSource {
	sessionId(): string | null;
	limits(): SessionBudgetLimits;
}

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
		limiter?.recordHarnessWrite(bytes);
		return result;
	};
}

export function sessionBudgetLimits(settings: Settings): SessionBudgetLimits {
	return {
		writeBudgetGb: settings.get("session.writeBudgetGb"),
		writeBudgetKill: settings.get("session.writeBudgetKill"),
		maxProcesses: settings.get("session.maxProcesses"),
		memoryLimitGb: settings.get("session.memoryLimitGb"),
	};
}

function configuredBudgetLimits(): SessionBudgetLimits | undefined {
	const settings = settingsOrNull();
	return settings ? sessionBudgetLimits(settings) : undefined;
}
