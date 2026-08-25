/**
 * WHY: `defaultConvertToLlm` in `agent.ts` used `.filter()` on every turn,
 * allocating a new array even when no messages were filtered out (the common
 * case: no refusals, no custom/branch-summary messages). For a 33K-message
 * conversation, that was a 33K-element array allocation per turn.
 *
 * The fast-path pre-scans for any message that would be filtered out. If
 * none, it returns the input array by reference. This test verifies the
 * filter behavior through the agent's run pipeline: a refusal message is
 * excluded from the provider context, while normal messages pass through.
 */
import { describe, expect, it } from "bun:test";
import { Agent } from "@veyyon/agent-core";
import { createMockModel } from "@veyyon/ai/providers/mock";
import type { AssistantMessage } from "@veyyon/ai/types";
import { createAssistantMessage } from "./helpers";

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
function makeRefusal(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "I cannot help." }],
		stopReason: "error",
		stopDetails: { type: "refusal", category: null, explanation: "refused" },
		usage: emptyUsage(),
		api: "mock",
		provider: "mock",
		model: "mock-model",
		timestamp: 1,
	};
}

describe("defaultConvertToLlm fast-path", () => {
	it("passes normal messages through without filtering", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({ streamFn: mock.stream });
		agent.replaceMessages([
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
			createAssistantMessage([{ type: "text", text: "hi" }]),
			{ role: "user", content: [{ type: "text", text: "again" }], timestamp: 2 },
		]);

		await agent.continue();
		expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");
		expect(mock.calls).toHaveLength(1);
		// Both user and assistant messages should reach the provider.
		const sentMessages = mock.calls[0]!.context.messages;
		expect(sentMessages.length).toBeGreaterThanOrEqual(2);
	});

	it("filters out refusal messages before sending to the provider", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({ streamFn: mock.stream });

		agent.replaceMessages([
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
			makeRefusal(),
			{ role: "user", content: [{ type: "text", text: "try again" }], timestamp: 2 },
		]);

		await agent.continue();

		expect(mock.calls).toHaveLength(1);
		const sentMessages = mock.calls[0]!.context.messages;
		const hasRefusal = sentMessages.some(
			(m: { role: string; stopReason?: string }) => m.role === "assistant" && m.stopReason === "error",
		);
		expect(hasRefusal).toBe(false);
	});
});
