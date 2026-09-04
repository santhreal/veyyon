/**
 * The `init_experiment` card draws what main's renderer drew.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { createInitExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/init-experiment";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { theme } from "@veyyon/coding-agent/theme/theme";
import * as initExperimentOracle from "../oracles/init-experiment-main-renderer";
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

describe("init_experiment tool differential", () => {
	const view = views(createInitExperimentTool(autoresearchOptions()));

	it("renders pending call with exact byte parity", () => {
		const callArgs = { name: "optimize-grep-kernel", primary_metric: "search_latency_ms" };
		const oracleComp = initExperimentOracle.renderCall(callArgs, HOST_COLLAPSED, theme);
		const card = view.call(callArgs, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders pending call with long name truncated to 100 columns with exact byte parity", () => {
		const callArgs = { name: "x".repeat(300), primary_metric: "ms" };
		const oracleComp = initExperimentOracle.renderCall(callArgs, HOST_COLLAPSED, theme);
		const card = view.call(callArgs, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders successful result with exact byte parity", () => {
		const result = {
			content: [
				{
					type: "text" as const,
					text: "Started session #1: optimize-grep-kernel\nMetric: search_latency_ms (ms, lower is better)\nBenchmark entrypoint: bash autoresearch.sh",
				},
			],
		};
		const oracleComp = initExperimentOracle.renderResult(result);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders failed result with error message with exact byte parity", () => {
		const result = {
			content: [
				{
					type: "text" as const,
					text: "Error: ./autoresearch.sh does not exist. Phase 1 requires writing ./autoresearch.sh.",
				},
			],
			isError: true,
		};
		const oracleComp = initExperimentOracle.renderResult(result);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders both collapsed and expanded disclosure states identically", () => {
		for (const disclosure of [COLLAPSED, EXPANDED]) {
			const hostDisclosure: RenderResultOptions = { expanded: disclosure.expanded, isPartial: false };
			const callArgs = { name: "sweep-variants", primary_metric: "time_ms" };
			const card = view.call(callArgs, disclosure);
			const oracleComp = initExperimentOracle.renderCall(callArgs, hostDisclosure, theme);
			expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
		}
	});
});
