/**
 * The `run_experiment` card draws what main's renderer drew, including its live progress rows.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { DEFAULT_HARNESS_COMMAND } from "@veyyon/coding-agent/autoresearch/tools/init-experiment";
import { createRunExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/run-experiment";
import type { RunDetails, RunExperimentProgressDetails } from "@veyyon/coding-agent/autoresearch/types";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import * as runExperimentOracle from "../oracles/run-experiment-main-renderer";
import {
	autoresearchOptions,
	COLLAPSED,
	EXPANDED,
	HOST_COLLAPSED,
	HOST_EXPANDED,
	lineView,
	renderCompText,
	useDifferentialTheme,
	views,
} from "./harness";

useDifferentialTheme();

describe("run_experiment tool differential", () => {
	const view = views(createRunExperimentTool(autoresearchOptions()));

	it("renders pending call with exact byte parity", () => {
		const oracleComp = runExperimentOracle.renderCall({}, HOST_COLLAPSED, theme);
		const card = view.call({}, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders running progress result with exact byte parity", () => {
		const progressDetails: RunExperimentProgressDetails = {
			phase: "running",
			elapsed: "8.4s",
		};
		const result = {
			content: [{ type: "text" as const, text: "Benchmarking iteration 3..." }],
			details: progressDetails,
		};
		const oracleComp = runExperimentOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders successful run result in collapsed state with last 5 tail output lines with exact byte parity", () => {
		const tailOutput = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8";
		const runDetails: RunDetails = {
			command: DEFAULT_HARNESS_COMMAND,
			durationSeconds: 4.2,
			exitCode: 0,
			timedOut: false,
			passed: true,
			metricName: "time_ms",
			metricUnit: "ms",
			parsedPrimary: 12.4,
			parsedMetrics: {},
			parsedAsi: null,
			tailOutput,
			runNumber: 3,
			benchmarkLogPath: "run/bench.log",
			crashed: false,
			abandonedPriorRun: null,
			runDirectory: "run",
			preRunDirtyPaths: [],
		};
		const result = {
			content: [{ type: "text" as const, text: "PASS 4.2s time_ms=12.4ms" }],
			details: runDetails,
		};

		const oracleComp = runExperimentOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders successful run result in expanded state with full output and path warning with exact byte parity", () => {
		const tailOutput = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8";
		const runDetails: RunDetails = {
			command: DEFAULT_HARNESS_COMMAND,
			durationSeconds: 4.2,
			exitCode: 0,
			timedOut: false,
			passed: true,
			metricName: "time_ms",
			metricUnit: "ms",
			parsedPrimary: 12.4,
			parsedMetrics: {},
			parsedAsi: null,
			tailOutput,
			runNumber: 3,
			benchmarkLogPath: "run/bench.log",
			crashed: false,
			abandonedPriorRun: null,
			truncation: {
				content: tailOutput,
				truncated: true,
				truncatedBy: "lines" as const,
				totalLines: 4096,
				totalBytes: 262_144,
			},
			fullOutputPath: "run/output.log",
			runDirectory: "run",
			preRunDirtyPaths: [],
		};
		const result = {
			content: [{ type: "text" as const, text: "PASS 4.2s time_ms=12.4ms" }],
			details: runDetails,
		};

		const oracleComp = runExperimentOracle.renderResult(result, HOST_EXPANDED, theme);
		const card = view.result(result, EXPANDED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders run failure (exitCode !== 0) with exact byte parity", () => {
		const runDetails: RunDetails = {
			command: DEFAULT_HARNESS_COMMAND,
			durationSeconds: 2.1,
			exitCode: 1,
			timedOut: false,
			passed: false,
			metricName: "time_ms",
			metricUnit: "ms",
			parsedPrimary: null,
			parsedMetrics: {},
			parsedAsi: null,
			tailOutput: "Syntax error on line 42",
			runNumber: 4,
			benchmarkLogPath: "run/bench.log",
			crashed: false,
			abandonedPriorRun: null,
			runDirectory: "run",
			preRunDirtyPaths: [],
		};
		const result = {
			content: [{ type: "text" as const, text: "FAIL exit=1 2.1s" }],
			details: runDetails,
		};

		const oracleComp = runExperimentOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders run timeout (timedOut: true) with exact byte parity", () => {
		const runDetails: RunDetails = {
			command: DEFAULT_HARNESS_COMMAND,
			durationSeconds: 30.0,
			exitCode: 137,
			timedOut: true,
			passed: false,
			metricName: "time_ms",
			metricUnit: "ms",
			parsedPrimary: null,
			parsedMetrics: {},
			parsedAsi: null,
			tailOutput: "Timed out waiting for process",
			runNumber: 5,
			benchmarkLogPath: "run/bench.log",
			crashed: false,
			abandonedPriorRun: null,
			runDirectory: "run",
			preRunDirtyPaths: [],
		};
		const result = {
			content: [{ type: "text" as const, text: "TIMEOUT 30.0s" }],
			details: runDetails,
		};

		const oracleComp = runExperimentOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders fallback error without details with exact byte parity", () => {
		const result = { content: [{ type: "text" as const, text: "Error: command not found: ./autoresearch.sh" }] };
		const oracleComp = runExperimentOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});
});
