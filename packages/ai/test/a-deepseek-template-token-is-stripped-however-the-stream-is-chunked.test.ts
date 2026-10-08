/**
 * WHY: DeepSeek models behind some OpenAI-compatible hosts leak chat-template markers
 * (`<｜Assistant｜>`, `<｜end▁of▁sentence｜>`, `<|DSML|tool_calls|>`) into `delta.content`, and the
 * turn removes them from visible text. The host decides where one chunk ends and the next begins,
 * so the removal is correct only if its result is a function of the concatenated text alone.
 *
 * It was not. A chunk ending in `<` after a marker that had already closed released the `<`, and
 * the next chunk's `｜end▁of▁sentence｜>` reached the transcript as a broken marker. Whitespace
 * around a marker was trimmed only when the marker sat at the edge of a chunk, so the same answer
 * read "x < y and z" or "x < y andz" depending on the split.
 *
 * THE CLASS this closes: "the visible text of a DeepSeek turn depends on how the host chunked the
 * stream". Each case states its visible text once, and every chunking of its content reaches the
 * same text, in the final message and in the streamed `text_delta` events alike: the whole text,
 * every split into two and three parts, and one chunk per character.
 *
 * WHAT IT DOES NOT CATCH: chunkings into four or more parts other than one character per chunk,
 * text interleaved with reasoning or tool-call deltas, and the holds of the in-band dialect
 * scanners, which `a-scanner-emits-the-same-events-however-the-stream-is-chunked.test.ts` sweeps.
 */
import { describe, expect, it } from "bun:test";
import { createInitialResponsesAssistantMessage } from "@veyyon/ai/providers/initial-message";
import { OpenAICompletionsTurn } from "@veyyon/ai/providers/openai-completions-stream";
import type { AssistantMessageEvent } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";

const DEEPSEEK_STREAM_POLICY = {
	stripSpecialTokens: "deepseek",
	reasoningDeltasMayBeCumulative: false,
	emptyLengthFinishIsContextError: false,
} as const;

interface Case {
	name: string;
	content: string;
	visible: string;
}

const cases: Case[] = [
	{
		name: "a marker followed by the template's blank line",
		content: "去改前端交互描述：<｜Assistant｜>\n\n让我找到对应位置并修改。",
		visible: "去改前端交互描述：让我找到对应位置并修改。",
	},
	{
		name: "a marker that begins right after an earlier marker closed",
		content: "<｜Assistant｜>Sure.<｜end▁of▁sentence｜>",
		visible: "Sure.",
	},
	{
		name: "an ASCII-pipe marker between two words",
		content: "a <|DSML|tool_calls|> b",
		visible: "a b",
	},
	{
		name: "a lone angle bracket in prose before a marker",
		content: "x < y and <｜Assistant｜>z",
		visible: "x < y and z",
	},
	{
		name: "a marker that opens a sentence of several words",
		content: "<｜Assistant｜>Sure, it is fixed.",
		visible: "Sure, it is fixed.",
	},
	{
		name: "two adjacent markers",
		content: "one<｜end｜><｜Assistant｜>two",
		visible: "onetwo",
	},
	{
		name: "whitespace before a marker that ends the turn",
		content: "Hello <｜end▁of▁sentence｜>\n",
		visible: "Hello ",
	},
	{
		name: "an ASCII delimiter in prose that never closes",
		content: "keep a<|b and c",
		visible: "keep a<|b and c",
	},
	{
		name: "a partial marker the turn ends on",
		content: "tail <｜",
		visible: "tail <｜",
	},
];

/** The whole text, every split into two and three non-empty parts, and one chunk per character. */
function chunkings(content: string): string[][] {
	const chars = Array.from(content);
	const result: string[][] = [[content], chars];
	for (let first = 1; first < chars.length; first++) {
		result.push([chars.slice(0, first).join(""), chars.slice(first).join("")]);
		for (let second = first + 1; second < chars.length; second++) {
			result.push([
				chars.slice(0, first).join(""),
				chars.slice(first, second).join(""),
				chars.slice(second).join(""),
			]);
		}
	}
	return result;
}

async function streamContent(parts: string[]): Promise<{ text: string; streamed: string }> {
	const output = createInitialResponsesAssistantMessage("openai-completions", "deepseek", "deepseek-v4-flash");
	const stream = new AssistantMessageEventStream();
	const turn = new OpenAICompletionsTurn(output, stream, DEEPSEEK_STREAM_POLICY, () => output.usage);
	for (const part of parts) {
		turn.applyChunk({
			id: "chatcmpl-deepseek",
			object: "chat.completion.chunk",
			created: 0,
			model: "deepseek-v4-flash",
			choices: [{ index: 0, delta: { content: part }, finish_reason: null, logprobs: null }],
		});
	}
	turn.flush();
	stream.end(output);

	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const text = output.content.map(block => (block.type === "text" ? block.text : "")).join("");
	const streamed = events.map(event => (event.type === "text_delta" ? event.delta : "")).join("");
	return { text, streamed };
}

describe("a DeepSeek template token is stripped however the stream is chunked", () => {
	for (const testCase of cases) {
		it(`shows the same text for every chunking of ${testCase.name}`, async () => {
			const divergent: { parts: string[]; text: string; streamed: string }[] = [];
			for (const parts of chunkings(testCase.content)) {
				const { text, streamed } = await streamContent(parts);
				if (text !== testCase.visible || streamed !== testCase.visible) divergent.push({ parts, text, streamed });
			}
			expect(divergent).toEqual([]);
		});
	}
});
