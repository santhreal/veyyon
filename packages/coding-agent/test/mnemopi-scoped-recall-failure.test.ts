import { describe, expect, it } from "bun:test";
import { MnemopiSessionState } from "@veyyon/coding-agent/mnemopi/state";

/**
 * Memory recall reads several banks and merges the results. A bank that threw
 * was caught, skipped, and reported with a `logger.debug` that was ITSELF gated
 * behind `config.debug`, so in a normal session an unreadable bank was reported
 * nowhere at all.
 *
 * Two things went wrong with that. A bank whose memories are missing from the
 * merge looks exactly like a bank with nothing relevant to say, so recall
 * silently got worse and stayed worse (Law 10). And when EVERY bank failed the
 * function returned `[]`, which the memory tools render as "No relevant memories
 * found" — telling the model a search ran cleanly when no search ran at all.
 * That is the H1-60 defect shape: a failure the caller reads as a success.
 *
 * Skipping a broken bank and continuing is still correct, because one unreadable
 * bank must not cost the user the others. These tests pin the two properties
 * that make it safe: partial loss is visible, and total loss is an error rather
 * than an empty result.
 */
describe("scoped memory recall when a bank cannot be read", () => {
	/**
	 * A recall target whose `recallEnhanced` either throws or returns one result
	 * tagged with its bank, which is what lets the assertions below tell which
	 * banks actually contributed.
	 */
	function target(bank: string, behavior: "ok" | "throw") {
		return {
			bank,
			memory: {
				recallEnhanced: async () => {
					if (behavior === "throw") throw new Error(`${bank} database is corrupt`);
					return [{ id: `${bank}-1`, content: `memory from ${bank}`, score: 1 }];
				},
			},
		};
	}

	function stateWith(...targets: ReturnType<typeof target>[]): MnemopiSessionState {
		const state = Object.create(MnemopiSessionState.prototype) as MnemopiSessionState;
		Object.assign(state, {
			config: { recallLimit: 10, debug: false, bank: "retain" },
			scoped: { recall: targets, retain: { bank: "retain" }, global: undefined },
		});
		return state;
	}

	it("still returns the healthy banks' memories when one bank fails", async () => {
		// The reason failures are swallowed at all. One broken bank must not take
		// the rest of memory down with it.
		const state = stateWith(target("project", "ok"), target("broken", "throw"), target("global", "ok"));

		const results = await state.collectScopedRecallResults("anything");

		expect(results.map(r => r.content).sort()).toEqual(["memory from global", "memory from project"]);
	});

	it("throws rather than returning an empty list when every bank fails", async () => {
		// REGRESSION, and the defect that reaches the model. `[]` renders as "No
		// relevant memories found", which says the search ran and found nothing.
		const state = stateWith(target("a", "throw"), target("b", "throw"));

		await expect(state.collectScopedRecallResults("anything")).rejects.toThrow(
			"none of the configured banks could be read",
		);
	});

	it("names every failed bank in the total-failure error", async () => {
		// An operator with several banks configured needs to know which ones are
		// broken; "recall failed" alone sends them looking through all of them.
		const state = stateWith(target("project", "throw"), target("global", "throw"));

		await expect(state.collectScopedRecallResults("q")).rejects.toThrow(/project, global/);
	});

	it("includes the underlying cause in the total-failure error", async () => {
		const state = stateWith(target("project", "throw"));

		await expect(state.collectScopedRecallResults("q")).rejects.toThrow(/database is corrupt/);
	});

	it("does not throw when at least one bank answered", async () => {
		// The negative twin of the above. A partial failure must stay a partial
		// result, not become a hard error that costs the user working memory.
		const state = stateWith(target("ok", "ok"), target("broken", "throw"));

		await expect(state.collectScopedRecallResults("q")).resolves.toHaveLength(1);
	});

	it("returns an empty list, without throwing, when the banks are healthy and simply have nothing", async () => {
		// The case the total-failure error must not swallow: a genuine empty result
		// is still a success, and the memory tools must keep reporting it as one.
		const empty = {
			bank: "project",
			memory: { recallEnhanced: async () => [] },
		} as unknown as ReturnType<typeof target>;
		const state = stateWith(empty);

		await expect(state.collectScopedRecallResults("q")).resolves.toEqual([]);
	});
});
