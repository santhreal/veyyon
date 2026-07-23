/**
 * empty aggregates and single-element identity for aggregateAgentRunSummaries /
 * Coverage. Empty input returns frozen empty constants by reference.
 */
import { describe, expect, it } from "bun:test";
import {
	type AgentRunCoverage,
	type AgentRunSummary,
	aggregateAgentRunCoverage,
	aggregateAgentRunSummaries,
	emptyAgentRunCoverage,
	emptyAgentRunSummary,
} from "@veyyon/agent-core/run-collector";

function miniSummary(partial: {
	chatTotal?: number;
	toolOk?: number;
	steps?: number;
	input?: number;
}): AgentRunSummary {
	const base = emptyAgentRunSummary();
	return {
		...base,
		chats: {
			total: partial.chatTotal ?? 0,
			byStopReason: partial.chatTotal ? { stop: partial.chatTotal } : {},
			totalLatencyMs: (partial.chatTotal ?? 0) * 10,
		},
		tools: {
			...base.tools,
			total: partial.toolOk ?? 0,
			ok: partial.toolOk ?? 0,
			byName:
				partial.toolOk !== undefined
					? {
							bash: {
								total: partial.toolOk,
								ok: partial.toolOk,
								error: 0,
								skipped: 0,
								blocked: 0,
								timeout: 0,
								aborted: 0,
								totalLatencyMs: 1,
							},
						}
					: {},
		},
		usage: {
			...base.usage,
			inputTokens: partial.input ?? 0,
			totalTokens: partial.input ?? 0,
		},
		stepCount: partial.steps ?? 0,
	};
}

describe("empty + aggregate identity", () => {
	it("empty arrays return frozen empties by reference", () => {
		expect(aggregateAgentRunSummaries([])).toBe(emptyAgentRunSummary());
		expect(aggregateAgentRunCoverage([])).toBe(emptyAgentRunCoverage());
	});

	it("single summary returns same reference", () => {
		const s = miniSummary({ chatTotal: 2, toolOk: 1, steps: 3, input: 100 });
		expect(aggregateAgentRunSummaries([s])).toBe(s);
	});

	it("single coverage returns same reference", () => {
		const c: AgentRunCoverage = {
			toolsAvailable: ["a"],
			toolsInvoked: ["a"],
			toolsUnused: [],
			modelsUsed: ["m"],
			providersUsed: ["p"],
		};
		expect(aggregateAgentRunCoverage([c])).toBe(c);
	});

	it("two summaries sum counters and merge byName", () => {
		const a = miniSummary({ chatTotal: 1, toolOk: 2, steps: 1, input: 10 });
		const b = miniSummary({ chatTotal: 3, toolOk: 1, steps: 4, input: 5 });
		const m = aggregateAgentRunSummaries([a, b]);
		expect(m.chats.total).toBe(4);
		expect(m.chats.byStopReason.stop).toBe(4);
		expect(m.tools.ok).toBe(3);
		expect(m.tools.byName.bash.ok).toBe(3);
		expect(m.usage.inputTokens).toBe(15);
		expect(m.stepCount).toBe(5);
	});

	it("coverage union sorts and computes unused", () => {
		const c1: AgentRunCoverage = {
			toolsAvailable: ["z", "a"],
			toolsInvoked: ["z"],
			toolsUnused: ["a"],
			modelsUsed: ["m2"],
			providersUsed: ["p1"],
		};
		const c2: AgentRunCoverage = {
			toolsAvailable: ["a", "b"],
			toolsInvoked: ["a", "b"],
			toolsUnused: [],
			modelsUsed: ["m1"],
			providersUsed: ["p2"],
		};
		const m = aggregateAgentRunCoverage([c1, c2]);
		expect(m.toolsAvailable).toEqual(["a", "b", "z"]);
		expect(m.toolsInvoked).toEqual(["a", "b", "z"]);
		expect(m.toolsUnused).toEqual([]);
		expect(m.modelsUsed).toEqual(["m1", "m2"]);
		expect(m.providersUsed).toEqual(["p1", "p2"]);
	});

	it("unused tools after partial invoke", () => {
		const m = aggregateAgentRunCoverage([
			{
				toolsAvailable: ["read", "write", "bash"],
				toolsInvoked: ["read"],
				toolsUnused: ["write", "bash"],
				modelsUsed: [],
				providersUsed: [],
			},
		]);
		// single element identity — already covered; exercise unused filter via two:
		const m2 = aggregateAgentRunCoverage([
			{
				toolsAvailable: ["read", "write"],
				toolsInvoked: [],
				toolsUnused: ["read", "write"],
				modelsUsed: [],
				providersUsed: [],
			},
			{
				toolsAvailable: ["bash"],
				toolsInvoked: ["bash"],
				toolsUnused: [],
				modelsUsed: [],
				providersUsed: [],
			},
		]);
		expect(m2.toolsAvailable).toEqual(["bash", "read", "write"]);
		expect(m2.toolsInvoked).toEqual(["bash"]);
		expect(m2.toolsUnused).toEqual(["read", "write"]);
		expect(m.toolsUnused).toEqual(["write", "bash"]);
	});
});
