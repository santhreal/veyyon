/**
 * WHY: the Ollama chat path heals leaked chat-template markup inline rather than
 * through `wrapLeakedThinkingStream`, because it alone knows whether the provider
 * also streamed native reasoning and must then drop the healed copy. That inline
 * healer had no test at all, and it was constructed behind
 * `pattern ? new StreamMarkupHealing(...) : undefined` whose false branch was
 * unreachable — `getStreamMarkupHealingPattern` returns `"thinking"` as its floor
 * and never abstains — so four guards downstream could never fire and nothing
 * proved the healer ran.
 *
 * The class of defect: markup a model leaked into `content` reaching the visible
 * text channel verbatim, and reasoning being counted twice when the provider
 * sends it both ways.
 *
 * What it does not catch: the kimi and dsml patterns, which are selected by model
 * identity rather than by anything an Ollama response carries.
 */
import { describe, expect, it } from "bun:test";
import type { Context } from "@veyyon/ai";
import { streamOllama } from "@veyyon/ai/providers/ollama";
import { buildModel } from "@veyyon/catalog/build";

function reasoningModel() {
	return buildModel({
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "ollama-chat",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	});
}

const context: Context = { messages: [{ role: "user", content: "Add two numbers.", timestamp: 0 }] };

function ndjson(...chunks: Record<string, unknown>[]): Response {
	return new Response(`${chunks.map(chunk => JSON.stringify(chunk)).join("\n")}\n`, { status: 200 });
}

async function run(response: () => Response) {
	return await streamOllama(reasoningModel(), context, {
		apiKey: "test-key",
		fetch: async () => response(),
	}).result();
}

describe("an Ollama stream heals markup it leaked into content", () => {
	it("moves a leaked think fence out of the visible text into a thinking block", async () => {
		const result = await run(() =>
			ndjson(
				{ message: { content: "<think>weighing the operands</think>" } },
				{ message: { content: "40" } },
				{ message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 4 },
			),
		);

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "weighing the operands" },
			{ type: "text", text: "40" },
		]);
	});

	it("heals a fence split across deltas", async () => {
		// The scanner is fed incrementally, so a fence that arrives in pieces must
		// not be emitted as visible text while it is still open.
		const result = await run(() =>
			ndjson(
				{ message: { content: "<thi" } },
				{ message: { content: "nk>partial</th" } },
				{ message: { content: "ink>done" } },
				{ message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 4 },
			),
		);

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "partial" },
			{ type: "text", text: "done" },
		]);
	});

	it("keeps native reasoning and drops the healed copy of it", async () => {
		// `suppressHealedThinking`: once the provider streams `message.thinking`,
		// a fence the healer also recovers is the same reasoning arriving twice.
		const result = await run(() =>
			ndjson(
				{ message: { thinking: "native reasoning" } },
				{ message: { content: "<think>leaked copy</think>answer" } },
				{ message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 4 },
			),
		);

		const thinking = result.content.filter(part => part.type === "thinking");
		expect(thinking).toEqual([{ type: "thinking", thinking: "native reasoning" }]);
		expect(result.content.filter(part => part.type === "text")).toEqual([{ type: "text", text: "answer" }]);
	});

	it("leaves content carrying no markup untouched", async () => {
		const result = await run(() =>
			ndjson({
				message: { content: "plain answer" },
				done: true,
				done_reason: "stop",
				prompt_eval_count: 3,
				eval_count: 4,
			}),
		);

		expect(result.content).toEqual([{ type: "text", text: "plain answer" }]);
	});

	it("emits an unterminated fence when the stream ends without a done chunk", async () => {
		const result = await run(() => ndjson({ message: { content: "<think>unterminated fence" } }));

		expect(result.content).toEqual([{ type: "thinking", thinking: "unterminated fence" }]);
		expect(result.stopReason).toBe("error");
	});

	it("keeps bytes held back as a partial marker when the stream ends without a done chunk", async () => {
		// The scanner withholds `<thi` because it may be the start of `<think>`. A
		// connection that drops there never reaches the `done` branch, so the flush
		// after the loop is the only thing that puts those bytes back; without it the
		// answer silently loses its last four characters.
		const truncated = await run(() => ndjson({ message: { content: "answer<thi" } }));
		expect(truncated.content).toEqual([{ type: "text", text: "answer<thi" }]);

		const partialClose = await run(() => ndjson({ message: { content: "<think>reasoning</thi" } }));
		expect(partialClose.content).toEqual([{ type: "thinking", thinking: "reasoning</thi" }]);
	});
});
