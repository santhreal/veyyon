/**
 * Every GitLab Duo agent message reaches the stream once, and a content block holds the text of one message.
 *
 * WHY THIS SUITE EXISTS. Duo sends each checkpoint as a full `ui_chat_log` snapshot, so every frame repeats
 * every message the turn already streamed. The provider emits only what a message added since the last
 * frame, suppresses a message it already emitted under another id at the same turn position, and emits
 * nothing for a message the server rewrote into text that does not extend what was streamed. A delta from
 * a message other than the one that emitted last closes the open block; an earlier message that grew again
 * appended its delta to the later message's block, mixing the two texts.
 *
 * THE CLASS IT CLOSES. The four ways a snapshot entry relates to what was streamed: a new message, a message
 * that grew, a message that was rewritten, and a message repeated under another id, including one whose
 * kind changed between reasoning and answer.
 *
 * WHAT IT DOES NOT CATCH. A repeated message whose text changed at the same time as its id; it is emitted
 * again in full.
 */
import { describe, expect, it } from "bun:test";
import {
	buildGitLabDuoWorkflowStartRequest,
	type GitLabDuoWorkflowStreamState,
	type GitLabDuoWorkflowWebSocketLike,
	runGitLabDuoWorkflowSocket,
} from "@veyyon/ai/providers/gitlab-duo-workflow";
import type { AssistantMessage, Context, Model } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";

const model: Model<"gitlab-duo-agent"> = buildModel({
	id: "claude_sonnet_4_6_vertex",
	name: "claude_sonnet_4_6_vertex",
	api: "gitlab-duo-agent",
	provider: "gitlab-duo-agent",
	baseUrl: "https://gitlab.example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: null,
});

const context: Context = { messages: [{ role: "user", content: "Read the README.", timestamp: 1 }] };

type LogEntry = Record<string, string>;

function answer(id: string, content: string): LogEntry {
	return { message_type: "agent", message_id: id, content };
}

function reasoning(id: string, content: string): LogEntry {
	return { message_type: "agent", message_sub_type: "reasoning", message_id: id, content };
}

/** Streams `snapshots` as checkpoint frames, the last one finishing the turn, and returns the turn's blocks. */
async function stream(snapshots: readonly LogEntry[][]): Promise<AssistantMessage["content"]> {
	const socket: GitLabDuoWorkflowWebSocketLike = {
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
		send() {},
		close() {},
	};
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "gitlab-duo-agent",
		provider: "gitlab-duo-agent",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	const state: GitLabDuoWorkflowStreamState = { stream: new AssistantMessageEventStream(), output, started: true };
	const startPayload = buildGitLabDuoWorkflowStartRequest("workflow-1", model, context);
	const run = runGitLabDuoWorkflowSocket(socket, startPayload, state, { apiKey: "redacted" });
	socket.onopen?.(new Event("open"));
	snapshots.forEach((log, index) => {
		const status = index === snapshots.length - 1 ? "FINISHED" : "RUNNING";
		const checkpoint = JSON.stringify({ channel_values: { ui_chat_log: log } });
		socket.onmessage?.(
			new MessageEvent("message", { data: JSON.stringify({ newCheckpoint: { status, checkpoint } }) }),
		);
	});
	expect(await run).toBe("terminal");
	return output.content;
}

describe("a GitLab Duo agent message reaches the stream once, in a block of its own", () => {
	it("emits only what a message appended since the last snapshot", async () => {
		const blocks = await stream([[answer("a", "Hel")], [answer("a", "Hello")], [answer("a", "Hello")]]);
		expect(blocks).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("emits nothing more for a message rewritten into text that does not extend it", async () => {
		const blocks = await stream([[answer("a", "Hello world")], [answer("a", "Goodbye, everyone")]]);
		expect(blocks).toEqual([{ type: "text", text: "Hello world" }]);
	});

	it("keeps the deltas of two messages that grow in turn in separate blocks", async () => {
		const blocks = await stream([
			[answer("a", "Hel")],
			[answer("a", "Hel"), answer("b", "Wor")],
			[answer("a", "Hello"), answer("b", "Wor")],
			[answer("a", "Hello"), answer("b", "World")],
		]);
		expect(blocks).toEqual([
			{ type: "text", text: "Hel" },
			{ type: "text", text: "Wor" },
			{ type: "text", text: "lo" },
			{ type: "text", text: "ld" },
		]);
	});

	it("suppresses a message repeated under another id at the same turn position", async () => {
		const blocks = await stream([[answer("a", "Done.")], [answer("b", "Done.")]]);
		expect(blocks).toEqual([{ type: "text", text: "Done." }]);
	});

	it("suppresses a reasoning text repeated as an answer under another id at the same turn position", async () => {
		const blocks = await stream([[reasoning("a", "Reading the file.")], [answer("b", "Reading the file.")]]);
		expect(blocks).toEqual([{ type: "thinking", thinking: "Reading the file." }]);
	});
});
