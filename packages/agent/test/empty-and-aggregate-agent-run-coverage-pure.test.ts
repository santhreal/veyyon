/**
 * emptyAgentRunCoverage / aggregateAgentRunCoverage identity monoid.
 */
import { describe, expect, it } from "bun:test";
import {
	aggregateAgentRunCoverage,
	emptyAgentRunCoverage,
} from "@veyyon/agent-core/run-collector";

describe("empty and aggregate agent run coverage pure", () => {
	it("empty stable", () => {
		expect(emptyAgentRunCoverage()).toEqual(emptyAgentRunCoverage());
	});

	it("aggregate empty list", () => {
		expect(aggregateAgentRunCoverage([])).toEqual(emptyAgentRunCoverage());
	});

	it("aggregate many empties", () => {
		const many = Array.from({ length: 30 }, () => emptyAgentRunCoverage());
		expect(aggregateAgentRunCoverage(many)).toEqual(emptyAgentRunCoverage());
	});
});
