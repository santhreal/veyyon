/**
 * A rewrite of the finished assistant message is what every reader of that message sees.
 *
 * WHY. `transformAssistantMessage` expands inline macros on the finished assistant message before anything
 * downstream reads it. A loop that skips the hook, or runs it after one reader has taken its copy, leaves the raw
 * macro token where that reader looks: in the transcript, in the `message_end` the UI draws, in the arguments a tool
 * runs with, or in the history the next provider call sends.
 *
 * CLASS. Every reader of a finished assistant message, each checked for the rewritten text and the absence of the
 * token: the committed message, its `message_end` event, the arguments the tool ran with, and the history the next
 * provider call carries. The hook runs once per finished message and receives the run's abort signal.
 *
 * GAP. An aborted turn, and a stream that ends without a terminal event, commit without running the hook; this suite
 * does not cover those endings.
 */
import { describe, expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@veyyon/agent-core/types";
import type { AssistantMessage, Message } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { type } from "arktype";
import { createUserMessage } from "./helpers";

const TOKEN = "@[[runtime.today()]]";
const EXPANDED = "2030-01-01";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function expand(message: AssistantMessage): void {
	for (const block of message.content) {
		if (block.type === "text") block.text = block.text.replaceAll(TOKEN, EXPANDED);
		if (block.type === "toolCall" && typeof block.arguments.msg === "string") {
			block.arguments = { ...block.arguments, msg: block.arguments.msg.replaceAll(TOKEN, EXPANDED) };
		}
	}
}

/** What a reader saw of each assistant message: its text, then the `msg` of each tool call. */
function readout(message: AgentMessage): string[] {
	if (message.role !== "assistant") return [];
	return message.content.flatMap(block => {
		if (block.type === "text") return [block.text];
		if (block.type === "toolCall") return [`call:${String(block.arguments.msg)}`];
		return [];
	});
}

describe("a rewrite of the finished assistant message is what every reader sees", () => {
	it("reaches the committed message, its message_end, the tool and the next call's history", async () => {
		const echoSchema = type({ msg: "string" });
		const ranWith: string[] = [];
		const echoTool: AgentTool<typeof echoSchema, { msg: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo a message back",
			parameters: echoSchema,
			async execute(_toolCallId, params) {
				ranWith.push(params.msg);
				return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [`today is ${TOKEN}`, { type: "toolCall", name: "echo", arguments: { msg: TOKEN } }] },
				{ content: [`still ${TOKEN}`] },
			],
		});
		const controller = new AbortController();
		const hookSignals: (AbortSignal | undefined)[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			transformAssistantMessage: (message, signal) => {
				hookSignals.push(signal);
				expand(message);
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [echoTool] };
		const loop = agentLoop([createUserMessage("go")], context, config, controller.signal, mock.stream);
		const events: AgentEvent[] = [];
		for await (const event of loop) events.push(event);
		const committed = await loop.result();

		const expected = [`today is ${EXPANDED}`, `call:${EXPANDED}`, `still ${EXPANDED}`];
		expect(committed.flatMap(readout)).toEqual(expected);
		expect(events.flatMap(event => (event.type === "message_end" ? readout(event.message) : []))).toEqual(expected);
		expect(ranWith).toEqual([EXPANDED]);
		expect(mock.calls).toHaveLength(2);
		expect(mock.calls[1].context.messages.flatMap(readout)).toEqual(expected.slice(0, 2));
		expect(hookSignals).toEqual([controller.signal, controller.signal]);
	});
});
