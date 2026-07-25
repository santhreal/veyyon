import { describe, expect, it } from "bun:test";
import { streamGoogleGeminiCli } from "@veyyon/ai/providers/google-gemini-cli";
import type { AssistantMessageEvent, Context, FetchImpl, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

function createModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-2.5-flash",
		name: "google-gemini-cli",
		api: "google-gemini-cli",
		provider: "google-gemini-cli",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

function createContext(): Context {
	return { messages: [{ role: "user", content: "implement token refresh", timestamp: Date.now() }] };
}

/**
 * The three ways the planning-leak filter can be reached must agree.
 *
 * `consumePlanningBuffer` decides whether a leading JSON object is the model's
 * internal planning (which must never reach the user) or ordinary content the
 * user asked for. It gets there three ways: the object parses as JSON, the object
 * does not parse (unescaped quotes inside a string), or the stream ends with no
 * closing brace at all. The textual signature that answers the question was
 * written out separately for two of those paths, as byte-identical copies.
 *
 * Byte-identical copies drift, and the drift here is invisible: each path is
 * reached only by a differently-malformed input, so adding a signature to one
 * copy and not the other would leave planning JSON leaking to the user through
 * exactly one of three doors, with every existing test still green. This suite
 * walks all three doors with the same signature so a second definition cannot
 * come back unnoticed.
 */
describe("the planning-leak signature is one rule, whichever path reaches it", () => {
	/** Drive the streaming provider over a fixed list of SSE chunks. */
	async function streamChunks(sseChunks: string[]): Promise<{ text: string; blocks: number }> {
		const fetchMock: FetchImpl = async () => {
			const stream = new ReadableStream({
				async start(controller) {
					const encoder = new TextEncoder();
					for (const chunk of sseChunks) controller.enqueue(encoder.encode(chunk));
					controller.close();
				},
			});
			const response = new Response(stream, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
			Object.defineProperty(response, "url", {
				value: "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent",
			});
			return response;
		};

		const events: AssistantMessageEvent[] = [];
		const stream = streamGoogleGeminiCli(createModel(), createContext(), {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		// `delta`, not `text`: a `text_delta` event carries the increment under
		// `delta` and the whole message so far under `partial`. Reading the wrong
		// field yields "" for every stream, which would make each suppression
		// assertion below pass vacuously — the release cases are what caught it.
		const text = events
			.filter(event => event.type === "text_delta")
			.map(event => (event as { delta: string }).delta)
			.join("");
		return { text, blocks: result.content.length };
	}

	/** One SSE frame carrying `text` as a model part, optionally finishing the turn. */
	const frame = (text: string, finish = false) =>
		`data: ${JSON.stringify({
			response: {
				candidates: [
					{
						content: { role: "model", parts: [{ text }] },
						...(finish ? { finishReason: "STOP" } : {}),
					},
				],
			},
		})}\n\n`;

	/** Door one: the planning object is well-formed and parses. */
	it("suppresses a leak whose JSON parses cleanly", async () => {
		// Only the "thought" key marks this as a leak. Adding a second signature
		// (a tool name, "command", "paths") would let the case keep passing after a
		// regression removed the first, which is exactly the drift being guarded.
		const { text, blocks } = await streamChunks([
			frame('{\n  "thought": "plan the work",\n'),
			frame('  "note": "nothing else marks this"\n}', true),
		]);
		expect(text).toBe("");
		expect(blocks).toBe(0);
	});

	/**
	 * Door two: an unescaped quote inside a string value defeats JSON.parse, so
	 * only the textual signature can catch it. This is the path whose copy of the
	 * predicate was most likely to drift, because nothing else exercises it.
	 */
	it("suppresses a leak whose JSON does not parse, through the textual signature", async () => {
		const { text, blocks } = await streamChunks([
			frame('{\n  "thought": "the user said "go" and I will plan",\n'),
			frame('  "note": "nothing else marks this"\n}', true),
		]);
		expect(text).toBe("");
		expect(blocks).toBe(0);
	});

	/** Door three: the stream ends mid-object, with no closing brace to slice on. */
	it("suppresses a leak that never closes its brace before the stream ends", async () => {
		const { text, blocks } = await streamChunks([frame('{\n  "thought": "planning, and then the stream died', true)]);
		expect(text).toBe("");
		expect(blocks).toBe(0);
	});

	/**
	 * The other half of the contract, and the reason the signature cannot simply
	 * be "starts with a brace": JSON the user actually asked for must come through
	 * untouched. A filter that suppresses this is worse than one that leaks, since
	 * it silently eats the answer.
	 */
	it("releases ordinary JSON content that carries no leak signature", async () => {
		const { text } = await streamChunks([frame('{\n  "name": "veyyon",\n'), frame('  "version": "1.0.0"\n}', true)]);
		expect(text).toBe('{\n  "name": "veyyon",\n  "version": "1.0.0"\n}');
	});

	/**
	 * And the same for JSON that does not parse. The unparseable path must not
	 * become a blanket "swallow anything I could not read": its documented
	 * behaviour is to release unrecognised content as normal text.
	 */
	it("releases unparseable JSON that carries no leak signature", async () => {
		const { text } = await streamChunks([
			frame('{\n  "note": "he said "hi" to me",\n'),
			frame('  "ok": true\n}', true),
		]);
		expect(text).toContain('"note"');
		expect(text).toContain("hi");
	});
});
