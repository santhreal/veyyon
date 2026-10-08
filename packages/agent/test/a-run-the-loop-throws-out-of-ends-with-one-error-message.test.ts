/**
 * A run the agent loop throws out of ends with one assistant error message:
 * appended to the transcript, recorded in `state.error`, and carried by
 * `agent_end`. A run that was aborted before the throw ends `aborted` with the
 * abort's reason, not `error` with the thrown text. An Anthropic output-blocked
 * failure on a streamed assistant message ends that message, keeping what it
 * streamed, rather than replacing it with an empty one; a failure after that
 * message already ended starts a new one instead of reopening the finished one.
 *
 * Gap: the output-blocked variant with no streamed message, emitted as a full
 * turn, is covered in agent.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentEvent, type AgentMessage } from "@veyyon/agent-core";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { createAssistantMessage } from "./helpers";

interface Settled {
	agent: Agent;
	ends: Array<Extract<AgentEvent, { type: "agent_end" }>>;
}

async function settle(agent: Agent): Promise<Settled> {
	const ends: Settled["ends"] = [];
	agent.subscribe(event => {
		if (event.type === "agent_end") ends.push(event);
	});
	await agent.prompt("go");
	return { agent, ends };
}

function expectOneErrorMessage({ agent, ends }: Settled, stopReason: "error" | "aborted", text: string): void {
	const last = agent.state.messages.at(-1);
	expect(last).toMatchObject({ role: "assistant", stopReason, errorMessage: text });
	expect(agent.state.messages.map(message => message.role)).toEqual(["user", "assistant"]);
	expect(agent.state.error).toBe(text);
	expect(ends).toHaveLength(1);
	expect(ends[0]!.messages).toEqual(agent.state.messages.slice(-1));
}

describe("a run the loop throws out of ends with one error message", () => {
	it("records a provider stream failure as an error", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.fail(new Error("connection reset")));
				return stream;
			},
		});

		expectOneErrorMessage(await settle(agent), "error", "connection reset");
	});

	it("records a throw after an abort as aborted, with the abort's reason", async () => {
		const mock = createMockModel({ handler: { content: ["unreached"] } });
		let agent: Agent | undefined;
		agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
			transformContext: async () => {
				agent?.abort("operator cancelled");
				throw new Error("context transform interrupted");
			},
		});

		expectOneErrorMessage(await settle(agent), "aborted", "operator cancelled");
		expect(mock.calls).toHaveLength(0);
	});

	it("keeps the content streamed before an output-blocked failure", async () => {
		const mock = createMockModel();
		const errorText = "Output blocked by content filtering policy";
		const streamed = { ...createAssistantMessage([{ type: "text", text: "the half-written answer" }]), timestamp: 1 };
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: streamed });
					stream.fail(new Error(errorText));
				});
				return stream;
			},
		});
		const ended: AgentMessage[] = [];
		agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") ended.push(event.message);
		});

		const settled = await settle(agent);

		expectOneErrorMessage(settled, "error", errorText);
		expect(agent.state.messages.at(-1)).toMatchObject({ content: streamed.content, timestamp: streamed.timestamp });
		expect(ended).toEqual(agent.state.messages.slice(-1));
	});

	it("starts a new message for an output-blocked failure after the assistant message ended", async () => {
		const mock = createMockModel({ handler: { content: ["the finished answer"] } });
		const errorText = "Output blocked by content filtering policy";
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		agent.setOnTurnEnd(() => {
			throw new Error(errorText);
		});
		const started: AgentMessage[] = [];
		agent.subscribe(event => {
			if (event.type === "message_start" && event.message.role === "assistant") started.push(event.message);
		});

		await agent.prompt("go");

		const [, finished, failed] = agent.state.messages;
		expect(agent.state.messages.map(message => message.role)).toEqual(["user", "assistant", "assistant"]);
		expect(finished).toMatchObject({ content: [{ type: "text", text: "the finished answer" }], stopReason: "stop" });
		expect(failed).toMatchObject({
			content: [{ type: "text", text: "" }],
			stopReason: "error",
			errorMessage: errorText,
		});
		expect(started.at(-1)).toBe(failed);
	});
});
