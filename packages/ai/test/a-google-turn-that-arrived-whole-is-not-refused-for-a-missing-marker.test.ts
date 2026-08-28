/**
 * WHY: a Gemini body that ends without `finishReason` was refused outright.
 *
 * Both Google decoders — `consumeGoogleStream` for the public and Vertex
 * dialects, and the Cloud Code Assist loop in `google-gemini-cli.ts` — treated a
 * missing terminal marker as a truncated response and threw
 * `incomplete-stream`, whatever had already arrived. `utils/terminalless-eof.ts`
 * exists precisely because that decision has two wrong answers and one right
 * one, and its header names this arm: several compatible servers never send the
 * marker, so refusing every marker-less EOF fails turns that were complete. The
 * other four dialects (completions, responses, Bedrock, Ollama) already read the
 * owner; Google held the fifth and sixth copies of the judgement, both stuck on
 * "reject".
 *
 * THE CLASS. One concept — "what does an EOF without a marker mean" — decided
 * per provider. It closes by every producer calling
 * `stopReasonForTerminallessEof`, so a turn that carried usable content settles
 * on its accumulated shape and one that carried nothing is still refused. Both
 * Google dialects are swept here, and the refusal arm is asserted alongside the
 * acceptance arm so routing through the owner cannot be mistaken for
 * accepting everything.
 *
 * WHAT THIS DOES NOT CATCH. The sweep is over the two Google dialects, not over
 * every api; the empty-stream half of the class is
 * `a-stream-that-stops-mid-turn-is-never-reported-as-a-finished-one.test.ts`,
 * which pins all fourteen. A dialect that stops calling the owner and hardcodes
 * `"stop"` would pass the acceptance tests here and fail the refusal ones, which
 * is why both arms are present. Nothing here proves the marker-less body is
 * common in the field: it was observed on Cloud Code Assist, and the fixtures
 * below are hand-built wire frames, not a capture.
 */
import { describe, expect, it } from "bun:test";
import { streamGoogle } from "@veyyon/ai/providers/google";
import { streamGoogleGeminiCli } from "@veyyon/ai/providers/google-gemini-cli";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { stopReasonForTerminallessEof } from "@veyyon/ai/utils/terminalless-eof";
import { buildModel } from "@veyyon/catalog/build";

/** SSE frames with no trailing `finishReason` anywhere: a clean body EOF. */
function sse(...chunks: unknown[]): Response {
	const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Top-level `candidates` shape (public Generative Language + Vertex). */
function genaiParts(...parts: unknown[]): Record<string, unknown> {
	return { candidates: [{ content: { parts } }] };
}

/** `{ response: { candidates } }` envelope (Cloud Code Assist). */
function ccaParts(...parts: unknown[]): Record<string, unknown> {
	return { response: genaiParts(...parts) };
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const genaiModel: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const cliModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (CCA)",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://example.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content
		.filter(b => b.type === "text")
		.map(b => b.text ?? "")
		.join("");
}

const always = (response: () => Response): FetchImpl => {
	return async () => response();
};

describe("a Google turn that arrived whole is not refused for a missing marker", () => {
	it("settles a text-only body with no finishReason as a finished turn", async () => {
		const stream = streamGoogle(genaiModel, context, {
			apiKey: "k",
			fetch: always(() => sse(genaiParts({ text: "Hello!" }))),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("Hello!");
		expect(result.errorMessage).toBeUndefined();
	});

	it("settles a complete function call with no finishReason as a tool-use turn", async () => {
		const stream = streamGoogle(genaiModel, context, {
			apiKey: "k",
			fetch: always(() => sse(genaiParts({ functionCall: { name: "read", args: { path: "a.ts" } } }))),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content.filter(block => block.type === "toolCall")).toHaveLength(1);
	});

	/**
	 * A function call with no name is the one partial shape this dialect can
	 * produce: the id is minted by the decoder and `args` arrives already parsed,
	 * so a nameless call is unusable and outranks any text beside it. Promoting it
	 * would hand the session a tool-use turn naming no tool.
	 */
	it("still refuses a body whose only function call has no name", async () => {
		const stream = streamGoogle(genaiModel, context, {
			apiKey: "k",
			fetch: always(() => sse(genaiParts({ text: "here goes" }, { functionCall: { args: {} } }))),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("without a finish reason");
	});

	it("settles a Cloud Code Assist body with no finishReason as a finished turn", async () => {
		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: always(() => sse(ccaParts({ text: "From CCA" }))),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("From CCA");
	});

	it("still refuses a Cloud Code Assist body whose only function call has no name", async () => {
		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: always(() => sse(ccaParts({ text: "here goes" }, { functionCall: { args: {} } }))),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("without a finish reason");
	});

	/**
	 * The owner's own contract, pinned beside its callers. Both Google decoders
	 * compute `toolBatchIsComplete` the same way — every tool block carries a
	 * name — so the judgement the providers delegate is the judgement asserted.
	 */
	it("delegates to the shared judgement rather than a per-provider guess", () => {
		const text = [{ type: "text" as const, text: "answer" }];
		const namedCall = [{ type: "toolCall" as const, id: "1", name: "read", arguments: {} }];

		expect(stopReasonForTerminallessEof(text, true)).toBe("stop");
		expect(stopReasonForTerminallessEof(namedCall, true)).toBe("toolUse");
		expect(stopReasonForTerminallessEof(namedCall, false)).toBeUndefined();
		expect(stopReasonForTerminallessEof([], true)).toBeUndefined();
	});
});
