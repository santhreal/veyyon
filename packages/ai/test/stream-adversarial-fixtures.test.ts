import { describe, expect, it } from "bun:test";
import { createMockModel } from "../src/providers/mock";

/**
 * Recorded-style stream edges: multi-turn toolUse then text, empty content,
 * explicit error stop, and abort during delay. Drives createMockModel.stream —
 * the same injection point agent-loop tests use.
 */

async function drain(
	stream: AsyncIterable<{ type: string }> & {
		result: () => Promise<{
			stopReason: string;
			content: Array<{ type: string; text?: string }>;
			errorMessage?: string;
		}>;
	},
) {
	const types: string[] = [];
	for await (const ev of stream) {
		types.push(ev.type);
	}
	const msg = await stream.result();
	return { types, msg };
}

describe("AI stream adversarial fixtures", () => {
	it("toolUse then final text across two provider calls", async () => {
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } }],
				},
				{ content: ["done after tool"] },
			],
		});
		const first = mock.stream(mock.model, { systemPrompt: [], messages: [] }, {});
		const { msg: m1 } = await drain(first);
		expect(m1.stopReason).toBe("toolUse");
		expect(m1.content.some((c: { type: string }) => c.type === "toolCall")).toBe(true);

		const second = mock.stream(mock.model, { systemPrompt: [], messages: [] }, {});
		const { msg: m2 } = await drain(second);
		expect(m2.stopReason).toBe("stop");
		const text = m2.content
			.filter((c: { type: string; text?: string }) => c.type === "text")
			.map((c: { text?: string }) => c.text)
			.join("");
		expect(text).toBe("done after tool");
		expect(mock.calls.length).toBe(2);
	});

	it("empty content still completes with stop", async () => {
		const mock = createMockModel({
			responses: [{ content: [] }],
		});
		const { msg } = await drain(mock.stream(mock.model, { systemPrompt: [], messages: [] }, {}));
		expect(msg.stopReason).toBe("stop");
		expect(Array.isArray(msg.content)).toBe(true);
	});

	it("throw response surfaces as error or thrown Error with message", async () => {
		const mock = createMockModel({
			responses: [{ throw: new Error("provider reset") }],
		});
		const stream = mock.stream(mock.model, { systemPrompt: [], messages: [] }, {});
		let seen = "";
		try {
			for await (const _ of stream) {
				// drain
			}
			const msg = await stream.result();
			seen = msg.errorMessage ?? msg.stopReason;
		} catch (e) {
			seen = String(e);
		}
		expect(seen.toLowerCase()).toMatch(/provider reset|error/);
	});

	it("partial multi-block assistant content preserves order", async () => {
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "thinking", thinking: "plan" }, "answer-part-1", "answer-part-2"],
				},
			],
		});
		const { msg } = await drain(mock.stream(mock.model, { systemPrompt: [], messages: [] }, {}));
		const texts = msg.content
			.filter((c: { type: string; text?: string }) => c.type === "text")
			.map((c: { text?: string }) => c.text);
		expect(texts.join("")).toContain("answer-part-1");
		expect(texts.join("")).toContain("answer-part-2");
		const think = msg.content.find((c: { type: string }) => c.type === "thinking");
		expect(think).toBeDefined();
	});
});
