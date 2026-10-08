/**
 * Cursor runs tools on its side while the assistant message streams and hands
 * each result to `options.cursorOnToolResult`. The agent runs the host's
 * `cursorOnToolResult` hook on it, returns what the hook returned, and holds
 * the result until the assistant message ends; the transcript then reads the
 * assistant message followed by its results, each announced with
 * `message_start`/`message_end`. The agent installs the callback when either
 * a hook or Cursor exec handlers are configured, and not otherwise.
 *
 * Gap: the Cursor provider's own exec channel is covered in packages/ai.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, type AgentOptions, type StreamFn } from "@veyyon/agent-core";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { createAssistantMessage } from "./helpers";

const serverResult: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "cursor-read-1",
	toolName: "read",
	content: [{ type: "text", text: "server output" }],
	isError: false,
	timestamp: 1,
};

interface CursorRun {
	/** What `options.cursorOnToolResult` returned to the provider, or "no callback". */
	providerGot: Array<ToolResultMessage | undefined | "no callback">;
	/** Role and first text of every message in the transcript after the run. */
	transcript: Array<[string, string]>;
	/** `message_start`/`message_end` events for the assistant message and the result, in emit order. */
	events: string[];
}

function firstText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	for (const part of content) if (part.type === "text") return part.text;
	return "";
}

async function runCursorTurn(
	options: Pick<AgentOptions, "cursorOnToolResult" | "cursorExecHandlers">,
): Promise<CursorRun> {
	const mock = createMockModel();
	const providerGot: CursorRun["providerGot"] = [];
	const streamFn: StreamFn = (_model, _context, streamOptions) => {
		const stream = new AssistantMessageEventStream();
		const partial: AssistantMessage = createAssistantMessage([{ type: "text", text: "reading" }]);
		void (async () => {
			stream.push({ type: "start", partial });
			const callback = streamOptions?.cursorOnToolResult;
			providerGot.push(callback ? await callback(serverResult) : "no callback");
			stream.push({
				type: "done",
				reason: "stop",
				message: createAssistantMessage([{ type: "text", text: "read it" }]),
			});
		})();
		return stream;
	};
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn,
		...options,
	});
	const events: string[] = [];
	agent.subscribe(event => {
		if ((event.type === "message_start" || event.type === "message_end") && event.message.role !== "user") {
			events.push(`${event.type}:${event.message.role}`);
		}
	});
	await agent.prompt("go");
	const transcript = agent.state.messages.map((message): [string, string] => [message.role, firstText(message)]);
	return { providerGot, transcript, events };
}

describe("a Cursor tool result follows the assistant message that ran it", () => {
	it("passes the result through the host hook and appends what the hook returned", async () => {
		const run = await runCursorTurn({
			cursorOnToolResult: message => ({ ...message, content: [{ type: "text", text: "host rewrite" }] }),
		});

		expect(run.providerGot).toEqual([expect.objectContaining({ content: [{ type: "text", text: "host rewrite" }] })]);
		expect(run.transcript).toEqual([
			["user", "go"],
			["assistant", "read it"],
			["toolResult", "host rewrite"],
		]);
		expect(run.events).toEqual([
			"message_start:assistant",
			"message_end:assistant",
			"message_start:toolResult",
			"message_end:toolResult",
		]);
	});

	it("keeps the result as it came when the hook returns nothing", async () => {
		const run = await runCursorTurn({ cursorOnToolResult: () => undefined });

		expect(run.providerGot).toEqual([serverResult]);
		expect(run.transcript.at(-1)).toEqual(["toolResult", "server output"]);
	});

	it("buffers results for exec handlers with no hook", async () => {
		const run = await runCursorTurn({ cursorExecHandlers: {} });

		expect(run.providerGot).toEqual([serverResult]);
		expect(run.transcript.map(([role]) => role)).toEqual(["user", "assistant", "toolResult"]);
	});

	it("installs no callback without a hook or exec handlers", async () => {
		const run = await runCursorTurn({});

		expect(run.providerGot).toEqual(["no callback"]);
		expect(run.transcript.map(([role]) => role)).toEqual(["user", "assistant"]);
	});
});
