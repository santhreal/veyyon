/**
 * A tmpdir standing in for a cgroup v2 mount, for suites that drive the REAL
 * native Linux budget backend without root and without delegation.
 *
 * The native backend (`crates/veyyon-shell/src/cpu_budget/linux.rs`) only ever
 * does ordinary filesystem work: `mkdir` the group, write `cpu.max`, write a
 * pid into `cgroup.procs`, read `cpu.stat`. A plain directory with the two
 * marker files the probe looks for is therefore indistinguishable from a real
 * delegated parent as far as that code is concerned, which is what lets the
 * adoption wiring be proved on a host with no delegation at all. What a fake
 * tree canNOT prove is that the kernel enforces the quota; that lives in
 * cpu-limit-real-cgroup.test.ts and runs only where delegation is real.
 *
 * Shared by cpu-limit.test.ts and cpu-limit-adoption.test.ts. It exists as one
 * module rather than two copies because the two suites must agree on the
 * layout the probe walks: a divergence would make one of them pass against a
 * tree the production probe would reject.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CpuLimitCommandResult, CpuLimitEnvironment } from "../../src/session/cpu-limit";

/** Every root handed out by {@link makeCgroupRoot}, for teardown. */
const roots: string[] = [];

/** A tmpdir with the one root file that marks a cgroup v2 mount. */
export async function makeCgroupRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-cpu-limit-test-"));
	roots.push(root);
	await fs.writeFile(path.join(root, "cgroup.controllers"), "cpu io memory pids\n");
	return root;
}

/** The delegated user tree the direct backend prefers, with `cpu` available. */
export async function makeDelegatedParent(root: string): Promise<string> {
	const parent = path.join(root, "user.slice", "user-1000.slice", "user@1000.service", "app.slice");
	await fs.mkdir(parent, { recursive: true });
	await fs.writeFile(path.join(parent, "cgroup.controllers"), "cpu io memory pids\n");
	await fs.writeFile(path.join(parent, "cgroup.subtree_control"), "");
	await fs.writeFile(path.join(parent, "cgroup.procs"), "");
	return parent;
}

/** Remove every tree {@link makeCgroupRoot} created. Call from `afterEach`. */
export async function removeCgroupRoots(): Promise<void> {
	for (const root of roots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
}

export interface FakeHost {
	env: CpuLimitEnvironment;
	killed: Array<{ pid: number; signal: string }>;
	ran: string[][];
	clock: { now: number };
}

/**
 * A `CpuLimitEnvironment` rooted at `root`, with a scriptable `run`, a
 * recording `kill` and a clock the test advances by hand. `run` defaults to
 * "no systemd user manager", which is what forces the probe onto the direct
 * cgroup backend the fake tree models. `procRoot` defaults to a path that
 * does not exist, so a suite that has not built a fake procfs reads the
 * honest "no /proc/<pid>/io here" rather than this machine's real one.
 */
export function makeFakeHost(root: string, runScript?: (cmd: string[]) => CpuLimitCommandResult): FakeHost {
	const host: FakeHost = {
		killed: [],
		ran: [],
		clock: { now: 0 },
		env: undefined as unknown as CpuLimitEnvironment,
	};
	const script = runScript ?? ((): CpuLimitCommandResult => ({ code: 1, stdout: "", stderr: "no user manager" }));
	host.env = {
		platform: "linux",
		uid: 1000,
		cgroupRoot: root,
		ownCgroupPath: "",
		procRoot: path.join(root, "no-such-proc"),
		run: async cmd => {
			host.ran.push(cmd);
			return script(cmd);
		},
		kill: (pid, signal) => {
			host.killed.push({ pid, signal });
		},
		now: () => host.clock.now,
		removeDir: dir => fs.rm(dir, { recursive: true, force: true }),
	};
	return host;
}
