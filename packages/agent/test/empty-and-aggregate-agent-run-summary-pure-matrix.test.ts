/**
 * emptyAgentRunSummary / aggregateAgentRunSummaries identity and monoid properties.
 * Why: multi-run rollups must not invent counts or drop coverage.
 */
import { describe, expect, it } from "bun:test";
import { aggregateAgentRunSummaries, emptyAgentRunSummary } from "@veyyon/agent-core/run-collector";

describe("empty and aggregate agent run summary pure matrix", () => {
	it("empty is stable identity", () => {
		const a = emptyAgentRunSummary();
		const b = emptyAgentRunSummary();
		expect(a).toEqual(b);
	});

	it("aggregate empty list equals empty", () => {
		expect(aggregateAgentRunSummaries([])).toEqual(emptyAgentRunSummary());
	});

	it("aggregate single empty is empty", () => {
		expect(aggregateAgentRunSummaries([emptyAgentRunSummary()])).toEqual(emptyAgentRunSummary());
	});

	it("aggregate many empties stays empty", () => {
		const many = Array.from({ length: 50 }, () => emptyAgentRunSummary());
		expect(aggregateAgentRunSummaries(many)).toEqual(emptyAgentRunSummary());
	});

	it("empty + empty monoid", () => {
		const e = emptyAgentRunSummary();
		expect(aggregateAgentRunSummaries([e, e])).toEqual(e);
	});
});
