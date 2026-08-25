/**
 * AsyncJobManager capacity and watch/unwatch delivery.
 *
 * WHY THIS SUITE EXISTS. The manager is the operator's background-job
 * ledger: bash, task, and launch all land here. There was no test file.
 * Queued jobs must not consume a running slot — a parked batch would
 * otherwise starve registration. A watch suppresses delivery; lifting it
 * must re-arm a completion that finished in the window, but only if the
 * caller did not already acknowledge (exactly-once). Get the order
 * backwards and the operator sees the child's report twice, or never.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";

let mgr: AsyncJobManager | undefined;

afterEach(async () => {
	if (mgr) {
		await mgr.dispose({ timeoutMs: 200 });
		mgr = undefined;
	}
	AsyncJobManager.resetForTests();
});

function manager(opts?: {
	maxRunningJobs?: number;
	retentionMs?: number;
	onComplete?: (id: string, text: string) => Promise<void> | void;
}): { mgr: AsyncJobManager; delivered: Array<{ id: string; text: string }> } {
	const delivered: Array<{ id: string; text: string }> = [];
	mgr = new AsyncJobManager({
		maxRunningJobs: opts?.maxRunningJobs ?? 2,
		retentionMs: opts?.retentionMs ?? 60_000,
		onJobComplete: async (id, text) => {
			delivered.push({ id, text });
			await opts?.onComplete?.(id, text);
		},
	});
	return { mgr, delivered };
}

describe("queued jobs hold no execution slot", () => {
	it("floors maxRunningJobs of 0 to 1 rather than opening an unbounded pool", () => {
		const { mgr: m } = manager({ maxRunningJobs: 0 });
		const id = m.register("bash", "only", async () => "ok", { queued: false });
		expect(id).toBe("bg_1");
		expect(m.atCapacity).toBe(true);
	});

	it("floors a fractional maxRunningJobs via Math.floor, not round", () => {
		const { mgr: m } = manager({ maxRunningJobs: 1.9 });
		m.register("bash", "a", async () => {
			await Bun.sleep(50);
			return "a";
		});
		expect(m.atCapacity).toBe(true);
		expect(() => m.register("bash", "b", async () => "b")).toThrow(/Background job limit reached \(1\)/);
	});

	it("lets a second job register while the first is still queued", async () => {
		const { mgr: m } = manager({ maxRunningJobs: 1 });
		let markQueued: (() => void) | undefined;
		let release!: () => void;
		const gate = new Promise<void>(r => {
			release = r;
		});
		m.register(
			"task",
			"parked",
			async ({ markRunning }) => {
				markQueued = markRunning;
				await gate;
				return "parked-done";
			},
			{ queued: true },
		);
		expect(m.atCapacity).toBe(false);
		const second = m.register("bash", "live", async () => "live-done");
		expect(second).toBe("bg_2");
		expect(m.getRunningJobs().map(j => j.label).sort()).toEqual(["live", "parked"]);
		expect(() => m.register("bash", "third", async () => "no")).toThrow(/limit reached \(1\)/);
		markQueued!();
		expect(m.atCapacity).toBe(true);
		release();
		await m.waitForAll();
	});

	it("does not count a cancelled-but-still-running-promise job toward capacity", async () => {
		const { mgr: m } = manager({ maxRunningJobs: 1 });
		let release!: () => void;
		const gate = new Promise<void>(r => {
			release = r;
		});
		const id = m.register("bash", "stuck", async ({ signal }) => {
			await gate;
			if (signal.aborted) throw new Error("aborted");
			return "late";
		});
		expect(m.cancel(id)).toBe(true);
		expect(m.atCapacity).toBe(false);
		const next = m.register("bash", "after-cancel", async () => "ok");
		expect(next).toBe("bg_2");
		release();
		await m.waitForAll();
	});
});

describe("watch suppresses delivery; unwatch re-arms unless acknowledged", () => {
	it("does not deliver a job that finished while watched", async () => {
		const { mgr: m, delivered } = manager();
		let release!: () => void;
		const gate = new Promise<void>(r => {
			release = r;
		});
		const id = m.register("task", "child", async () => {
			await gate;
			return "child-report";
		});
		expect(m.watchJobs([id])).toBe(1);
		release();
		await m.waitForAll();
		expect(delivered).toEqual([]);
		expect(m.isDeliverySuppressed(id)).toBe(true);
	});

	it("re-arms a watched completion when the watch is lifted without an ack", async () => {
		const { mgr: m, delivered } = manager();
		let release!: () => void;
		const gate = new Promise<void>(r => {
			release = r;
		});
		const id = m.register("task", "child", async () => {
			await gate;
			return "child-report";
		});
		m.watchJobs([` ${id} `, id, ""]);
		release();
		await m.waitForAll();
		expect(m.unwatchJobs([id])).toBe(1);
		expect(await m.drainDeliveries({ timeoutMs: 1000 })).toBe(true);
		expect(delivered).toEqual([{ id, text: "child-report" }]);
	});

	it("stays quiet when the caller acknowledges before unwatching", async () => {
		const { mgr: m, delivered } = manager();
		let release!: () => void;
		const gate = new Promise<void>(r => {
			release = r;
		});
		const id = m.register("task", "child", async () => {
			await gate;
			return "child-report";
		});
		m.watchJobs([id]);
		release();
		await m.waitForAll();
		expect(m.acknowledgeDeliveries([id])).toBe(0);
		expect(m.unwatchJobs([id])).toBe(1);
		expect(await m.drainDeliveries({ timeoutMs: 400 })).toBe(true);
		expect(delivered).toEqual([]);
	});

	it("trims, dedupes, and ignores empty watch ids so a blank argv does not watch everything", () => {
		const { mgr: m } = manager();
		expect(m.watchJobs(["", "  ", "\t", "a", "a", " a "])).toBe(1);
		expect(m.unwatchJobs(["a", "a", ""])).toBe(1);
		expect(m.unwatchJobs(["a"])).toBe(0);
	});

	it("resumeDeliveries re-enqueues a job that finished while acknowledge-suppressed", async () => {
		const { mgr: m, delivered } = manager();
		const id = m.register("bash", "fg", async () => "fg-out");
		m.acknowledgeDeliveries([id]);
		await m.waitForAll();
		expect(delivered).toEqual([]);
		m.resumeDeliveries([` ${id} `, ""]);
		expect(await m.drainDeliveries({ timeoutMs: 1000 })).toBe(true);
		expect(delivered).toEqual([{ id, text: "fg-out" }]);
	});
});
