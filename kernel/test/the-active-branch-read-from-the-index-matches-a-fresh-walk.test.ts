/**
 * WHY THIS SUITE EXISTS:
 * The session index keeps the root→leaf path of the active leaf instead of re-walking the parent
 * chain on every read, because on a session of hundreds of thousands of entries each walk costs tens
 * of milliseconds and resume walked the branch more than a dozen times. A cached path is a second
 * copy of the tree, and the defect it invites is a copy that goes stale: a mutation moves the leaf or
 * adds an entry, the cache is neither extended nor dropped, and `getBranch()` and
 * `buildSessionContext()` answer for a branch the session is no longer on.
 *
 * The class this closes is "a SessionManager mutation left the cached branch stale". Every mutator on
 * the prototype is driven through a seeded random sequence, and after each step both reads are
 * compared against the free functions run over `getEntries()` from scratch. The mutator set is read
 * from the prototype at run time, so a new `append*`, `branch*`, `reset*`, `create*`, `new*` or
 * `fork*` method turns this suite red until it is given an operation here.
 *
 * It also pins the copy contract: `getBranch()` hands out an array the caller may edit, and an edit
 * must not reach the cache.
 *
 * WHAT IT DOES NOT CATCH: an insert that does not hang off the leaf, or whose id shadows an entry
 * already in the index. Every public append parents the new entry on the current leaf and
 * `generateId` never mints a duplicate; the only off-leaf inserts happen inside a rebuild, which
 * starts from a dropped path. Those guards in `insert` are unreachable from here. Nor does it cover
 * entries edited in place after load (`rewriteEntries` callers), which change content but never ids
 * or parent links, or `setSessionFile`, which needs a file on disk and rebuilds the index from it.
 */

import { describe, expect, test } from "bun:test";
import type { AssistantMessage, UserMessage } from "@veyyon/ai";
import { buildSessionContext, walkBranchPath } from "@veyyon/kernel/session/session-context";
import { SessionManager } from "@veyyon/kernel/session/session-manager";

type Rng = () => number;

function seeded(seed: number): Rng {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function pick<T>(rng: Rng, items: readonly T[]): T {
	return items[Math.floor(rng() * items.length)];
}

function userMessage(step: number): UserMessage {
	return { role: "user", content: `step ${step}`, timestamp: step };
}

function assistantMessage(step: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `reply ${step}` }],
		api: "openai-completions",
		provider: "openai",
		model: step % 2 === 0 ? "model-even" : "model-odd",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: step,
	};
}

function anyEntryId(manager: SessionManager, rng: Rng): string | undefined {
	const entries = manager.getEntries();
	return entries.length === 0 ? undefined : pick(rng, entries).id;
}

/** One way to drive each mutator. A mutator missing from this table fails the enumeration test. */
const OPERATIONS: Record<string, (manager: SessionManager, rng: Rng, step: number) => unknown> = {
	appendMessage: (manager, _rng, step) =>
		manager.appendMessage(step % 2 === 0 ? userMessage(step) : assistantMessage(step)),
	appendThinkingLevelChange: (manager, rng) => manager.appendThinkingLevelChange(pick(rng, ["off", "high"])),
	appendServiceTierChange: manager => manager.appendServiceTierChange(null),
	appendModeChange: (manager, rng) => manager.appendModeChange(pick(rng, ["none", "plan"])),
	appendModelChange: (manager, rng) => manager.appendModelChange(pick(rng, ["openai/a", "openai/b"])),
	appendSessionInit: manager => manager.appendSessionInit({ systemPrompt: "system", task: "task", tools: [] }),
	appendAgentSpawn: (manager, _rng, step) =>
		manager.appendAgentSpawn({
			agentId: `agent-${step}`,
			agentName: "task",
			task: "task",
			sessionFile: `agents/agent-${step}.jsonl`,
			isolation: "none",
			status: "completed",
			exitCode: 0,
			durationMs: 1,
		}),
	appendSettingsSnapshot: manager => manager.appendSettingsSnapshot({ "display.collapseCompacted": true }),
	appendCompaction: (manager, rng) => {
		const kept = anyEntryId(manager, rng);
		if (kept) manager.appendCompaction("summary", undefined, kept, 1000);
	},
	appendCustomEntry: manager => manager.appendCustomEntry("probe", { value: 1 }),
	appendCustomMessageEntry: manager => manager.appendCustomMessageEntry("probe", "note", true),
	appendMCPToolSelection: manager => manager.appendMCPToolSelection(["tool_a"]),
	appendTtsrInjection: manager => manager.appendTtsrInjection(["rule_a"]),
	appendLabelChange: (manager, rng) => {
		const target = anyEntryId(manager, rng);
		if (target) manager.appendLabelChange(target, pick(rng, ["mark", undefined]));
	},
	createCheckpoint: manager => {
		manager.createCheckpoint();
	},
	branch: (manager, rng) => {
		const target = anyEntryId(manager, rng);
		if (target) manager.branch(target);
	},
	resetLeaf: manager => manager.resetLeaf(),
	branchWithSummary: (manager, rng) => {
		manager.branchWithSummary(rng() < 0.2 ? null : (anyEntryId(manager, rng) ?? null), "abandoned");
	},
	createBranchedSession: (manager, rng) => {
		const target = anyEntryId(manager, rng);
		if (target) manager.createBranchedSession(target);
	},
	// Rare, so the branch between two resets grows long enough to hold a stale path.
	newSession: (manager, rng) => (rng() < 0.2 ? manager.newSession() : undefined),
	fork: manager => manager.fork(),
};

function mutatorNames(): string[] {
	return Object.getOwnPropertyNames(SessionManager.prototype)
		.filter(name => /^(append|branch|reset|create|new|fork)/.test(name))
		.sort();
}

function expectReadsMatchFreshWalk(manager: SessionManager, context: string): void {
	const entries = manager.getEntries();
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const leafId = manager.getLeafId();
	const expectedPath = walkBranchPath(byId, leafId ? byId.get(leafId) : undefined).map(entry => entry.id);

	expect({ context, path: manager.getBranch().map(entry => entry.id) }).toEqual({ context, path: expectedPath });
	expect(manager.buildSessionContext()).toEqual(buildSessionContext(entries, leafId));
	expect(manager.buildSessionContext({ transcript: true })).toEqual(
		buildSessionContext(entries, leafId, undefined, { transcript: true }),
	);
}

describe("the active branch read from the index matches a fresh walk", () => {
	test("every entry-mutating SessionManager method has an operation in this suite", () => {
		expect(mutatorNames()).toEqual(Object.keys(OPERATIONS).sort());
	});

	for (const seed of [1, 7, 42, 1337]) {
		test(`a seeded run of every mutator never leaves getBranch or buildSessionContext stale (seed ${seed})`, async () => {
			const rng = seeded(seed);
			const manager = SessionManager.inMemory("/repo");
			const names = Object.keys(OPERATIONS);
			const steps = 300;
			for (let step = 0; step < steps; step++) {
				// Appends dominate, so the branch grows long enough for a stale prefix to show.
				const name = rng() < 0.5 ? "appendMessage" : pick(rng, names);
				await OPERATIONS[name](manager, rng, step);
				expectReadsMatchFreshWalk(manager, `seed ${seed} step ${step} after ${name}`);
			}
		});
	}

	test("editing the array getBranch returns does not change the next read", () => {
		const manager = SessionManager.inMemory("/repo");
		for (let step = 0; step < 6; step++) manager.appendMessage(userMessage(step));
		const before = manager.getBranch().map(entry => entry.id);

		const handedOut = manager.getBranch();
		handedOut.reverse();
		handedOut.pop();

		expect(manager.getBranch().map(entry => entry.id)).toEqual(before);
		const appended = manager.appendMessage(userMessage(6));
		expect(manager.getBranch().map(entry => entry.id)).toEqual([...before, appended]);
	});
});
