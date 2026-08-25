/**
 * Cancel is owner-scoped; job ids collide forward, never overwrite.
 *
 * WHY THIS SUITE EXISTS. Cross-agent cancel must look like not-found
 * (return false) rather than aborting a sibling's bash. Preferred ids
 * that are already live get `-2`, `-3` — never a silent reuse of
 * `bg_1`. Dispose makes the manager refuse new work and report at
 * capacity so a torn-down session cannot keep spawning.
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

	it("returns false for an unknown id rather than throwing", () => {
		mgr = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 10_000 });
		expect(mgr.cancel("bg_999")).toBe(false);
	});

	it("cancelAll with an owner leaves the other agent's running jobs alone", async () => {
		mgr = new AsyncJobManager({
			onJobComplete: async () => {},
			retentionMs: 10_000,
			maxRunningJobs: 4,
		});
		const a = hold();
		const b = hold();
		const idA = mgr.register("bash", "A", a.run, { ownerId: "Main" });
		const idB = mgr.register("task", "B", b.run, { ownerId: "AuthLoader" });
		mgr.cancelAll({ ownerId: "Main" });
		expect(mgr.getJob(idA)?.status).toBe("cancelled");
		expect(mgr.getJob(idB)?.status).toBe("running");
		a.release();
		b.release();
		await mgr.waitForAll();
	});

	it("getRunningJobs/getRecentJobs honor ownerId and exclude the other status", async () => {
		mgr = new AsyncJobManager({
			onJobComplete: async () => {},
			retentionMs: 10_000,
			maxRunningJobs: 4,
		});
		const held = hold();
		mgr.register("bash", "live", held.run, { ownerId: "Main" });
		const done = mgr.register("bash", "old", async () => "old", { ownerId: "Main" });
		mgr.register("task", "other", async () => "x", { ownerId: "AuthLoader" });
		await mgr.getJob(done)!.promise;
		expect(mgr.getRunningJobs({ ownerId: "Main" }).map(j => j.label)).toEqual(["live"]);
		expect(mgr.getRecentJobs(10, { ownerId: "Main" }).map(j => j.label)).toEqual(["old"]);
		expect(mgr.getRecentJobs(0, { ownerId: "Main" })).toEqual([]);
		held.release();
		await mgr.waitForAll();
	});
});

describe("job ids never overwrite a live entry", () => {
	it("allocates bg_1, bg_2 when no preferred id is given", () => {
		mgr = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 10_000, maxRunningJobs: 4 });
		const a = mgr.register("bash", "a", async () => "a");
		const b = mgr.register("bash", "b", async () => "b");
		expect(a).toBe("bg_1");
		expect(b).toBe("bg_2");
	});

	it("suffixes a colliding preferred id starting at -2, not -1", () => {
		mgr = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 10_000, maxRunningJobs: 4 });
		expect(mgr.register("bash", "a", async () => "a", { id: "work" })).toBe("work");
		expect(mgr.register("bash", "b", async () => "b", { id: "work" })).toBe("work-2");
		expect(mgr.register("bash", "c", async () => "c", { id: "work" })).toBe("work-3");
	});

	it("treats a whitespace-only preferred id as missing rather than as a key", () => {
		mgr = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 10_000, maxRunningJobs: 4 });
		expect(mgr.register("bash", "a", async () => "a", { id: "   " })).toBe("bg_1");
		expect(mgr.register("bash", "b", async () => "b", { id: "\t\n" })).toBe("bg_2");
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
