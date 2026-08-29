import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CpuBudgetGroup as NativeCpuBudgetGroup } from "@veyyon/natives";
import { errorMessage } from "@veyyon/utils/type-guards";

export const CPU_LIMIT_PERIOD_USEC = 100_000;

export const CPU_LIMIT_WATCH_INTERVAL_MS = 1_000;

export const CPU_LIMIT_WINDOW_SAMPLES = 3;

export const SATURATION_RATIO = 0.95;

export const CPU_LIMIT_SATURATION_NICE = 10;

export function formatCpuMaxValue(cores: number): string {
	if (!Number.isFinite(cores) || cores <= 0) return `max ${CPU_LIMIT_PERIOD_USEC}`;
	const quota = Math.max(1, Math.round(cores * CPU_LIMIT_PERIOD_USEC));
	return `${quota} ${CPU_LIMIT_PERIOD_USEC}`;
}

export function formatSystemdCpuQuota(cores: number): string | undefined {
	if (!Number.isFinite(cores) || cores <= 0) return undefined;
	const percent = Math.min(1e18, Math.max(0.001, cores * 100));
	const rendered = Number.isInteger(percent)
		? String(percent)
		: percent
				.toFixed(6)
				.replace(/\.0+$/, "")
				.replace(/(\.\d*?)0+$/, "$1");
	return `CPUQuota=${rendered}%`;
}

export interface CpuLimitCommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface CpuLimitEnvironment {
	platform: string;
	uid: number;
	cgroupRoot: string;
	ownCgroupPath: string;
	run(cmd: string[]): Promise<CpuLimitCommandResult>;
	kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
	now(): number;
	procRoot: string;
	removeDir(dir: string): Promise<void>;
}

export type CpuLimitBackend =
	| { kind: "direct"; parentDir: string }
	| { kind: "systemd-run" }
	| { kind: "job-object" }
	| { kind: "tracked" };

export interface CgroupControllerCapabilities {
	cpu: boolean;
	pids: boolean;
	memory: boolean;
}

export interface CpuLimitProbe {
	supported: boolean;
	throttles: boolean;
	backend: CpuLimitBackend | null;
	kernelLimits: CgroupControllerCapabilities;
	detail: string;
}

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

export interface CpuBudgetGroupSpec {
	name: string;
	cores: number;
	cgroupParentDir?: string;
	existingCgroupDir?: string;
	trackedOnly?: boolean;
}

export function createNativeBudgetGroup(spec: CpuBudgetGroupSpec): CpuBudgetGroupHandle {
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

export async function readOptional(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, "utf8");
	} catch {
		return undefined;
	}
}

export function limitFileValue(value: number): string {
	return value > 0 ? String(Math.floor(value)) : "max";
}

async function tryDirectParent(
	env: CpuLimitEnvironment,
	dir: string,
): Promise<CgroupControllerCapabilities | null> {
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

export function unsupported(detail: string): CpuLimitProbe {
	return {
		supported: false,
		throttles: false,
		backend: null,
		kernelLimits: { cpu: false, pids: false, memory: false },
		detail,
	};
}

export async function probeCpuLimitSupport(env: CpuLimitEnvironment): Promise<CpuLimitProbe> {
	if (env.platform === "win32") {
		return {
			supported: true,
			throttles: true,
			backend: { kind: "job-object" },
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
