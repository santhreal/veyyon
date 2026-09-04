/**
 * The `log_experiment` card draws what main's renderer drew.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { createLogExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/log-experiment";
import type { ExperimentResult, ExperimentState, LogDetails } from "@veyyon/coding-agent/autoresearch/types";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { theme } from "@veyyon/coding-agent/theme/theme";
import * as logExperimentOracle from "../oracles/log-experiment-main-renderer";
import {
	autoresearchOptions,
	COLLAPSED,
	EXPANDED,
	HOST_COLLAPSED,
	lineView,
	renderCompText,
	useDifferentialTheme,
	views,
} from "./harness";

useDifferentialTheme();

describe("log_experiment tool differential", () => {
	const view = views(createLogExperimentTool(autoresearchOptions()));

	it("renders pending call for keep, discard, and crash outcomes with exact byte parity", () => {
		const statuses: Array<"keep" | "discard" | "crash" | "checks_failed"> = [
			"keep",
			"discard",
			"crash",
			"checks_failed",
		];
		for (const status of statuses) {
			const callArgs = { status, metric: 34.5, description: `attempted ${status} approach` };
			const oracleComp = logExperimentOracle.renderCall(callArgs, HOST_COLLAPSED, theme);
			const card = view.call(callArgs, COLLAPSED);
			expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
		}
	});

	it("renders result with details (keep, baseline, confidence, deviations) with exact byte parity", () => {
		const experiment: ExperimentResult = {
			runNumber: 1,
			commit: "abc1234",
			metric: 14.2,
			metrics: { p99_ms: 18.0 },
			status: "keep",
			description: "unroll hot loop in walker",
			timestamp: 1_764_460_800_000,
			segment: 1,
			confidence: 2.8,
			modifiedPaths: ["crates/walker/src/lib.rs"],
			scopeDeviations: ["crates/walker/mod.rs"],
			justification: "necessary helper",
			flagged: false,
			flaggedReason: null,
		};
		const state: ExperimentState = {
			sessionId: 1,
			name: "speed",
			goal: "optimize walker",
			metricName: "time_ms",
			metricUnit: "ms",
			bestDirection: "lower",
			currentSegment: 1,
			bestMetric: 20.0,
			confidence: 2.8,
			results: [experiment],
			scopePaths: ["crates/walker"],
			offLimits: [],
			constraints: [],
			secondaryMetrics: [],
			maxExperiments: 10,
			breadth: 1,
			notes: "",
			branch: "autoresearch/speed",
			baselineCommit: "0000000",
		};
		const details: LogDetails = {
			experiment,
			state,
			wallClockSeconds: 3.5,
			scopeDeviations: ["crates/walker/mod.rs"],
			justification: "necessary helper",
			flaggedRuns: [],
		};
		const result = {
			content: [{ type: "text" as const, text: "Logged run #1 (keep): 14.2ms" }],
			details,
		};

		const oracleComp = logExperimentOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders result without details (plain fallback) with exact byte parity", () => {
		const result = { content: [{ type: "text" as const, text: "Error: git status failed, run was not logged." }] };
		const oracleComp = logExperimentOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders both collapsed and expanded disclosure states identically", () => {
		for (const disclosure of [COLLAPSED, EXPANDED]) {
			const hostDisclosure: RenderResultOptions = { expanded: disclosure.expanded, isPartial: false };
			const callArgs = { status: "keep" as const, metric: 10.0, description: "kept iteration" };
			const card = view.call(callArgs, disclosure);
			const oracleComp = logExperimentOracle.renderCall(callArgs, hostDisclosure, theme);
			expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
		}
	});
});
