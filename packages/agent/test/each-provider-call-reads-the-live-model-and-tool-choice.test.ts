/**
 * Each provider call in a run reads the agent as it is at that call: a model
 * set between two calls of one run serves the second, and a soft tool
 * requirement naming a tool the agent no longer has lapses instead of
 * reminding the model to call a tool it cannot see.
 *
 * Gap: a hard queued tool choice for an inactive tool is covered in
 * agent.test.ts ("drops queued forced toolChoice when the queued tool is not active").
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentTool, type SoftToolRequirement } from "@veyyon/agent-core";
import { type UserMessage, z } from "@veyyon/ai";
import { createMockModel, streamMock } from "@veyyon/ai/providers/mock";

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

describe("each provider call reads the live model and tool choice", () => {
	it("sends the call after a model change to the new model", async () => {
		const first = createMockModel({
			id: "first-model",
			responses: [{ content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "x" } }] }],
		});
		const second = createMockModel({ id: "second-model", responses: [{ content: ["done"] }] });
		const agent = new Agent({
			initialState: { model: first, systemPrompt: ["Test"], tools: [echo], messages: [] },
			streamFn: streamMock,
		});
		agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") agent.setModel(second);
		});

		await agent.prompt("go");

		expect([first.calls.length, second.calls.length]).toEqual([1, 1]);
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", model: "second-model" });
	});

	describe("a soft tool requirement", () => {
		const reminderText = "call echo before answering";

		async function firstCallMessages(toolName: string): Promise<unknown[]> {
			const mock = createMockModel({ handler: { content: ["done"] } });
			const reminder: UserMessage = { role: "user", content: reminderText, synthetic: true, timestamp: Date.now() };
			let served = false;
			const agent = new Agent({
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [echo], messages: [] },
				streamFn: mock.stream,
				getToolChoice: (): SoftToolRequirement | undefined => {
					if (served) return undefined;
					served = true;
					return { soft: true, id: "req-1", toolName, reminder: [reminder] };
				},
			});
			await agent.prompt("go");
			return mock.calls[0]?.context.messages.map(message => message.content) ?? [];
		}

		it("reminds the model when its tool is active", async () => {
			expect(await firstCallMessages("echo")).toContain(reminderText);
		});

		it("lapses when its tool is not active", async () => {
			expect(await firstCallMessages("missing")).not.toContain(reminderText);
		});
	});
});
