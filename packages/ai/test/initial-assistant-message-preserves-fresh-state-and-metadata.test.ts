/**
 * Initial streaming messages must preserve API identity and independent mutable
 * content and accounting through both exported constructor paths.
 * This suite does not exercise provider transport, credentials, retries or event ordering.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { emptyUsage } from "@veyyon/catalog/models";
import { createInitialResponsesAssistantMessage } from "../src/providers/initial-message";
import { createInitialResponsesAssistantMessage as createInitialFromOpenAIShared } from "../src/providers/openai-shared";
import type { Api, AssistantMessage } from "../src/types";

describe("initial assistant message constructor", () => {
	const FIXED_TIMESTAMP = 1_700_000_000_000;

	it("constructs an initial assistant message with explicit metadata oracle and deterministic timestamp", () => {
		const dateNowSpy = spyOn(Date, "now").mockReturnValue(FIXED_TIMESTAMP);
		try {
			const msg: AssistantMessage = createInitialResponsesAssistantMessage(
				"openai-responses" as Api,
				"openai",
				"gpt-4o",
			);

			expect(msg).toEqual({
				role: "assistant",
				content: [],
				api: "openai-responses" as Api,
				provider: "openai",
				model: "gpt-4o",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
				stopReason: "stop",
				timestamp: FIXED_TIMESTAMP,
			});
		} finally {
			dateNowSpy.mockRestore();
		}
	});

	it("allocates fresh content array per call (isolated from shared-content mutation)", () => {
		const msg1 = createInitialResponsesAssistantMessage("bedrock-converse-stream" as Api, "amazon-bedrock", "claude");
		const msg2 = createInitialResponsesAssistantMessage("bedrock-converse-stream" as Api, "amazon-bedrock", "claude");

		msg1.content.push({ type: "text", text: "mutated content block" });

		expect(msg2.content).toEqual([]);
	});

	it("allocates fresh usage object per call (isolated from shared-usage mutation)", () => {
		const msg1 = createInitialResponsesAssistantMessage("cursor-agent" as Api, "cursor", "cursor-fast");
		const msg2 = createInitialResponsesAssistantMessage("cursor-agent" as Api, "cursor", "cursor-fast");

		msg1.usage.input = 100;
		msg1.usage.output = 50;
		msg1.usage.cacheRead = 25;
		msg1.usage.cacheWrite = 10;
		msg1.usage.totalTokens = 185;

		expect(msg2.usage.input).toBe(0);
		expect(msg2.usage.output).toBe(0);
		expect(msg2.usage.cacheRead).toBe(0);
		expect(msg2.usage.cacheWrite).toBe(0);
		expect(msg2.usage.totalTokens).toBe(0);
	});

	it("allocates fresh usage.cost object per call (isolated from shared-cost mutation)", () => {
		const msg1 = createInitialResponsesAssistantMessage("devin-agent" as Api, "devin", "devin");
		const msg2 = createInitialResponsesAssistantMessage("devin-agent" as Api, "devin", "devin");

		msg1.usage.cost.input = 0.01;
		msg1.usage.cost.output = 0.02;
		msg1.usage.cost.cacheRead = 0.005;
		msg1.usage.cost.cacheWrite = 0.002;
		msg1.usage.cost.total = 0.037;

		expect(msg2.usage.cost.input).toBe(0);
		expect(msg2.usage.cost.output).toBe(0);
		expect(msg2.usage.cost.cacheRead).toBe(0);
		expect(msg2.usage.cost.cacheWrite).toBe(0);
		expect(msg2.usage.cost.total).toBe(0);
	});

	it("re-exports functional helper from openai-shared with independent oracle assertions", () => {
		const dateNowSpy = spyOn(Date, "now").mockReturnValue(FIXED_TIMESTAMP);
		try {
			const msg: AssistantMessage = createInitialFromOpenAIShared("openai-completions", "openai", "gpt-4o-mini");

			expect(msg).toEqual({
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "openai",
				model: "gpt-4o-mini",
				usage: emptyUsage(),
				stopReason: "stop",
				timestamp: FIXED_TIMESTAMP,
			});
		} finally {
			dateNowSpy.mockRestore();
		}
	});
});
