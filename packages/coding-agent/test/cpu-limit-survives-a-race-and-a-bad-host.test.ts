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
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CpuBudgetGroupHandle } from "../src/session/cpu-limit";
import { probeCpuLimitSupport, SessionCpuLimit, sessionCpuBudgetName } from "../src/session/cpu-limit";
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
