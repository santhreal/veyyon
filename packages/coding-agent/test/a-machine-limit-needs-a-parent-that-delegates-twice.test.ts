/**
 * The machine tier needs TWO levels of delegation, and the probe used to
 * measure one.
 *
 * ## The defect this closes
 *
 * A per-session limit needs one level: a child of the delegated parent that can
 * carry `cpu.max`. A machine limit needs two, because the machine group sits
 * BETWEEN the delegated parent and the session groups. `tryDirectParent` proved
 * only the first and reported the candidate usable for both.
 *
 * On a stock desktop those two answers differ. veyyon runs inside a systemd app
 * scope (`app-gnome-<terminal>-<pid>.scope`), which gives its own children a
 * working `cpu.max` and refuses to delegate `cpu` any further — EACCES writing
 * the child's `cgroup.subtree_control`. Picking that scope put the machine group
 * somewhere it could hold nothing, and every session was placed outside it: the
 * setting was written, the cgroup existed with the right quota, and four CPU
 * burners under a one-core machine cap measured 4.81 cores. After the fix the
 * same run measures 1.01 cores.
 *
 * ## The class, not the incident
 *
 * The invariant is at the choice point, not at the one scope that exposed it:
 * given several usable candidates, the probe takes the closest one that hosts
 * two levels, and falls back to a one-level candidate only when nothing nests —
 * saying so in `detail` rather than reporting a machine cap it cannot hold.
 *
 * ## What it does not catch
 *
 * The kernel's own delegation rules. A tmpdir models "this write fails" with a
 * directory in the way of the control file; it cannot model EACCES from cgroupfs
 * itself. That the selected parent really nests is proved on a live host by
 * .internal/machine-limit-probe.ts and by cpu-limit-real-cgroup.test.ts.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { probeCpuLimitSupport } from "@veyyon/coding-agent/session/cgroup-host";
import { makeCgroupRoot, makeFakeHost, removeCgroupRoots } from "./helpers/fake-cgroup";

/** A cgroup directory with the marker files the probe reads. */
function cgroupDir(dir: string, controllers: string[]): string {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "cgroup.controllers"), controllers.join(" "));
	fs.writeFileSync(path.join(dir, "cgroup.subtree_control"), "");
	fs.writeFileSync(path.join(dir, "cgroup.procs"), "");
	return dir;
}

/**
 * Make `dir` host exactly one level. The probe measures nesting by writing
 * `+cpu` into its probe child's `cgroup.subtree_control`; a DIRECTORY of that
 * name fails the write with EISDIR, which is this harness's stand-in for the
 * EACCES a systemd app scope answers with. The probe child is pre-created for
 * the same reason, so the marker survives the probe's own mkdir.
 */
function refuseSecondLevel(dir: string, uid: number): void {
	fs.mkdirSync(path.join(dir, `.veyyon-cpu-probe-${uid}`, "cgroup.subtree_control"), { recursive: true });
}

afterEach(async () => {
	await removeCgroupRoots();
});

describe("choosing the parent both budget tiers live under", () => {
	it("skips the closest candidate when it hosts one level and a further one hosts two", async () => {
		const root = await makeCgroupRoot();
		const userService = path.join(root, "user.slice", "user-1000.slice", "user@1000.service");
		const appSlice = cgroupDir(path.join(userService, "app.slice"), ["cpu", "memory", "pids"]);
		const scope = cgroupDir(path.join(appSlice, "app-gnome-terminal-1.scope"), ["cpu", "memory", "pids"]);
		cgroupDir(userService, ["cpu", "memory", "pids"]);
		refuseSecondLevel(scope, 1000);

		const host = makeFakeHost(root);
		host.env.ownCgroupPath = path.relative(root, scope);

		const probe = await probeCpuLimitSupport(host.env);

		// The scope is closer and works for a session limit. Taking it costs the
		// machine tier, which is the defect.
		expect(probe.backend).toEqual({ kind: "direct", parentDir: appSlice });
		expect(probe.detail).not.toContain("one level only");
	});

	it("keeps a one-level candidate when nothing nests, and says the machine tier cannot be held", async () => {
		const root = await makeCgroupRoot();
		const scope = cgroupDir(path.join(root, "user.slice", "scope"), ["cpu", "memory", "pids"]);
		refuseSecondLevel(scope, 1000);

		const host = makeFakeHost(root);
		host.env.ownCgroupPath = path.relative(root, scope);

		const probe = await probeCpuLimitSupport(host.env);

		// Still supported: every per-session limit is held there. The machine
		// limit is the part that cannot be, and the detail is what a notice
		// quotes, so it has to say which half is missing.
		expect(probe.supported).toBe(true);
		expect(probe.backend).toEqual({ kind: "direct", parentDir: scope });
		expect(probe.detail).toContain("hosts one level only");
		expect(probe.detail).toContain("per-session limits are held");
	});

	it("takes the closest candidate when it nests, rather than walking further up than it must", async () => {
		const root = await makeCgroupRoot();
		const userService = path.join(root, "user.slice", "user-1000.slice", "user@1000.service");
		const appSlice = cgroupDir(path.join(userService, "app.slice"), ["cpu", "memory", "pids"]);
		const scope = cgroupDir(path.join(appSlice, "app-gnome-terminal-1.scope"), ["cpu", "memory", "pids"]);

		const host = makeFakeHost(root);
		host.env.ownCgroupPath = path.relative(root, scope);

		const probe = await probeCpuLimitSupport(host.env);

		expect(probe.backend).toEqual({ kind: "direct", parentDir: scope });
	});

	it("leaves no probe directory behind, whichever level it measured", async () => {
		const root = await makeCgroupRoot();
		const appSlice = cgroupDir(path.join(root, "user.slice", "user-1000.slice", "user@1000.service", "app.slice"), [
			"cpu",
			"memory",
			"pids",
		]);

		const host = makeFakeHost(root);
		await probeCpuLimitSupport(host.env);

		expect(fs.existsSync(path.join(appSlice, ".veyyon-cpu-probe-1000"))).toBe(false);
	});

	it("still selects a candidate whose probe directory a killed veyyon left behind", async () => {
		const root = await makeCgroupRoot();
		const appSlice = cgroupDir(path.join(root, "user.slice", "user-1000.slice", "user@1000.service", "app.slice"), [
			"cpu",
			"memory",
			"pids",
		]);
		// SIGKILL between mkdir and cleanup. A plain mkdir throws EEXIST here and
		// rejects the one candidate that works, leaving the host with no budget
		// at all until somebody deletes a directory they have never heard of.
		fs.mkdirSync(path.join(appSlice, ".veyyon-cpu-probe-1000"), { recursive: true });

		const host = makeFakeHost(root);
		const probe = await probeCpuLimitSupport(host.env);

		expect(probe.backend).toEqual({ kind: "direct", parentDir: appSlice });
	});
});
