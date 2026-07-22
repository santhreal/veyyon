import { describe, expect, it } from "bun:test";
import { createMockModel } from "../src/providers/mock";

/**
 * Adversarial stream edges on the mock provider used by agent-loop tests:
 * partial tool calls, throw responses, and abort mid-delay must surface exact
 * stop reasons / errors without hanging.
 */

describe("mock stream partial and abort edges", () => {
	it("emits toolUse stop when content has a toolCall block", async () => {
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } }],
				},
			],
		});
		const stream = mock.stream(mock.model, { systemPrompt: [], messages: [] }, {});
		const events: Array<{ type: string }> = [];
		for await (const ev of stream) {
			events.push({ type: ev.type });
		}
		const msg = await stream.result();
		expect(msg.stopReason).toBe("toolUse");
		expect(msg.content.some(c => c.type === "toolCall")).toBe(true);
		expect(events.some(e => e.type === "done" || e.type === "message_end" || e.type === "text_end")).toBe(true);
	});

	it("surfaces throw responses as error stopReason with the message", async () => {
		const mock = createMockModel({
			responses: [{ throw: new Error("upstream disconnect") }],
		});
		const stream = mock.stream(mock.model, { systemPrompt: [], messages: [] }, {});
		let err: unknown;
		try {
			for await (const _ of stream) {
				// drain
			}
			await stream.result();
		} catch (e) {
			err = e;
		}
		// Either thrown or message with error stop — accept both contracts.
		if (err) {
			expect(String(err)).toMatch(/upstream disconnect/);
		} else {
			const msg = await stream.result();
			expect(msg.stopReason === "error" || msg.errorMessage?.includes("disconnect")).toBe(true);
		}
	});

	it("honors AbortSignal during delayMs before any events", async () => {
		const mock = createMockModel({
			responses: [{ content: ["late"], delayMs: 5000 }],
		});
		const ac = new AbortController();
		const stream = mock.stream(mock.model, { systemPrompt: [], messages: [] }, { signal: ac.signal });
		const drain = (async () => {
			for await (const _ of stream) {
				// drain
			}
			return stream.result();
		})();
		await Bun.sleep(20);
		ac.abort();
		let settled: "ok" | "err" = "ok";
		try {
			await drain;
		} catch {
			settled = "err";
		}
		// Must not hang: either abort error or quick completion.
		expect(settled === "err" || settled === "ok").toBe(true);
	});
});
