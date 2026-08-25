/**
 * Regression tests for the `SessionEntryIndex` branch cache.
 *
 * WHY: `getBranch()` is called 10+ times per turn (context breakdown,
 * compaction checks, todo sync, exit diagnostics). Each uncached
 * `pathTo` allocates a Set, walks the full branch via Map lookups,
 * and reverses — O(n) per call. The cache turns the second and later
 * calls into O(1) reference returns, and `insert` extends it in-place
 * on the common append path.
 *
 * This suite closes the class of bugs where the cache returns a stale
 * or incorrect branch after a structural mutation. It does NOT catch
 * a caller that mutates the returned array (none do today — all use
 * iteration, `.filter`, `.find`, `.some`, `.slice`, `.at`).
 */
import { describe, expect, it } from "bun:test";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";

describe("SessionManager branch cache", () => {
	it("returns the same array reference on repeated getBranch() calls", () => {
		const manager = SessionManager.inMemory();
		manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		manager.appendModelChange("anthropic/claude-sonnet-4-6", "slow");

		const first = manager.getBranch();
		const second = manager.getBranch();
		expect(second).toBe(first);
	});

	it("extends the cached branch in-place on the append path", () => {
		const manager = SessionManager.inMemory();
		manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		// Prime the cache.
		const cached = manager.getBranch();
		expect(cached.length).toBe(1);

		// Append a child of the current leaf — the cache should extend.
		manager.appendModelChange("anthropic/claude-sonnet-4-6", "slow");
		const extended = manager.getBranch();
		expect(extended).toBe(cached);
		expect(extended.length).toBe(2);
	});

	it("invalidates the cache on branch() (leaf switch)", () => {
		const manager = SessionManager.inMemory();
		const firstId = manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		manager.appendModelChange("anthropic/claude-sonnet-4-6", "slow");
		const beforeSwitch = manager.getBranch();
		expect(beforeSwitch.length).toBe(2);

		// Switch the leaf back to the first entry — a different branch.
		manager.branch(firstId);
		const afterSwitch = manager.getBranch();

		expect(afterSwitch).not.toBe(beforeSwitch);
		expect(afterSwitch.length).toBe(1);
		expect(afterSwitch[0].id).toBe(firstId);
	});

	it("invalidates the cache on resetLeaf()", () => {
		const manager = SessionManager.inMemory();
		manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		const before = manager.getBranch();
		expect(before.length).toBe(1);

		manager.resetLeaf();
		const after = manager.getBranch();
		expect(after).not.toBe(before);
		expect(after.length).toBe(0);
	});

	it("does not use the cache for getBranch(fromId) with a non-default id", () => {
		const manager = SessionManager.inMemory();
		const firstId = manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		manager.appendModelChange("anthropic/claude-sonnet-4-6", "slow");

		// Prime the cache for the default leaf.
		const fullBranch = manager.getBranch();
		expect(fullBranch.length).toBe(2);

		// getBranch(firstId) should return a different array (sub-branch),
		// not the cached full branch.
		const subBranch = manager.getBranch(firstId);
		expect(subBranch).not.toBe(fullBranch);
		expect(subBranch.length).toBe(1);
		expect(subBranch[0].id).toBe(firstId);

		// The cache for the default leaf should still be valid.
		const cached = manager.getBranch();
		expect(cached).toBe(fullBranch);
	});

	it("produces correct content after a sequence of appends", () => {
		const manager = SessionManager.inMemory();
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			ids.push(manager.appendModelChange(`model-${i}`, `role-${i}`));
		}

		const branch = manager.getBranch();
		expect(branch.map(e => e.id)).toEqual(ids);

		// Parent-chain invariant: root→leaf order.
		for (let i = 1; i < branch.length; i++) {
			expect(branch[i].parentId).toBe(branch[i - 1].id);
		}
	});

	it("handles append after a branch switch (cache rebuilt then extended)", () => {
		const manager = SessionManager.inMemory();
		const firstId = manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		manager.appendModelChange("anthropic/claude-sonnet-4-6", "slow");

		// Switch to the first entry, then append a child of it.
		manager.branch(firstId);
		const switchedBranch = manager.getBranch();
		expect(switchedBranch.length).toBe(1);

		// This append's parent is the current leaf (firstId), so the cache
		// should extend.
		const newId = manager.appendModelChange("openai/gpt-5", "fast");
		const extended = manager.getBranch();
		expect(extended).toBe(switchedBranch);
		expect(extended.length).toBe(2);
		expect(extended[1].id).toBe(newId);
	});

	it("cache survives multiple appends without corruption", () => {
		const manager = SessionManager.inMemory();
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) {
			ids.push(manager.appendModelChange(`model-${i}`, `role-${i}`));
		}

		// Prime cache, then append more.
		const cached = manager.getBranch();
		for (let i = 10; i < 15; i++) {
			ids.push(manager.appendModelChange(`model-${i}`, `role-${i}`));
		}

		const final = manager.getBranch();
		expect(final).toBe(cached);
		expect(final.length).toBe(15);
		expect(final.map(e => e.id)).toEqual(ids);
	});
});
