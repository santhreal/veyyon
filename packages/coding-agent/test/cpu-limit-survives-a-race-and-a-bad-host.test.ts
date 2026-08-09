/**
 * Two ways the session CPU budget used to leak or stay dead, both invisible.
 *
 * DISPOSED MID-CREATION. `ensureGroup()` memoises `#createGroup()`, which awaits
 * the probe and, on the systemd backend, two `systemd-run` / `systemctl` round
 * trips before it assigns the group. `dispose()` sets a flag, clears the timer
 * and releases `#group`, which is still `undefined` at that point, so it has
 * nothing to release. The group is then created after the session is gone, with
 * a `setInterval` polling it for the life of the process and no reparent or
 * teardown. `/exit` or `/new` during the first capped command is precisely that
 * window: one microtask on the direct backend, up to the full command timeout on
 * the systemd one.
 *
 * A PERMANENTLY DEAD BUDGET. `#createGroup`'s catch sets `#setupFailed`, and
 * `ensureGroup` then returns `undefined` for the rest of the session. Nothing
 * cleared it: an operator who saw the warning, fixed the host and re-set
 * `session.cpuLimitCores` got no budget and no second warning, and the only
 * recovery was restarting veyyon.
 *
 * Both are asserted through the real `SessionCpuLimit` against a fake cgroup
 * tree, with `createGroup` injected only so the handle can report whether it was
 * disposed. Neither needs a real cgroup controller.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CpuBudgetGroupHandle, CpuLimitEnvironment } from "../src/session/cpu-limit";
import {
	defaultCpuLimitEnvironment,
	probeCpuLimitSupport,
	SessionCpuLimit,
	sessionCpuBudgetName,
} from "../src/session/cpu-limit";
import type { FakeHost } from "./helpers/fake-cgroup";
import { makeCgroupRoot, makeDelegatedParent, makeFakeHost, removeCgroupRoots } from "./helpers/fake-cgroup";

afterEach(removeCgroupRoots);

/** A handle that records the calls the lifecycle is asserted on. */
function recordingHandle(): { handle: CpuBudgetGroupHandle; disposed: () => number } {
	let disposeCount = 0;
	return {
		disposed: () => disposeCount,
		handle: {
			throttles: true,
			adopt: () => {},
			usageUsec: () => 0,
			throttledPeriods: () => 0,
			members: () => [],
			setCores: () => {},
			renice: () => {},
			dispose: () => {
				disposeCount += 1;
			},
		},
	};
}

async function limiterOn(
	host: FakeHost,
	options: { cores: number; createGroup?: () => CpuBudgetGroupHandle; onNotice?: (text: string) => void },
): Promise<SessionCpuLimit> {
	const probe = await probeCpuLimitSupport(host.env);
	return new SessionCpuLimit({
		sessionId: "sess-race",
		cores: options.cores,
		kill: false,
		probe,
		env: host.env,
		onNotice: options.onNotice,
		createGroup: options.createGroup,
		windowSamples: 3,
		watchIntervalMs: 1_000,
	});
}

describe("a session disposed while its group is still being created", () => {
	it("releases the group instead of leaving it behind with a live watcher", async () => {
		const root = await makeCgroupRoot();
		await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const recorder = recordingHandle();
		const limiter = await limiterOn(host, { cores: 2, createGroup: () => recorder.handle });

		// Start creation and dispose before it resolves. Awaiting them together is
		// the race: dispose runs while #createGroup is still inside its awaits.
		const creating = limiter.ensureGroup();
		await limiter.dispose();
		const group = await creating;

		// Nothing is handed to a caller that would adopt into a dead session...
		expect(group).toBeUndefined();
		// ...and the group that WAS created is torn down rather than orphaned.
		expect(recorder.disposed()).toBe(1);
	});

	it("adopts nothing once disposed, so a late spawn cannot resurrect the group", async () => {
		const root = await makeCgroupRoot();
		const parent = await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const limiter = await limiterOn(host, { cores: 2 });

		await limiter.dispose();
		await limiter.adoptPid(4242);

		const dir = path.join(parent, sessionCpuBudgetName("sess-race"));
		await expect(fs.stat(dir)).rejects.toThrow();
	});
});

describe("a budget whose first setup failed", () => {
	it("re-arms when the operator changes the setting, instead of staying dead for the session", async () => {
		const root = await makeCgroupRoot();
		await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const notices: string[] = [];
		let attempts = 0;
		const recorder = recordingHandle();
		const limiter = await limiterOn(host, {
			cores: 2,
			onNotice: text => notices.push(text),
			createGroup: () => {
				attempts += 1;
				if (attempts === 1) throw new Error("cgroup parent is momentarily unwritable");
				return recorder.handle;
			},
		});

		expect(await limiter.ensureGroup()).toBeUndefined();
		expect(notices.some(text => text.includes("could not be created"))).toBe(true);
		// The failure is sticky WITHIN one setting: a retry on every spawn would
		// pay the full setup cost again on each command.
		expect(await limiter.ensureGroup()).toBeUndefined();
		expect(attempts).toBe(1);

		await limiter.update(3, false);

		expect(await limiter.ensureGroup()).toBe(recorder.handle);
		expect(attempts).toBe(2);
		await limiter.dispose();
	});

	it("reports the failure in its status line while it is failed", async () => {
		const root = await makeCgroupRoot();
		await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const limiter = await limiterOn(host, {
			cores: 2,
			createGroup: () => {
				throw new Error("nope");
			},
		});

		await limiter.ensureGroup();

		expect(await limiter.statusLine()).toBe("configured for 2 core(s) but group setup failed");
	});
});

/**
 * A HOST WHOSE SPAWN FAULTS BEFORE THE COMMAND EVEN STARTS.
 *
 * `probeCpuLimitSupport` asks the host one question through `env.run` and guards the answer with
 * `.catch(...)`, which only covers a REJECTED promise. The production `env.run` reaches
 * `child_process.execFile`, and that can fault SYNCHRONOUSLY: an argument shape the spawn
 * implementation refuses, EMFILE, a bad executable path. A synchronous throw walks straight past
 * `.catch(...)` and out of the probe, which is an optional capability check, into whatever was
 * driving. Observed: a TUI test stubbed `Bun.spawn`, the stub rejected `execFile`'s argument
 * shape, and the throw surfaced as `# Unhandled error between tests` plus three phantom terminal
 * writes and a hook timeout in a suite that has nothing to do with CPU limits.
 *
 * The class this closes: NO host command the CPU limiter runs may fault synchronously, for any
 * argv and any reason. So the assertions go at the one owner every command passes through
 * (`defaultCpuLimitEnvironment().run`), not at the probe's single call site, and they cover both
 * a faulting spawn implementation and a real nonexistent executable.
 *
 * What it does NOT catch: a spawn that hangs forever without faulting. That is the `execFile`
 * timeout's job, and asserting a 10 second timeout would cost 10 seconds.
 */
describe("a host whose spawn faults synchronously", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("answers with a failed command instead of throwing out of the caller", async () => {
		const env = defaultCpuLimitEnvironment();
		vi.spyOn(Bun, "spawn").mockImplementation((() => {
			throw new TypeError("Spread syntax requires ...iterable[Symbol.iterator] to be a function");
		}) as unknown as typeof Bun.spawn);

		// Synchronous by construction: a throwing `run` would escape here, before any await.
		const result = env.run(["systemctl", "--user", "show-environment"]);
		await expect(result).resolves.toMatchObject({ code: 1, stdout: "" });
		expect((await result).stderr).toContain("Symbol.iterator");
	});

	it("carries the fault into the probe as an unsupported verdict that names the reason", async () => {
		// A cgroup v2 root with no writable delegated parent for this uid, so the probe exhausts
		// its direct candidates and asks systemctl, which is the call that used to throw.
		const root = await makeCgroupRoot();
		const env: CpuLimitEnvironment = {
			...defaultCpuLimitEnvironment(),
			platform: "linux",
			uid: 999_999,
			cgroupRoot: root,
			ownCgroupPath: "",
		};
		vi.spyOn(Bun, "spawn").mockImplementation((() => {
			throw new Error("EMFILE: too many open files");
		}) as unknown as typeof Bun.spawn);

		const probe = await probeCpuLimitSupport(env);

		expect(probe.supported).toBe(false);
		expect(probe.detail).toContain("EMFILE");
	});

	it("answers with a failed command for an executable the host does not have", async () => {
		const env = defaultCpuLimitEnvironment();

		// No mock: a real spawn of a real absent binary. Whether the runtime reports that
		// synchronously or through the callback is its business; the contract is the same result
		// shape either way.
		const result = await env.run(["veyyon-no-such-binary-9f2c", "--version"]);

		expect(result.code).not.toBe(0);
		expect(result.stderr.length).toBeGreaterThan(0);
	});
});
