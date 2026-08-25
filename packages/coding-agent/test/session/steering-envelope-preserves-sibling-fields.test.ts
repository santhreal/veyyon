/**
 * wrapSteeringUserMessage spreads `userMessageWithoutSteering`, which is a
 * rest-object minus `steering`. Every other field on the user message
 * (id, timestamp, attribution, toolCallId leftovers, custom metadata)
 * must survive. The content-array rebuild concatenates ALL text blocks
 * through contentText (newline join, images dropped from the flatten then
 * re-appended). Two text blocks therefore become one enveloped text
 * block; images keep identity and order after that single text.
 *
 * Empty text blocks still produce a non-empty flatten if another text
 * block has characters; a content array of only empty strings is empty
 * flatten and must stay unwrapped (same as image-only).
 *
 * A non-user role with `steering: true` is not a steering user message.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { ImageContent, TextContent, UserMessage } from "@veyyon/ai";
import { wrapSteeringForModel } from "@veyyon/coding-agent/session/steering-envelope";

describe("wrapSteeringForModel keeps non-content fields and concatenates text blocks", () => {
	it("preserves id, timestamp, and attribution on the wrapped message", () => {
		const message = {
			role: "user",
			content: "stop",
			steering: true,
			id: "m-1",
			timestamp: 123,
			attribution: { source: "human" },
		} as unknown as UserMessage;

		const wrapped = wrapSteeringForModel([message])[0] as UserMessage & {
			id?: string;
			timestamp?: number;
			attribution?: { source: string };
			steering?: true;
		};
		expect(wrapped.id).toBe("m-1");
		expect(wrapped.timestamp).toBe(123);
		expect((wrapped as { attribution?: unknown }).attribution).toEqual({ source: "human" });
		expect(wrapped.steering).toBeUndefined();
		expect(typeof wrapped.content).toBe("string");
		expect(wrapped.content as string).toContain("stop");
		expect(wrapped.content as string).not.toBe("stop");
	});

	it("collapses two text blocks into one enveloped text, then appends images in original order", () => {
		const img1 = { type: "image", data: "A", mediaType: "image/png" } as unknown as ImageContent;
		const img2 = { type: "image", data: "B", mediaType: "image/jpeg" } as unknown as ImageContent;
		const message = {
			role: "user",
			content: [
				{ type: "text", text: "first" },
				img1,
				{ type: "text", text: "second" },
				img2,
			],
			steering: true,
		} as UserMessage;

		const content = (wrapSteeringForModel([message])[0] as UserMessage).content as (TextContent | ImageContent)[];
		expect(content).toHaveLength(3);
		expect(content[0]?.type).toBe("text");
		expect((content[0] as TextContent).text).toContain("first");
		expect((content[0] as TextContent).text).toContain("second");
		expect(content[1]).toBe(img1);
		expect(content[2]).toBe(img2);
	});

	it("wraps two empty text blocks because contentText joins them with a newline, which is not length 0", () => {
		const message = {
			role: "user",
			content: [{ type: "text", text: "" }, { type: "text", text: "" }],
			steering: true,
		} as UserMessage;
		const wrapped = wrapSteeringForModel([message])[0] as UserMessage;
		expect(wrapped).not.toBe(message);
		const content = wrapped.content as TextContent[];
		expect(content[0]?.type).toBe("text");
		expect(content[0]?.text).toContain("<message>");
		expect((wrapped as UserMessage & { steering?: true }).steering).toBeUndefined();
	});

	it("does not wrap an assistant message that somehow carries steering: true", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "nope" }],
			steering: true,
		} as unknown as AgentMessage;
		const messages = [message];
		expect(wrapSteeringForModel(messages)).toBe(messages);
	});

	it("does not wrap a user message whose steering is false or missing", () => {
		const a = { role: "user", content: "x", steering: false } as unknown as UserMessage;
		const b = { role: "user", content: "y" } as UserMessage;
		const messages = [a, b];
		expect(wrapSteeringForModel(messages)).toBe(messages);
	});
});
