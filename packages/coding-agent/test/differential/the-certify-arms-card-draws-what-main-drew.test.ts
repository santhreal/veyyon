/**
 * The `certify_arms` card draws what main's renderer drew.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { createCertifyArmsTool } from "@veyyon/coding-agent/autoresearch/tools/certify-arms";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { theme } from "@veyyon/coding-agent/theme/theme";
import * as certifyArmsOracle from "../oracles/certify-arms-main-renderer";
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

describe("certify_arms tool differential", () => {
	const view = views(createCertifyArmsTool(autoresearchOptions()));

	it("renders pending call for triage stage with exact byte parity", () => {
		const callArgs = {
			arms: [
				{ arm: "arm-A", hypothesis: "inline function", diff: "+line", modified_paths: ["a.ts"] },
				{ arm: "arm-B", hypothesis: "memoize lookup", diff: "+line", modified_paths: ["b.ts"] },
			],
		};
		const oracleComp = certifyArmsOracle.renderCall(callArgs, HOST_COLLAPSED, theme);
		const card = view.call(callArgs, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders pending call for verdicts stage with exact byte parity", () => {
		const callArgs = {
			arms: [
				{ arm: "arm-A", hypothesis: "inline function", diff: "+line", modified_paths: ["a.ts"] },
				{ arm: "arm-B", hypothesis: "memoize lookup", diff: "+line", modified_paths: ["b.ts"] },
			],
			verdicts: [
				{ arm: "arm-A", certified_by: "arm-B", flagged: false },
				{ arm: "arm-B", certified_by: "arm-A", flagged: true, reason: "gamed metric" },
			],
		};
		const oracleComp = certifyArmsOracle.renderCall(callArgs, HOST_COLLAPSED, theme);
		const card = view.call(callArgs, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders successful triage result with exact byte parity", () => {
		const result = {
			content: [
				{
					type: "text" as const,
					text: "Triaged 2 arms: 2 surviving, 0 rejected.\nCertifier: arm-B.\n- arm-B reviews arm-A",
				},
			],
		};
		const oracleComp = certifyArmsOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders failed result without active session with exact byte parity", () => {
		const result = {
			content: [
				{ type: "text" as const, text: "Error: no active autoresearch session. Call init_experiment first." },
			],
			isError: true,
		};
		const oracleComp = certifyArmsOracle.renderResult(result, HOST_COLLAPSED, theme);
		const card = view.result(result, COLLAPSED);
		expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
	});

	it("renders both collapsed and expanded disclosure states identically", () => {
		for (const disclosure of [COLLAPSED, EXPANDED]) {
			const hostDisclosure: RenderResultOptions = { expanded: disclosure.expanded, isPartial: false };
			const callArgs = { arms: [{ arm: "A", hypothesis: "hyp", diff: "+", modified_paths: ["a.ts"] }] };
			const card = view.call(callArgs, disclosure);
			const oracleComp = certifyArmsOracle.renderCall(callArgs, hostDisclosure, theme);
			expect(renderCompText(drawToolView(lineView(card), theme))).toBe(renderCompText(oracleComp));
		}
	});
});
