/**
 * WHY: The terminal must supply the completed call arguments to result renderers
 * through either renderer entry point. The shared call boundary covers tools
 * supplied directly or through adapters; adapter forwarding has separate tests.
 * This suite does not exercise tool execution or provider argument decoding.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AnyAgentTool } from "@veyyon/agent-core";
import { Text } from "@veyyon/tui";
import { isRecord } from "@veyyon/utils/type-guards";
import { initTheme } from "../src/theme/theme";
import { createToolExecution } from "./helpers/tool-execution";

beforeAll(async () => {
	await initTheme();
});

const result = { content: [{ type: "text" as const, text: "completed" }], details: {} };
const tool: AnyAgentTool = {
	name: "argument-renderer",
	label: "Argument renderer",
	description: "Shows the completed call input",
	parameters: { type: "object", properties: { input: { type: "string" } } },
	execute: async () => result,
};

function renderResult(_result: unknown, _options: unknown, _theme: unknown, args?: unknown): Text {
	return new Text(`Result for ${isRecord(args) ? args.input : "missing arguments"}`, 0, 0);
}

describe("result rendering uses the completed arguments", () => {
	for (const source of ["tool", "custom renderer"] as const) {
		it(`renders the latest arguments through the ${source} entry point`, () => {
			const card = createToolExecution(
				tool.name,
				{ input: "incomplete" },
				source === "custom renderer" ? { customRenderer: { renderResult } } : {},
				source === "tool" ? { ...tool, renderResult } : tool,
			);
			card.updateArgs({ input: "completed input" });
			card.setArgsComplete();
			card.updateResult(result, true);
			expect(stripVTControlCharacters(card.render(100).join("\n"))).toContain("Result for completed input");
			card.updateResult(result, false);
			expect(stripVTControlCharacters(card.render(100).join("\n"))).toContain("Result for completed input");
		});
	}
});
