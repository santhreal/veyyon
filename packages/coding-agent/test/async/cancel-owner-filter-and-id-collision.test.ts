/**
 * Cancel is owner-scoped; job ids collide forward, never overwrite.
 *
 * async-job-manager.test.ts already pins unscoped cancel-by-id, cancelAll
 * with ownerId, dispose clearing jobs, and retention. Do not clone those.
 *
 * Cross-agent cancel of a *single* id must look like not-found (return
 * false) rather than aborting a sibling. Preferred ids that are already
 * live get `-2`, `-3` — never a silent reuse of the live key.
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

function hold(): { release: () => void; run: () => Promise<string> } {
	let release!: () => void;
	const gate = new Promise<void>(r => {
		release = r;
	});
	return {
		release,
		run: async () => {
			await gate;
			return "done";
		},
	};
}

describe("cancel is not a cross-agent primitive", () => {
	it("returns false when the owner filter does not match, and the job keeps running", async () => {
		mgr = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 10_000 });
		const held = hold();
		const id = mgr.register("bash", "theirs", held.run, { ownerId: "AuthLoader" });
		expect(mgr.cancel(id, { ownerId: "Main" })).toBe(false);
		expect(mgr.getJob(id)?.status).toBe("running");
		expect(mgr.cancel(id, { ownerId: "AuthLoader" })).toBe(true);
		expect(mgr.getJob(id)?.status).toBe("cancelled");
		held.release();
		await mgr.waitForAll();
	});

	it("returns false for a completed job instead of flipping it to cancelled", async () => {
		mgr = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 10_000 });
		const id = mgr.register("bash", "done", async () => "ok");
		await mgr.waitForAll();
		expect(mgr.getJob(id)?.status).toBe("completed");
		expect(mgr.cancel(id)).toBe(false);
		expect(mgr.getJob(id)?.status).toBe("completed");
	});
});

describe("job ids never overwrite a live entry", () => {
	it("suffixes a colliding preferred id starting at -2, not -1", () => {
		mgr = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 10_000, maxRunningJobs: 4 });
		expect(mgr.register("bash", "a", async () => "a", { id: "work" })).toBe("work");
		expect(mgr.register("bash", "b", async () => "b", { id: "work" })).toBe("work-2");
		expect(mgr.register("bash", "c", async () => "c", { id: "work" })).toBe("work-3");
	});

	it("treats a whitespace-only preferred id as missing rather than as a key", () => {
		mgr = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 10_000, maxRunningJobs: 4 });
		expect(mgr.register("bash", "a", async () => "a", { id: "   " })).toBe("bg_1");
	});

	it("trims a preferred id so ' work ' collides with 'work'", () => {
		mgr = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 10_000, maxRunningJobs: 4 });
		expect(mgr.register("bash", "a", async () => "a", { id: "work" })).toBe("work");
		expect(mgr.register("bash", "b", async () => "b", { id: " work " })).toBe("work-2");
	});

	it("refuses register after dispose and reports atCapacity", async () => {
		mgr = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 10_000 });
		await mgr.dispose({ timeoutMs: 50 });
		expect(mgr.atCapacity).toBe(true);
		expect(() => mgr!.register("bash", "late", async () => "no")).toThrow(/disposed/);
		mgr = undefined;
	});

	it("does not enqueue delivery when a cancelled job later resolves", async () => {
		const delivered: string[] = [];
		mgr = new AsyncJobManager({
			onJobComplete: async (_id, text) => {
				delivered.push(text);
			},
			retentionMs: 10_000,
		});
		const held = hold();
		const id = mgr.register("bash", "late", held.run);
		expect(mgr.cancel(id)).toBe(true);
		held.release();
		await mgr.waitForAll();
		await mgr.drainDeliveries({ timeoutMs: 200 });
		expect(delivered).toEqual([]);
		expect(mgr.getJob(id)?.resultText).toBe("done");
		expect(mgr.getJob(id)?.status).toBe("cancelled");
	});
});
