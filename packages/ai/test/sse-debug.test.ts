import { describe, expect, it } from "bun:test";
import type { RawSseEvent } from "@veyyon/ai/types";
import { notifyRawSseEvent, resolveOpenAiSseEventName } from "@veyyon/ai/utils/sse-debug";

describe("notifyRawSseEvent", () => {
	it("dispatches diagnostic events without cloning raw lines", () => {
		const raw = ["event: message", "data: hello"];
		let observed: RawSseEvent | undefined;

		notifyRawSseEvent(
			event => {
				observed = event;
			},
			{ event: "message", data: "hello", raw },
		);

		expect(observed).toEqual({ event: "message", data: "hello", raw });
		expect(observed?.raw).toBe(raw);
	});

	it("keeps observer failures diagnostic-only", () => {
		expect(() =>
			notifyRawSseEvent(
				() => {
					throw new Error("observer failed");
				},
				{ event: "message", data: "hello", raw: ["event: message", "data: hello"] },
			),
		).not.toThrow();
	});

	it("is a no-op when no observer is installed", () => {
		expect(() => notifyRawSseEvent(undefined, { event: null, data: "{}", raw: ["data: {}"] })).not.toThrow();
	});
});

/**
 * `resolveOpenAiSseEventName` fills the semantic event name for OpenAI-family
 * SSE records whose `event:` line was omitted (the name lives in the JSON
 * `type`/`object` field). These tests lock the exact enrichment contract that
 * three provider observers (openai-completions, openai-responses,
 * azure-openai-responses) now share after the byte-identical closures were
 * hoisted into one owner. A regression here would silently mislabel the
 * raw-SSE debug transcript, or worse, let a malformed frame throw into the
 * generation path. Each case asserts the precise mutation, never just "changed".
 */
describe("resolveOpenAiSseEventName", () => {
	function event(partial: Partial<RawSseEvent> & Pick<RawSseEvent, "data">): RawSseEvent {
		return { event: partial.event ?? null, data: partial.data, raw: partial.raw ?? [`data: ${partial.data}`] };
	}

	it("resolves the Responses-API name from the JSON `type` field", () => {
		const e = event({ data: JSON.stringify({ type: "response.output_text.delta", delta: "hi" }) });
		resolveOpenAiSseEventName(e);
		expect(e.event).toBe("response.output_text.delta");
		expect(e.raw).toEqual([
			"event: response.output_text.delta",
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}`,
		]);
	});

	it("resolves the Completions-API name from the JSON `object` field", () => {
		const e = event({ data: JSON.stringify({ object: "chat.completion.chunk", choices: [] }) });
		resolveOpenAiSseEventName(e);
		expect(e.event).toBe("chat.completion.chunk");
		expect(e.raw[0]).toBe("event: chat.completion.chunk");
	});

	it("prefers `type` over `object` when both are present", () => {
		const e = event({ data: JSON.stringify({ type: "response.created", object: "realtime.event" }) });
		resolveOpenAiSseEventName(e);
		expect(e.event).toBe("response.created");
	});

	it("leaves an already-named event untouched (no double-prefix on raw)", () => {
		const raw = ["event: response.done", "data: {}"];
		const e: RawSseEvent = { event: "response.done", data: JSON.stringify({ type: "response.created" }), raw };
		resolveOpenAiSseEventName(e);
		expect(e.event).toBe("response.done");
		expect(e.raw).toBe(raw);
	});

	it("ignores the [DONE] sentinel", () => {
		const e = event({ data: "[DONE]" });
		resolveOpenAiSseEventName(e);
		expect(e.event).toBeNull();
		expect(e.raw).toEqual(["data: [DONE]"]);
	});

	it("is a no-op on an empty data line", () => {
		const e = event({ data: "" });
		resolveOpenAiSseEventName(e);
		expect(e.event).toBeNull();
	});

	it("swallows a malformed JSON frame without throwing or mutating", () => {
		const e = event({ data: '{"type": "response.created"' });
		expect(() => resolveOpenAiSseEventName(e)).not.toThrow();
		expect(e.event).toBeNull();
		expect(e.raw).toEqual(['data: {"type": "response.created"']);
	});

	it("does not enrich when neither `type` nor `object` is a string", () => {
		const e = event({ data: JSON.stringify({ type: 7, object: false, choices: [] }) });
		resolveOpenAiSseEventName(e);
		expect(e.event).toBeNull();
	});

	it("does not enrich a JSON payload with no type/object keys", () => {
		const e = event({ data: JSON.stringify({ delta: "x" }) });
		resolveOpenAiSseEventName(e);
		expect(e.event).toBeNull();
	});

	it("does not throw on a valid non-object JSON scalar (number/null/string)", () => {
		for (const data of ["5", "null", '"response.created"', "true"]) {
			const e = event({ data });
			expect(() => resolveOpenAiSseEventName(e)).not.toThrow();
			expect(e.event).toBeNull();
		}
	});
});
