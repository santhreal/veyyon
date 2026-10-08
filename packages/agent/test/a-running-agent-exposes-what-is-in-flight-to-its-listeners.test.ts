/**
 * A listener reads `agent.state` while it handles an event, and the state it
 * reads matches the event: the message being streamed is `streamMessage`, a
 * tool between its start and end is in `pendingToolCalls`, `agent_end` finds
 * the agent no longer streaming, and a turn that ended in a provider error
 * leaves that error in `state.error`.
 *
 * Gap: the Cursor path, where an assistant `message_end` is re-emitted in split
 * form, is covered by a-cursor-tool-result-follows-the-assistant-message-that-ran-it.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import { z } from "@veyyon/ai";
import { createMockModel, type MockResponse } from "@veyyon/ai/providers/mock";

const echoSchema = z.object({ value: z.string() });

const echo: AgentTool<typeof echoSchema, { value: string }> = {
	name: "echo",
	label: "Echo",
	description: "Echo tool",
	parameters: echoSchema,
	async execute(_toolCallId, params) {
		return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
	},
};

function agentWith(responses: MockResponse[]): Agent {
	const mock = createMockModel({ responses });
	return new Agent({
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [echo], messages: [] },
		streamFn: mock.stream,
	});
}

describe("a running agent exposes what is in flight to its listeners", () => {
	it("points streamMessage at the assistant message each start and update carries", async () => {
		const agent = agentWith([{ content: ["streamed answer"] }]);
		const reads: Array<[string, boolean]> = [];
		agent.subscribe(event => {
			if (
				(event.type === "message_start" || event.type === "message_update") &&
				event.message.role === "assistant"
			) {
				reads.push([event.type, agent.state.streamMessage === event.message]);
			}
		});

		await agent.prompt("go");

		expect(reads[0]).toEqual(["message_start", true]);
		expect(reads.some(([type]) => type === "message_update")).toBe(true);
		expect(reads.filter(([, current]) => !current)).toEqual([]);
	});

	it("holds a tool call in pendingToolCalls from its start to its end", async () => {
		const agent = agentWith([
			{ content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "x" } }] },
			{ content: ["done"] },
		]);
		const reads: Array<[string, boolean]> = [];
		agent.subscribe(event => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				reads.push([event.type, agent.state.pendingToolCalls.has(event.toolCallId)]);
			}
		});

		await agent.prompt("go");

		expect(reads).toEqual([
			["tool_execution_start", true],
			["tool_execution_end", false],
		]);
	});

	it("reports the agent idle with no streamed message at agent_end", async () => {
		const agent = agentWith([{ content: ["answer"] }]);
		const atEnd: Array<{ isStreaming: boolean; streamMessage: unknown }> = [];
		agent.subscribe(event => {
			if (event.type === "agent_end") {
				atEnd.push({ isStreaming: agent.state.isStreaming, streamMessage: agent.state.streamMessage });
			}
		});

		await agent.prompt("go");

		expect(atEnd).toEqual([{ isStreaming: false, streamMessage: null }]);
	});

	it("records the error a provider turn ended with", async () => {
		const agent = agentWith([{ content: ["partial"], stopReason: "error", errorMessage: "upstream failed" }]);

		await agent.prompt("go");

		expect(agent.state.error).toBe("upstream failed");
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", errorMessage: "upstream failed" });
	});
});
