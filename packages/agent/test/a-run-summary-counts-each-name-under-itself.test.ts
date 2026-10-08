/**
 * A run summary keys its per-tool counters, stop reasons and error counts by strings the model and its tools choose:
 * a tool name, an error's `name`. Each must count under itself, including one that names an `Object.prototype`
 * member. A plain-object tally reads `constructor` or `toString` as the inherited function, so its count becomes NaN
 * or a string, and assigning `__proto__` replaces the tally's prototype, so that tool drops out of the summary.
 *
 * The names swept are every own property of `Object.prototype`, read at run time, beside one ordinary name. Both
 * producers are driven: the collector's snapshot of one run, and the aggregate of several summaries, including
 * summaries read back from JSON, which is how a persisted rollup arrives.
 *
 * Not caught: a provider reports stop reasons from a closed union, so a prototype-named stop reason reaches only the
 * aggregate, never the collector.
 */
import { describe, expect, it } from "bun:test";
import { trace } from "@opentelemetry/api";
import {
	AgentRunCollector,
	type AgentRunSummary,
	aggregateAgentRunSummaries,
	type ToolCounters,
} from "@veyyon/agent-core/run-collector";

const NAMES = ["read", ...Object.getOwnPropertyNames(Object.prototype)];
const SORTED_NAMES = [...NAMES].sort();

/** One `error` call and one `ok` call of every name, the error typed with that same name. */
function snapshotOfEveryName(): AgentRunSummary {
	const collector = new AgentRunCollector();
	const span = trace.getTracer("run-summary-names").startSpan("execute_tool");
	for (const [index, name] of NAMES.entries()) {
		collector.beginTool(span, { toolCallId: `call-${index}-a`, toolName: name });
		collector.endTool(span, { status: "error", errorType: name });
		collector.beginTool(span, { toolCallId: `call-${index}-b`, toolName: name });
		collector.endTool(span, { status: "ok", errorType: undefined });
	}
	span.end();
	return collector.snapshot({ stepCount: 1 }).summary;
}

/** `count` under every name, as an object each name is an own key of. */
function countedUnderEveryName<V>(count: V): Record<string, V> {
	return Object.fromEntries(NAMES.map(name => [name, count]));
}

function counters(total: number, ok: number, error: number, totalLatencyMs: number): ToolCounters {
	return { total, ok, error, skipped: 0, blocked: 0, timeout: 0, aborted: 0, totalLatencyMs };
}

function expectOwnSortedKeys(record: Readonly<Record<string, unknown>>): void {
	expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
	expect(Object.keys(record)).toEqual(SORTED_NAMES);
}

describe("a run summary counts each name under itself", () => {
	it("the collector's snapshot counts every tool name and error type, prototype member names included", () => {
		const summary = snapshotOfEveryName();

		expect(summary.tools).toMatchObject({ total: NAMES.length * 2, ok: NAMES.length, error: NAMES.length });
		expectOwnSortedKeys(summary.tools.byName);
		for (const name of NAMES) {
			const named = summary.tools.byName[name];
			expect({ name, ...named }).toEqual({ name, ...counters(2, 1, 1, named.totalLatencyMs) });
			expect(Number.isFinite(named.totalLatencyMs)).toBe(true);
		}

		expect(summary.errors.total).toBe(NAMES.length);
		expectOwnSortedKeys(summary.errors.byType);
		for (const name of NAMES) expect({ name, count: summary.errors.byType[name] }).toEqual({ name, count: 1 });
	});

	it("the aggregate sums every stop reason, tool name and error type, prototype member names included", () => {
		const one: AgentRunSummary = {
			chats: { total: NAMES.length, byStopReason: countedUnderEveryName(1), totalLatencyMs: 10 },
			tools: { ...counters(NAMES.length, NAMES.length, 0, 20), byName: countedUnderEveryName(counters(1, 1, 0, 2)) },
			usage: {
				inputTokens: 1,
				outputTokens: 1,
				cachedInputTokens: 0,
				cacheWriteTokens: 0,
				reasoningOutputTokens: 0,
				totalTokens: 2,
			},
			cost: { estimatedUsd: 0, unavailableReasons: [] },
			errors: { total: NAMES.length, byType: countedUnderEveryName(1) },
			stepCount: 1,
		};

		const summary = aggregateAgentRunSummaries([one, one, one]);

		expect(summary.chats.total).toBe(NAMES.length * 3);
		expect(summary.tools.total).toBe(NAMES.length * 3);
		expect(summary.errors.total).toBe(NAMES.length * 3);
		for (const tally of [summary.chats.byStopReason, summary.tools.byName, summary.errors.byType]) {
			expectOwnSortedKeys(tally);
		}
		for (const name of NAMES) {
			expect({ name, count: summary.chats.byStopReason[name] }).toEqual({ name, count: 3 });
			expect({ name, ...summary.tools.byName[name] }).toEqual({ name, ...counters(3, 3, 0, 6) });
			expect({ name, count: summary.errors.byType[name] }).toEqual({ name, count: 3 });
		}
	});

	it("summaries read back from JSON aggregate to the sum of what was written", () => {
		const written = snapshotOfEveryName();
		const readBack: AgentRunSummary = JSON.parse(JSON.stringify(written));

		const summary = aggregateAgentRunSummaries([readBack, readBack]);

		expectOwnSortedKeys(summary.tools.byName);
		expectOwnSortedKeys(summary.errors.byType);
		for (const name of NAMES) {
			const named = written.tools.byName[name];
			expect({ name, ...summary.tools.byName[name] }).toEqual({
				name,
				...counters(4, 2, 2, named.totalLatencyMs * 2),
			});
			expect({ name, count: summary.errors.byType[name] }).toEqual({ name, count: 2 });
		}
		expect(summary.errors.total).toBe(NAMES.length * 2);
	});
});
