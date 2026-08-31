/**
 * What THIS host offers the budget system, and how to ask it.
 *
 * Two things live here and nothing else: the environment seam the budget code
 * runs against, and the once-per-process probe that measures what the kernel
 * on the other side of that seam will actually hold. Both are about the host.
 * Neither knows a session exists.
 *
 * The split matters because the two questions fail independently and are
 * answered at different times. "Can this machine hold a CPU quota?" is a
 * property of the kernel, the cgroup layout and the delegation somebody else
 * configured; it is measured once, against real writes to a real probe child,
 * because cgroup v2's rules are not visible from permission bits. "How much
 * CPU may this session tree use?" is a setting, and it is meaningless until
 * the first question has an answer.
 *
 * Everything the probe reports is measured, never inferred. A capability it
 * could not prove is reported false, and a configured limit standing on a
 * false capability is reported unheld rather than passing as applied.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
// Owner, not the `@veyyon/utils` barrel: 1 module against 81.
import { errorMessage } from "@veyyon/utils/type-guards";
import { formatCpuMaxValue } from "./cgroup-format";

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
	kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
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
 * Which of the group's limits the KERNEL will hold, per controller. cgroup v2
 * delegation is per controller and a stock systemd user session hands out
 * `cpu memory pids` and not `io`, so this is measured against a real probe
 * child rather than inferred from the backend or from one controller's
 * presence. Everything false is the honest reading for a backend that has no
 * cgroup at all.
 */
export interface CgroupControllerCapabilities {
	cpu: boolean;
	pids: boolean;
	memory: boolean;
}

/** What a candidate delegated parent can host, measured against a probe child. */
interface DirectParentCapabilities extends CgroupControllerCapabilities {
	/**
	 * A grandchild of this directory can carry a quota, so a machine group can
	 * sit between it and the session groups. False on a systemd app scope,
	 * which hosts one level and refuses to delegate further.
	 */
	nestable: boolean;
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

async function readOptional(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Which limits `dir` can host for a session cgroup, or null when it cannot
 * host one at all. `cpu` is the qualifying controller: without it there is no
 * CPU budget and the candidate is rejected outright, which is what picks the
 * `direct` backend. `pids` and `memory` are then probed the SAME way rather
 * than assumed from cpu, because delegation is per controller: a stock
 * systemd user session gets `cpu memory pids` and no `io`, and a container
 * can get any subset.
 *
 * Each step is tried for real against a probe child because the cgroup v2
 * delegation rules (no internal processes, controller must be delegated by
 * the parent) are not visible from permission bits alone. The probe child is
 * removed before returning, pass or fail.
 */
async function tryDirectParent(env: CpuLimitEnvironment, dir: string): Promise<DirectParentCapabilities | null> {
	const controllers = (await readOptional(path.join(dir, "cgroup.controllers")))?.split(/\s+/) ?? [];
	if (!controllers.includes("cpu")) return null;
	const probeChild = path.join(dir, `.veyyon-cpu-probe-${env.uid}`);
	const probeGrandchild = path.join(probeChild, "nested");
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
	// Can a GRANDCHILD of `dir` carry a quota? The machine tier is a group
	// between this directory and the session groups, so it needs two levels
	// where a session limit alone needs one, and they are not the same
	// question. A systemd app scope gives its own children a working `cpu.max`
	// and refuses to let one of them delegate cpu further — EACCES writing the
	// child's `cgroup.subtree_control` — and that scope is the cgroup veyyon
	// runs in on a stock desktop. Reading one level as two put the machine
	// group under that scope, where it could hold nothing, so the machine
	// limits did nothing at all on the configuration operators actually run.
	const nest = async (): Promise<boolean> => {
		try {
			await fs.writeFile(path.join(probeChild, "cgroup.subtree_control"), "+cpu");
			await fs.mkdir(probeGrandchild);
			await fs.writeFile(path.join(probeGrandchild, "cpu.max"), formatCpuMaxValue(1));
			return true;
		} catch {
			return false;
		} finally {
			await env.removeDir(probeGrandchild).catch(() => {});
		}
	};
	try {
		// `recursive` because the probe child SURVIVES a killed veyyon: the
		// cleanup below never runs on SIGKILL, and a plain mkdir then throws
		// EEXIST on every later probe, rejecting the one candidate that works
		// and degrading the host to no budget at all until somebody removes a
		// directory they have never heard of.
		await fs.mkdir(probeChild, { recursive: true });
		const cpu = await delegate("cpu", "cpu.max", formatCpuMaxValue(1));
		if (!cpu) return null;
		return {
			cpu,
			pids: await delegate("pids", "pids.max", "max"),
			memory: await delegate("memory", "memory.max", "max"),
			nestable: await nest(),
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
	// Two passes, not one. A candidate that hosts only one level still carries
	// every per-session limit, so it must not be discarded, but taking it when a
	// later candidate hosts two silently costs the machine tier. The list is in
	// closeness order, so the first nestable candidate is the closest one that
	// can hold both tiers; the fallback keeps the previous behaviour for a host
	// where nothing nests.
	let fallback: { dir: string; kernelLimits: DirectParentCapabilities } | undefined;
	// `nestable` is how a candidate was CHOSEN, not a limit the kernel holds, so
	// it stays out of the reported capabilities: a caller reading kernelLimits is
	// asking which of cpu, pids and memory apply.
	const held = ({ cpu, pids, memory }: DirectParentCapabilities): CgroupControllerCapabilities => ({
		cpu,
		pids,
		memory,
	});
	for (const dir of candidates) {
		const capabilities = await tryDirectParent(env, dir);
		if (!capabilities) continue;
		if (!capabilities.nestable) {
			fallback ??= { dir, kernelLimits: capabilities };
			continue;
		}
		return {
			supported: true,
			throttles: true,
			backend: { kind: "direct", parentDir: dir },
			kernelLimits: held(capabilities),
			detail: `direct cgroup writes under ${dir}`,
		};
	}
	if (fallback) {
		return {
			supported: true,
			throttles: true,
			backend: { kind: "direct", parentDir: fallback.dir },
			kernelLimits: held(fallback.kernelLimits),
			detail:
				`direct cgroup writes under ${fallback.dir}, which hosts one level only: ` +
				`per-session limits are held, and a machine-wide limit cannot be`,
		};
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

// ---------------------------------------------------------------------------
// Production environment
// ---------------------------------------------------------------------------

let cachedOwnCgroupPath: string | undefined;

function ownCgroupPath(): string {
	if (cachedOwnCgroupPath !== undefined) return cachedOwnCgroupPath;
	let text: string | undefined;
	try {
		text = readFileSync("/proc/self/cgroup", "utf8");
	} catch {
		text = undefined;
	}
	// cgroup v2 collapses the hierarchy to one line: `0::/user.slice/...`.
	const v2Line = text?.split("\n").find(line => line.startsWith("0::"));
	cachedOwnCgroupPath = v2Line ? v2Line.slice(3).trim() : "";
	return cachedOwnCgroupPath;
}

/**
 * The production environment, complete. Use this rather than
 * {@link defaultCpuLimitEnvironment}, whose `ownCgroupPath` is `""` for
 * "unknown": a probe run against that skeleton skips the harness's OWN cgroup
 * and its parent, which are the first two candidates production tries and the
 * only ones a container has, so it reports unsupported exactly where
 * production works.
 *
 * Synchronous on purpose. `initSessionCpuLimit` is launched with `void` from
 * the `AgentSession` constructor and must reach `limiters.set` before it
 * yields, or a spawn site that resolves the limiter by session id in the same
 * tick finds nothing registered and runs the command outside every budget.
 * The cost is one memoized read of a 64-byte procfs file per process.
 */
export function resolveCpuLimitEnvironment(): CpuLimitEnvironment {
	return { ...defaultCpuLimitEnvironment(), ownCgroupPath: ownCgroupPath() };
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
