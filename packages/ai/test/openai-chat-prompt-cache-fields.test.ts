/**
 * Chat Completions cache/billing wire surface.
 *
 * `OpenAICompletionsParams` declares `prompt_cache_key` and
 * `prompt_cache_retention` (packages/ai/src/providers/openai-chat-wire.ts), and
 * `prompt_cache_breakpoint` is a real Chat Completions field on `text` /
 * `image_url` / `input_audio` / `file` / `refusal` blocks. Veyyon implements none
 * of them on this path: the resolved cache key only ever becomes a routing
 * header. These tests pin that all-or-nothing property. A half-sent field here is
 * the exact failure class that already shipped once — a cache marker or retention
 * control on a wire that was never proven to accept it fails the whole turn with
 * `invalid_parameter`, and a retention field with no marker beside it is
 * incoherent on 5.6+, where `prompt_cache_retention` is deprecated.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel } from "@veyyon/catalog/models";

function sseResponse(events: unknown[]): Response {
	const payload = `${events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Official-endpoint GPT-5.6 on the Chat Completions wire. */
function officialChatModel(): Model<"openai-completions"> {
	const base = getBundledModel("openai", "gpt-5.6-sol");
	return buildModel({
		...base,
		api: "openai-completions",
		compat: base.compatConfig,
	} as ModelSpec<"openai-completions">);
}

const context: Context = {
	systemPrompt: ["stable harness prompt", "changing project context"],
	messages: [{ role: "user", content: "Run the task", timestamp: 1 }],
};

/** Parse a captured request body into a keyed record without asserting a shape. */
function requestFields(body: string | null): Record<string, unknown> {
	expect(body).not.toBeNull();
	const parsed: unknown = JSON.parse(body ?? "null");
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("chat completions request body is not a JSON object");
	}
	return { ...parsed };
}

/** Every `prompt_cache_breakpoint` reachable from a chat `messages` array. */
function breakpointCount(messages: unknown): number {
	if (!Array.isArray(messages)) return 0;
	let count = 0;
	for (const message of messages) {
		if (message === null || typeof message !== "object" || !("content" in message)) continue;
		const content: unknown = message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block !== null && typeof block === "object" && "prompt_cache_breakpoint" in block) count += 1;
		}
	}
	return count;
}

async function captureChatRequest(
	model: Model<"openai-completions">,
	options: { sessionId?: string; cacheRetention?: "none" | "short" | "long" },
): Promise<Record<string, unknown>> {
	const captured: { body: string | null } = { body: null };
	const fetchMock: FetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
		captured.body = typeof init?.body === "string" ? init.body : null;
		return sseResponse([
			{ choices: [{ delta: { content: "ok" }, index: 0 }] },
			{ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
			"[DONE]",
		]);
	};
	const stream = streamOpenAICompletions(model, context, { apiKey: "sk-test", fetch: fetchMock, ...options });
	for await (const _event of stream) {
		/* drain */
	}
	return requestFields(captured.body);
}

describe("OpenAI Chat Completions prompt-cache wire surface", () => {
	/**
	 * Locks the all-or-nothing property for the fully-capable combination: official
	 * `api.openai.com` endpoint, a 5.6+ id whose generation does accept explicit
	 * breakpoints on Responses, a stable cache key, and long retention requested.
	 * Even there the Chat body must carry no cache field, because Veyyon has never
	 * proven the Chat block types or placement against this endpoint. If any single
	 * field starts leaking here, the turn either 400s on `invalid_parameter` or
	 * ships a deprecated retention control with no marker to pair it with.
	 */
	it("sends no cache or retention field even for a keyed official 5.6 request", async () => {
		const fields = await captureChatRequest(officialChatModel(), {
			sessionId: "cache-route",
			cacheRetention: "long",
		});

		expect(fields.prompt_cache_key).toBeUndefined();
		expect(fields.prompt_cache_retention).toBeUndefined();
		expect(breakpointCount(fields.messages)).toBe(0);
		// The turn must still be a well-formed request, not an empty capture.
		expect(fields.model).toBe("gpt-5.6-sol");
		expect(fields.stream).toBe(true);
	});

	/**
	 * Negative half of the same property: `cacheRetention: "none"` is the path that
	 * discards the cache key outright. It must not flip any cache field to an
	 * explicit `null` or `"in_memory"` value either — a present-but-null field is
	 * still a field on the wire, and `prompt_cache_retention: null` would claim a
	 * retention decision Veyyon never made on this endpoint.
	 */
	it("emits no cache field keys at all when cache affinity is disabled", async () => {
		const fields = await captureChatRequest(officialChatModel(), {
			sessionId: "cache-route",
			cacheRetention: "none",
		});

		expect("prompt_cache_key" in fields).toBe(false);
		expect("prompt_cache_retention" in fields).toBe(false);
		expect(breakpointCount(fields.messages)).toBe(0);
	});

	/**
	 * Boundary: the multi-block system shape is where a Responses-style marker would
	 * most plausibly be copied over, because Chat splits the stable harness prompt
	 * into its own leading message exactly like the Responses developer blocks do.
	 * Those messages must stay plain strings — a `text` block array is the shape a
	 * breakpoint attaches to, so its absence is what keeps the marker unreachable.
	 */
	it("keeps system messages as plain strings so no block can carry a marker", async () => {
		const fields = await captureChatRequest(officialChatModel(), { sessionId: "cache-route" });
		const messages: unknown = fields.messages;
		if (!Array.isArray(messages)) throw new Error("chat completions request carries no messages array");

		expect(messages.slice(0, 2)).toEqual([
			{ role: "developer", content: "stable harness prompt" },
			{ role: "developer", content: "changing project context" },
		]);
		expect(breakpointCount(messages)).toBe(0);
	});
});
