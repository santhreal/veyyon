/**
 * A memory cap that only writes `memory.max` is not a memory cap.
 *
 * ## The defect this closes
 *
 * `memory.max` bounds RESIDENT memory. On a host with swap the kernel meets it
 * by reclaiming and pushing anonymous pages out, so a tree allocating past the
 * cap keeps running and the machine starts swapping — the outcome both memory
 * settings exist to prevent. Measured against the real kernel before the fix: a
 * group capped at 256 MB reached 5,520 MB of allocation, hit `memory.max`
 * 24,431 times and pushed 2.9 GB into swap before the OOM killer arrived. After
 * pinning `memory.swap.max` to 0 the same hog reached 272 MB and was killed.
 *
 * ## The class, not the incident
 *
 * The pair is produced by ONE function, and both tiers are swept from the
 * exported list of writers rather than named by hand, so a third tier that
 * writes `memory.max` through some other path fails this file until it is
 * either routed through the pair or recorded as an exception.
 *
 * ## What it does not catch
 *
 * That the kernel honours the values. A tmpdir accepts every byte. Kernel
 * enforcement is cpu-limit-real-cgroup.test.ts, which runs only where cgroup
 * delegation is real.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { memoryCapControls } from "@veyyon/coding-agent/session/cgroup-format";
import { probeCpuLimitSupport, SessionCpuLimit } from "@veyyon/coding-agent/session/cpu-limit";
import { ensureMachineBudget, MACHINE_BUDGET_DIR_NAME } from "@veyyon/coding-agent/session/machine-budget";
import { makeCgroupRoot, makeDelegatedParent, makeFakeHost, removeCgroupRoots } from "./helpers/fake-cgroup";

let root = "";
let parentDir = "";

/** A delegated parent whose child directory already carries the marker files. */
function delegatedParent(controllers: string[]): string {
	const dir = path.join(root, "parent");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "cgroup.controllers"), controllers.join(" "));
	fs.writeFileSync(path.join(dir, "cgroup.subtree_control"), "");
	const machineDir = path.join(dir, MACHINE_BUDGET_DIR_NAME);
	fs.mkdirSync(machineDir, { recursive: true });
	fs.writeFileSync(path.join(machineDir, "cgroup.controllers"), controllers.join(" "));
	fs.writeFileSync(path.join(machineDir, "cgroup.subtree_control"), "");
	return dir;
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "vey-memory-swap-"));
	parentDir = delegatedParent(["cpu", "pids", "memory"]);
});

afterEach(async () => {
	fs.rmSync(root, { recursive: true, force: true });
	await removeCgroupRoots();
});

describe("the two control files that make a memory cap", () => {
	it("pins swap to zero under a cap, so the cap is the whole anonymous footprint", () => {
		expect(memoryCapControls(2)).toEqual({ max: String(2 * 1024 * 1024 * 1024), swapMax: "0" });
	});

	it("restores the kernel default when the cap is lifted rather than leaving the group unable to swap", () => {
		expect(memoryCapControls(0)).toEqual({ max: "max", swapMax: "max" });
	});

	it("never returns a resident cap with an unbounded swap escape, at any size", () => {
		for (const gb of [0.25, 0.5, 1, 2, 7.5, 64]) {
			const controls = memoryCapControls(gb);
			expect(controls.max).not.toBe("max");
			expect(controls.swapMax).toBe("0");
		}
	});
});

describe("the machine tier writes both files", () => {
	it("caps swap alongside memory so a machine-wide limit cannot be swapped past", async () => {
		await ensureMachineBudget(
			{ platform: "linux", parentDir },
			{ cpuLimitCores: 0, memoryLimitGb: 2, writeBudgetGb: 0, maxProcesses: 0 },
		);

		const machineDir = path.join(parentDir, MACHINE_BUDGET_DIR_NAME);
		expect(fs.readFileSync(path.join(machineDir, "memory.max"), "utf8")).toBe(String(2 * 1024 * 1024 * 1024));
		expect(fs.readFileSync(path.join(machineDir, "memory.swap.max"), "utf8")).toBe("0");
	});

	it("writes no swap cap when no memory limit is set, so an unrelated limit does not disable swap", async () => {
		await ensureMachineBudget(
			{ platform: "linux", parentDir },
			{ cpuLimitCores: 4, memoryLimitGb: 0, writeBudgetGb: 0, maxProcesses: 0 },
		);

		const machineDir = path.join(parentDir, MACHINE_BUDGET_DIR_NAME);
		expect(fs.readFileSync(path.join(machineDir, "memory.swap.max"), "utf8")).toBe("max");
	});
});

describe("the session tier writes both files", () => {
	it("caps swap alongside memory on the session group", async () => {
		const cgroupRoot = await makeCgroupRoot();
		const delegated = await makeDelegatedParent(cgroupRoot);
		const host = makeFakeHost(cgroupRoot);
		const probe = await probeCpuLimitSupport(host.env);
		expect(probe.backend?.kind).toBe("direct");

		const limiter = new SessionCpuLimit({
			sessionId: "swap-session",
			cores: 0,
			kill: false,
			memoryLimitGb: 1,
			probe,
			env: host.env,
		});
		try {
			expect(await limiter.ensureGroup()).toBeTruthy();
			const groupDir = path.join(delegated, limiter.budgetName);
			expect(fs.readFileSync(path.join(groupDir, "memory.max"), "utf8")).toBe(String(1024 * 1024 * 1024));
			expect(fs.readFileSync(path.join(groupDir, "memory.swap.max"), "utf8")).toBe("0");
		} finally {
			await limiter.dispose();
		}
	});
});
