import { describe, expect, it } from "bun:test";
import { wrapInbandToolStream } from "../src/dialect/owned-stream";
import type { AssistantMessage, Usage } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

// WHY THIS SUITE EXISTS. A stream forwarder that stops at the end of its
// inner `for await` without ending its own output converts one upstream
// anomaly — a producer that ends WITHOUT a terminal done/error event — into a
// permanent, silent hang: every consumer of the outer stream parks on a queue
// that no push will ever reach, and only a caller-side abort releases it.
// That is the reported "turn hangs until Esc" signature, and EventStream's
// public API permits the trigger: end() without a terminal event is legal
// (forwardStream's non-EventStream branch in register-builtins produces one).
// The sibling wrapper wrapLeakedThinkingStream already settles this case;
// these tests pin the same contract on wrapInbandToolStream. Pre-fix, each
// test below does not fail an assertion — it hangs until the test-runner
// timeout, which is the symptom itself.

const TOOLS = [
	{
		name: "echo",
		description: "Echo a message.",
		parameters: {
			type: "object",
			properties: { msg: { type: "string" } },
			required: ["msg"],
		},
	},
];

function makeAssistant(content: AssistantMessage["content"]): AssistantMessage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("wrapInbandToolStream with an upstream that ends without a terminal event", () => {
	it("settles with the final message when the inner stream ends via end(result)", async () => {
		const inner = new AssistantMessageEventStream();
		const seed = makeAssistant([]);
		inner.push({ type: "start", partial: seed });
		inner.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial: seed });
		// The anomaly: the producer closes with a final result but never pushed
		// a done/error event. Legal per EventStream.end(); fatal to a forwarder
		// that has no post-loop settle.
		inner.end(makeAssistant([{ type: "text", text: "hello" }]));

		const wrapped = wrapInbandToolStream(inner, TOOLS, "glm");
		const message = await wrapped.result();

		const text = message.content.map(b => (b.type === "text" ? b.text : "")).join("");
		expect(text).toBe("hello");
		expect(message.stopReason).toBe("stop");
	});

	it("emits a terminal done event to iterating consumers on a terminal-less end(result)", async () => {
		const inner = new AssistantMessageEventStream();
		const seed = makeAssistant([]);
		inner.push({ type: "start", partial: seed });
		inner.push({ type: "text_delta", contentIndex: 0, delta: "hi", partial: seed });
		inner.end(makeAssistant([{ type: "text", text: "hi" }]));

		const wrapped = wrapInbandToolStream(inner, TOOLS, "glm");
		const types: string[] = [];
		for await (const event of wrapped) types.push(event.type);

		// The consumer must see the stream CLOSE, with a terminal event — not
		// sit parked on the next pull.
		expect(types[0]).toBe("start");
		expect(types.at(-1)).toBe("done");
	});

	it("fails loudly instead of hanging when the inner stream ends with no result at all", async () => {
		const inner = new AssistantMessageEventStream();
		const seed = makeAssistant([]);
		inner.push({ type: "start", partial: seed });
		inner.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: seed });
		inner.end();

		const wrapped = wrapInbandToolStream(inner, TOOLS, "glm");
		const err = await wrapped.result().then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("Stream ended without a final result");
	});

	it("still passes a normal terminal done through unchanged (no regression)", async () => {
		const inner = new AssistantMessageEventStream();
		const seed = makeAssistant([]);
		inner.push({ type: "start", partial: seed });
		inner.push({ type: "text_delta", contentIndex: 0, delta: "plain answer", partial: seed });
		const full = makeAssistant([{ type: "text", text: "plain answer" }]);
		inner.push({ type: "done", reason: "stop", message: full });
		inner.end(full);

		const wrapped = wrapInbandToolStream(inner, TOOLS, "glm");
		const message = await wrapped.result();
		const text = message.content.map(b => (b.type === "text" ? b.text : "")).join("");
		expect(text).toBe("plain answer");
		expect(message.stopReason).toBe("stop");
	});
});
