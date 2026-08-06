/**
 * SessionCpuLimit against a fake cgroup v2 tree (a tmpdir standing in for
 * /sys/fs/cgroup) driving the REAL native Linux backend: quota bytes, deny
 * text, kill text, renice policy, recovery, cleanup.
 *
 * The tree fixture lives in ./helpers/fake-cgroup, shared with
 * cpu-limit-adoption.test.ts, which proves the spawn sites actually adopt
 * into a group of this shape. The real-cgroup integration proof, where the
 * kernel does the throttling, is cpu-limit-real-cgroup.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	CPU_LIMIT_PERIOD_USEC,
	CPU_LIMIT_SATURATION_NICE,
	type CpuBudgetGroupHandle,
	CpuLimitDeniedError,
	formatCpuMaxValue,
	initSessionCpuLimit,
	probeCpuLimitSupport,
	SessionCpuLimit,
	sessionCpuBudgetName,
	sessionCpuLimit,
} from "../src/session/cpu-limit";
import { disposeOwnedResources } from "../src/session/owned-resources";
import {
	type FakeHost,
	makeCgroupRoot,
	makeDelegatedParent,
	makeFakeHost,
	removeCgroupRoots,
} from "./helpers/fake-cgroup";

afterEach(removeCgroupRoots);

/** The session cgroup directory the native Linux backend creates under `parent`. */
function sessionCgroupDir(parent: string, sessionId: string): string {
	return path.join(parent, sessionCpuBudgetName(sessionId));
}

async function makeLimiter(
	host: FakeHost,
	options: {
		cores: number;
		kill?: boolean;
		sessionId?: string;
		onNotice?: (text: string) => void;
		createGroup?: (spec: { name: string; cores: number }) => CpuBudgetGroupHandle;
	},
): Promise<SessionCpuLimit> {
	const probe = await probeCpuLimitSupport(host.env);
	return new SessionCpuLimit({
		sessionId: options.sessionId ?? "sess-test",
		cores: options.cores,
		kill: options.kill ?? false,
		probe,
		env: host.env,
		onNotice: options.onNotice,
		createGroup: options.createGroup,
		windowSamples: 3,
		watchIntervalMs: 1_000,
	});
}

/**
 * Drive the watcher through one-second samples. Each entry is the usage_usec
 * and nr_throttled pair the kernel would report at that second.
 */
async function driveWatcher(
	host: FakeHost,
	limiter: SessionCpuLimit,
	cgroupDir: string,
	steps: Array<{ usageUsec: number; throttled: number }>,
): Promise<void> {
	for (const step of steps) {
		await fs.writeFile(
			path.join(cgroupDir, "cpu.stat"),
			`usage_usec ${step.usageUsec}\nnr_throttled ${step.throttled}\n`,
		);
		host.clock.now += 1_000;
		await limiter.pollOnce();
	}
}

describe("formatCpuMaxValue", () => {
	/**
	 * A core count becomes a quota over the FIXED 100ms period.
	 *
	 * These are the exact bytes written to `cpu.max`, and the kernel reads them
	 * literally: get the period wrong and the cap is off by that factor with no
	 * error anywhere, because both numbers are valid. Every expectation here is
	 * a literal rather than an expression over `CPU_LIMIT_PERIOD_USEC`, so a
	 * change to the period has to be made deliberately in two places instead of
	 * being followed silently by the test.
	 */
	it("expresses N cores as an N*period quota over the fixed 100ms period", () => {
		expect(CPU_LIMIT_PERIOD_USEC).toBe(100_000);
		expect(formatCpuMaxValue(2)).toBe("200000 100000");
		expect(formatCpuMaxValue(1)).toBe("100000 100000");
		expect(formatCpuMaxValue(16)).toBe("1600000 100000");
	});

	/**
	 * A fractional budget survives to `cpu.max` as a whole number of
	 * microseconds.
	 *
	 * Sub-core budgets are a supported setting and the one the real-cgroup
	 * enforcement test runs at, so this is a shipped path, not a curiosity.
	 * `cpu.max` accepts only integers: emit `50000.5` and the write is rejected
	 * with EINVAL, which surfaces as "the limit did nothing" rather than as a
	 * settings error. The rounding is what keeps every fraction writable.
	 */
	it("rounds a fractional core budget to whole microseconds", () => {
		expect(formatCpuMaxValue(0.5)).toBe("50000 100000");
		expect(formatCpuMaxValue(0.25)).toBe("25000 100000");
		// 0.155 * 100000 is 15500.000000000002 in binary floating point.
		expect(formatCpuMaxValue(0.155)).toBe("15500 100000");
		// 0.29 * 100000 is 28999.999999999996: truncating loses a microsecond
		// on a perfectly ordinary setting.
		expect(formatCpuMaxValue(0.29)).toBe("29000 100000");
		// Fractions with no exact microsecond round to nearest, both ways.
		expect(formatCpuMaxValue(1 / 3)).toBe("33333 100000");
		expect(formatCpuMaxValue(2 / 3)).toBe("66667 100000");
	});
});

describe("probeCpuLimitSupport", () => {
	it("selects a Job Object backend on Windows", async () => {
		const root = await makeCgroupRoot();
		const host = makeFakeHost(root);
		const probe = await probeCpuLimitSupport({ ...host.env, platform: "win32" });
		expect(probe.supported).toBe(true);
		expect(probe.throttles).toBe(true);
		expect(probe.backend).toEqual({ kind: "job-object" });
	});

	it("selects the policy-only backend on macOS and says there is no throttle", async () => {
		const root = await makeCgroupRoot();
		const host = makeFakeHost(root);
		const probe = await probeCpuLimitSupport({ ...host.env, platform: "darwin" });
		expect(probe.supported).toBe(true);
		expect(probe.throttles).toBe(false);
		expect(probe.backend).toEqual({ kind: "tracked" });
		expect(probe.detail).toContain("no per-group CPU quota");
	});

	it("reports unsupported on platforms with no backend at all", async () => {
		const root = await makeCgroupRoot();
		const host = makeFakeHost(root);
		const probe = await probeCpuLimitSupport({ ...host.env, platform: "freebsd" });
		expect(probe.supported).toBe(false);
		expect(probe.detail).toContain("freebsd");
	});

	it("reports unsupported on Linux when no cgroup v2 mount is present", async () => {
		// A registered tmpdir with the cgroup v2 marker file removed: the shape a
		// v1 or hybrid hierarchy presents, where there is no cpu.max to write.
		const root = await makeCgroupRoot();
		await fs.rm(path.join(root, "cgroup.controllers"));
		const host = makeFakeHost(root);
		const probe = await probeCpuLimitSupport(host.env);
		expect(probe.supported).toBe(false);
		expect(probe.detail).toContain("cgroups v2 is not mounted");
	});

	it("selects the direct backend when a delegated parent takes a cpu.max write", async () => {
		const root = await makeCgroupRoot();
		const parent = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const probe = await probeCpuLimitSupport(host.env);
		expect(probe.supported).toBe(true);
		expect(probe.backend).toEqual({ kind: "direct", parentDir: parent });
		// The probe proves writability but must leave no probe child behind.
		const leftovers = (await fs.readdir(parent)).filter(name => name.includes("veyyon-cpu-probe"));
		expect(leftovers).toEqual([]);
	});

	it("falls back to systemd-run when no delegated parent works and a user manager answers", async () => {
		const root = await makeCgroupRoot();
		const host = makeFakeHost(root, cmd =>
			cmd[0] === "systemctl" ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "" },
		);
		const probe = await probeCpuLimitSupport(host.env);
		expect(probe.supported).toBe(true);
		expect(probe.backend).toEqual({ kind: "systemd-run" });
		expect(probe.detail).toContain("systemd");
	});

	it("reports unsupported with both reasons when neither Linux backend works", async () => {
		const root = await makeCgroupRoot();
		const host = makeFakeHost(root);
		const probe = await probeCpuLimitSupport(host.env);
		expect(probe.supported).toBe(false);
		expect(probe.detail).toContain("cpu controller");
		expect(probe.detail).toContain("systemctl --user failed");
	});
});

describe("SessionCpuLimit group lifecycle", () => {
	it("writes the exact cpu.max bytes for the configured cores on first capped spawn", async () => {
		const root = await makeCgroupRoot();
		const parent = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const limiter = await makeLimiter(host, { cores: 2 });

		const group = await limiter.ensureGroup();
		expect(group).toBeDefined();
		const dir = sessionCgroupDir(parent, "sess-test");
		expect(await fs.readFile(path.join(dir, "cpu.max"), "utf8")).toBe("200000 100000");
		// The parent must delegate cpu downward, or the child quota is inert.
		expect(await fs.readFile(path.join(parent, "cgroup.subtree_control"), "utf8")).toBe("+cpu");
		await limiter.dispose();
	});

	it("adopts a spawned pid by writing it to cgroup.procs", async () => {
		const root = await makeCgroupRoot();
		const parent = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const limiter = await makeLimiter(host, { cores: 1 });

		await limiter.adoptPid(4242);
		const dir = sessionCgroupDir(parent, "sess-test");
		expect(await fs.readFile(path.join(dir, "cgroup.procs"), "utf8")).toBe("4242");
		await limiter.dispose();
	});

	it("stays inert when cores is 0: no group, no adoption", async () => {
		const root = await makeCgroupRoot();
		const parent = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const limiter = await makeLimiter(host, { cores: 0 });

		expect(await limiter.ensureGroup()).toBeUndefined();
		await limiter.adoptPid(4242);
		expect(await fs.readdir(parent)).not.toContain(sessionCpuBudgetName("sess-test"));
		await limiter.dispose();
	});

	it("removes the cgroup on dispose and reparents surviving pids", async () => {
		const root = await makeCgroupRoot();
		const parent = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const limiter = await makeLimiter(host, { cores: 2 });

		await limiter.ensureGroup();
		const dir = sessionCgroupDir(parent, "sess-test");
		await fs.writeFile(path.join(dir, "cgroup.procs"), "4242\n");
		await limiter.dispose();

		expect(await fs.stat(dir).catch(() => null)).toBeNull();
		expect(await fs.readFile(path.join(parent, "cgroup.procs"), "utf8")).toBe("4242");
	});

	it("update() rewrites the quota on a live group and lifts it at 0 cores", async () => {
		const root = await makeCgroupRoot();
		const parent = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const limiter = await makeLimiter(host, { cores: 2 });

		await limiter.ensureGroup();
		const dir = sessionCgroupDir(parent, "sess-test");
		await limiter.update(4, false);
		expect(await fs.readFile(path.join(dir, "cpu.max"), "utf8")).toBe("400000 100000");
		await limiter.update(0, false);
		expect(await fs.readFile(path.join(dir, "cpu.max"), "utf8")).toBe("max 100000");
		await limiter.dispose();
	});

	/**
	 * WHY: `systemd-run --scope` runs its command in the foreground, so the `sleep infinity`
	 * placeholder that holds the unit open never returns. The 10s execFile deadline killed it,
	 * setup was marked failed for the rest of the session, and the budget silently enforced
	 * nothing on every host that reached this backend. Verified against real systemd:
	 * `--scope ... -- sleep infinity` exits 124 under a 5s timeout, while the same command
	 * without `--scope` returns 0 immediately and applies `cpu.max = 50000 100000`.
	 * The unit must therefore be a transient service, and the argv must never regrow `--scope`.
	 */
	it("creates a systemd transient service with CPUQuota, never a blocking scope", async () => {
		const root = await makeCgroupRoot();
		const unitRel = "/user.slice/user-1000.slice/user@1000.service/app.slice/veyyon-cpu-sess-test.service";
		const host = makeFakeHost(root, cmd => {
			if (cmd[0] === "systemd-run") return { code: 0, stdout: "", stderr: "" };
			if (cmd[0] === "systemctl" && cmd.includes("show")) return { code: 0, stdout: `${unitRel}\n`, stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		});
		// The native group verifies the unit cgroup exists before managing it.
		await fs.mkdir(path.join(root, unitRel), { recursive: true });
		await fs.writeFile(path.join(root, unitRel, "cgroup.procs"), "");
		const probe = await probeCpuLimitSupport(host.env);
		expect(probe.backend?.kind).toBe("systemd-run");
		const limiter = new SessionCpuLimit({
			sessionId: "sess-test",
			cores: 2,
			kill: false,
			probe,
			env: host.env,
			windowSamples: 3,
		});

		await limiter.ensureGroup();
		const systemdRun = host.ran.find(cmd => cmd[0] === "systemd-run");
		expect(systemdRun).toContain("CPUQuota=200%");
		expect(systemdRun).not.toContain("--scope");

		// Every unit the limiter names afterwards is the same transient service.
		const shown = host.ran.find(cmd => cmd[0] === "systemctl" && cmd.includes("show"));
		expect(shown).toContain("veyyon-cpu-sess-test.service");

		await limiter.dispose();
		const stop = host.ran.find(cmd => cmd[0] === "systemctl" && cmd.includes("stop"));
		expect(stop).toContain("veyyon-cpu-sess-test.service");
	});
});

describe("SessionCpuLimit watcher policy", () => {
	/** Three one-second samples at 3 cores against a 2-core budget, throttled throughout. */
	const saturatedSteps = [
		{ usageUsec: 3_000_000, throttled: 1 },
		{ usageUsec: 6_000_000, throttled: 2 },
		{ usageUsec: 9_000_000, throttled: 3 },
	];

	async function makeSaturatedLimiter(
		host: FakeHost,
		parent: string,
		options: { kill?: boolean; onNotice?: (text: string) => void },
	): Promise<{ limiter: SessionCpuLimit; dir: string }> {
		const limiter = await makeLimiter(host, { cores: 2, ...options });
		await limiter.ensureGroup();
		const dir = sessionCgroupDir(parent, "sess-test");
		await fs.writeFile(path.join(dir, "cpu.stat"), "usage_usec 0\nnr_throttled 0\n");
		host.clock.now += 1_000;
		await limiter.pollOnce(); // baseline sample
		await driveWatcher(host, limiter, dir, saturatedSteps);
		return { limiter, dir };
	}

	it("denies new spawns with the budget, the measured usage, and the fix", async () => {
		const root = await makeCgroupRoot();
		const parent = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const notices: string[] = [];
		const { limiter } = await makeSaturatedLimiter(host, parent, { onNotice: text => notices.push(text) });

		let text = "";
		try {
			limiter.assertMaySpawn("a bash command");
		} catch (error) {
			text = error instanceof Error ? error.message : String(error);
		}
		expect(text).toContain("Refused to start a bash command");
		expect(text).toContain("2 core(s)");
		expect(text).toContain("~3.00 cores");
		expect(text).toContain("session.cpuLimitCores");
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("CPU budget saturated");
		expect(notices[0]).toContain("session.cpuLimitKill");
		expect(host.killed).toHaveLength(0);
		await limiter.dispose();
	});

	it("kills the group members with a budget-named report when the kill toggle is on", async () => {
		const root = await makeCgroupRoot();
		const parent = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const notices: string[] = [];
		const limiter = await makeLimiter(host, { cores: 2, kill: true, onNotice: text => notices.push(text) });

		await limiter.ensureGroup();
		const dir = sessionCgroupDir(parent, "sess-test");
		await fs.writeFile(path.join(dir, "cpu.stat"), "usage_usec 0\nnr_throttled 0\n");
		await fs.writeFile(path.join(dir, "cgroup.procs"), "4242\n4343\n");
		host.clock.now += 1_000;
		await limiter.pollOnce(); // baseline sample
		await driveWatcher(host, limiter, dir, saturatedSteps);

		expect(host.killed).toEqual([
			{ pid: 4242, signal: "SIGTERM" },
			{ pid: 4343, signal: "SIGTERM" },
		]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("SIGTERM");
		expect(notices[0]).toContain("2 core(s)");
		expect(notices[0]).toContain("~3.00 cores");
		expect(notices[0]).toContain("session.cpuLimitKill");
		expect(notices[0]).toContain("not a crash");

		const report = limiter.consumeKillReport();
		expect(report).toContain("CPU budget");
		expect(limiter.consumeKillReport()).toBeUndefined();
		await limiter.dispose();
	});

	it("does not kill when the kill toggle is off, even while denying", async () => {
		const root = await makeCgroupRoot();
		const parent = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const { limiter } = await makeSaturatedLimiter(host, parent, {});

		expect(() => limiter.assertMaySpawn("a bash command")).toThrow(CpuLimitDeniedError);
		expect(host.killed).toHaveLength(0);
		await limiter.dispose();
	});

	it("clears the denial once usage drops below the budget", async () => {
		const root = await makeCgroupRoot();
		const parent = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const { limiter, dir } = await makeSaturatedLimiter(host, parent, {});
		expect(() => limiter.assertMaySpawn("a bash command")).toThrow(CpuLimitDeniedError);

		// Three idle seconds: usage stops growing, nothing new is throttled.
		await driveWatcher(host, limiter, dir, [
			{ usageUsec: 9_100_000, throttled: 3 },
			{ usageUsec: 9_200_000, throttled: 3 },
			{ usageUsec: 9_300_000, throttled: 3 },
		]);
		limiter.assertMaySpawn("a bash command");
		await limiter.dispose();
	});

	it("a full-speed burst that never trips the quota never denies", async () => {
		const root = await makeCgroupRoot();
		const parent = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const limiter = await makeLimiter(host, { cores: 2 });

		await limiter.ensureGroup();
		const dir = sessionCgroupDir(parent, "sess-test");
		await fs.writeFile(path.join(dir, "cpu.stat"), "usage_usec 0\nnr_throttled 0\n");
		host.clock.now += 1_000;
		await limiter.pollOnce();
		// Sustained high usage but nr_throttled stays flat: the kernel does not
		// see demand past the quota, so the watcher must not either.
		await driveWatcher(host, limiter, dir, [
			{ usageUsec: 2_000_000, throttled: 0 },
			{ usageUsec: 4_000_000, throttled: 0 },
			{ usageUsec: 6_000_000, throttled: 0 },
		]);
		limiter.assertMaySpawn("a bash command");
		await limiter.dispose();
	});

	/**
	 * A throttling backend saturates at EXACTLY 95% of the budget, and one
	 * microsecond under 95% is not saturation.
	 *
	 * The ratio exists because a throttled group hovers just under its own
	 * quota rather than reaching it: accounting granularity means a group
	 * pinned at the wall reports something like 1.97 of 2 cores, never 2.00.
	 * A watcher that waited for the full budget would therefore NEVER deny on
	 * the exact backend that needs denial most. Every other test in this file
	 * drives 3 cores against a 2-core budget, a ratio of 1.5, which passes
	 * whether the threshold is 0.95, 0.5 or 1.0. This is the only test that
	 * pins where the line actually is, so it is the only one that fails if the
	 * comparison drifts to `>` or the ratio is retuned without thought.
	 */
	it("saturates at exactly 95% of the budget and not one microsecond below", async () => {
		const atRatio = 1_900_000; // 0.95 * 2 cores, in usec per second

		async function denialAt(perSecond: number): Promise<boolean> {
			const root = await makeCgroupRoot();
			const parent = await makeDelegatedParent(root);
			const host = makeFakeHost(root);
			const limiter = await makeLimiter(host, { cores: 2 });
			await limiter.ensureGroup();
			const dir = sessionCgroupDir(parent, "sess-test");
			await fs.writeFile(path.join(dir, "cpu.stat"), "usage_usec 0\nnr_throttled 0\n");
			host.clock.now += 1_000;
			await limiter.pollOnce();
			await driveWatcher(
				host,
				limiter,
				dir,
				[1, 2, 3].map(n => ({ usageUsec: perSecond * n, throttled: n })),
			);
			let denied = false;
			try {
				limiter.assertMaySpawn("a bash command");
			} catch {
				denied = true;
			}
			await limiter.dispose();
			return denied;
		}

		expect(await denialAt(atRatio)).toBe(true);
		expect(await denialAt(atRatio - 1)).toBe(false);
	});

	/**
	 * A non-throttling backend needs usage STRICTLY PAST the budget, because
	 * it has no throttled-period count to corroborate the reading.
	 *
	 * The two backends deliberately use different thresholds, and the reason is
	 * asymmetric risk. Where the kernel throttles, sitting at 95% with rising
	 * throttled periods is proof that demand exceeded the budget. Where nothing
	 * throttles, usage is unconstrained, so a group that wants exactly its
	 * budget will report exactly its budget forever; denying at 95% there would
	 * refuse every command of a session that is inside its limit. Collapsing
	 * the two branches onto one comparison is an easy tidy-up, and this is what
	 * catches it: exactly 2.00 of 2 cores must be allowed, 2.000001 must not.
	 */
	it("a backend with no kernel quota denies only past the budget, never at it", async () => {
		const root = await makeCgroupRoot();
		const host = makeFakeHost(root);
		const probe = await probeCpuLimitSupport({ ...host.env, platform: "darwin" });

		async function denialAt(perSecond: number): Promise<boolean> {
			const usage = { value: 0 };
			const limiter = new SessionCpuLimit({
				sessionId: "sess-mac",
				cores: 2,
				kill: false,
				probe,
				env: host.env,
				createGroup: () => ({
					throttles: false,
					adopt: () => {},
					usageUsec: () => usage.value,
					throttledPeriods: () => undefined,
					members: () => [4242],
					setCores: () => {},
					renice: () => {},
					dispose: () => {},
				}),
				windowSamples: 3,
				watchIntervalMs: 1_000,
			});
			await limiter.ensureGroup();
			await limiter.pollOnce();
			for (const n of [1, 2, 3]) {
				usage.value = perSecond * n;
				host.clock.now += 1_000;
				await limiter.pollOnce();
			}
			let denied = false;
			try {
				limiter.assertMaySpawn("a bash command");
			} catch {
				denied = true;
			}
			await limiter.dispose();
			return denied;
		}

		expect(await denialAt(2_000_000)).toBe(false);
		expect(await denialAt(2_000_001)).toBe(true);
	});

	/**
	 * Denial needs a SUSTAINED window: two saturated samples deny nothing, the
	 * third does.
	 *
	 * A single second at the wall is normal for any compile or test run, so a
	 * watcher that denied on one sample would make the feature unusable at any
	 * budget. The window is the whole difference between "this session is over
	 * its budget" and "this session started a build". Nothing else in this file
	 * distinguishes the third sample from the second, so an off-by-one in the
	 * window bookkeeping, or a window that never drains, is invisible without
	 * this.
	 */
	it("denies on the third consecutive saturated sample, not the second", async () => {
		const root = await makeCgroupRoot();
		const parent = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const limiter = await makeLimiter(host, { cores: 2 });

		await limiter.ensureGroup();
		const dir = sessionCgroupDir(parent, "sess-test");
		await fs.writeFile(path.join(dir, "cpu.stat"), "usage_usec 0\nnr_throttled 0\n");
		host.clock.now += 1_000;
		await limiter.pollOnce();

		await driveWatcher(host, limiter, dir, saturatedSteps.slice(0, 2));
		limiter.assertMaySpawn("a bash command");

		await driveWatcher(host, limiter, dir, saturatedSteps.slice(2));
		expect(() => limiter.assertMaySpawn("a bash command")).toThrow(CpuLimitDeniedError);
		await limiter.dispose();
	});

	it("renices instead of throttling where the backend has no kernel quota", async () => {
		const root = await makeCgroupRoot();
		const host = makeFakeHost(root);
		const renices: number[] = [];
		const probe = await probeCpuLimitSupport({ ...host.env, platform: "darwin" });
		const handle: CpuBudgetGroupHandle = {
			throttles: false,
			adopt: () => {},
			usageUsec: () => fakeUsage.value,
			throttledPeriods: () => undefined,
			members: () => [4242],
			setCores: () => {},
			renice: level => renices.push(level),
			dispose: () => {},
		};
		const fakeUsage = { value: 0 };
		const limiter = new SessionCpuLimit({
			sessionId: "sess-mac",
			cores: 2,
			kill: false,
			probe,
			env: host.env,
			createGroup: () => handle,
			windowSamples: 3,
			watchIntervalMs: 1_000,
		});

		await limiter.ensureGroup();
		await limiter.pollOnce();
		for (const usage of [3_000_000, 6_000_000, 9_000_000]) {
			fakeUsage.value = usage;
			host.clock.now += 1_000;
			await limiter.pollOnce();
		}
		expect(() => limiter.assertMaySpawn("a bash command")).toThrow(CpuLimitDeniedError);
		expect(renices).toEqual([CPU_LIMIT_SATURATION_NICE]);

		// Recovery restores the nice level.
		for (const usage of [9_100_000, 9_200_000, 9_300_000]) {
			fakeUsage.value = usage;
			host.clock.now += 1_000;
			await limiter.pollOnce();
		}
		limiter.assertMaySpawn("a bash command");
		expect(renices).toEqual([CPU_LIMIT_SATURATION_NICE, 0]);
		await limiter.dispose();
	});
});

describe("session registry", () => {
	it("warns at session start when a configured limit cannot be enforced", async () => {
		const root = await makeCgroupRoot();
		const host = makeFakeHost(root); // no delegated parent, no systemd
		const notices: string[] = [];
		const limiter = await initSessionCpuLimit({
			sessionId: "sess-unsupported",
			cores: 2,
			kill: false,
			onNotice: text => notices.push(text),
			env: host.env,
		});
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("session.cpuLimitCores is set to 2");
		expect(notices[0]).toContain("uncapped");
		expect(limiter.cores).toBe(2);
		await disposeOwnedResources("session", "sess-unsupported");
	});

	it("registers the limiter by session id and releases it with the session", async () => {
		const root = await makeCgroupRoot();
		const parent = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const limiter = await initSessionCpuLimit({
			sessionId: "sess-registered",
			cores: 1,
			kill: false,
			onNotice: () => {},
			env: host.env,
		});
		expect(sessionCpuLimit("sess-registered")).toBe(limiter);

		await limiter.ensureGroup();
		const dir = sessionCgroupDir(parent, "sess-registered");
		await disposeOwnedResources("session", "sess-registered");

		expect(sessionCpuLimit("sess-registered")).toBeUndefined();
		expect(await fs.stat(dir).catch(() => null)).toBeNull();
	});
});
