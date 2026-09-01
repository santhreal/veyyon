import { describe, expect, it } from "bun:test";
import { openToolCallBlocks } from "../src/providers/cursor-helpers";
import type { AssistantMessage } from "../src/types";
import { type StreamingPartialJsonCarrier, setStreamingPartialJson } from "../src/utils/block-symbols";

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor-agent" as never,
		provider: "cursor",
		model: "cursor-model",
		usage: { input: 0, output: 0 } as never,
		stopReason: "stop",
		timestamp: 0,
	};
}

function makeToolCallBlock(id: string, partialJson?: string): StreamingPartialJsonCarrier & Record<string, unknown> {
	const block: StreamingPartialJsonCarrier & Record<string, unknown> = {
		type: "toolCall",
		id,
		name: "read",
		input: {},
	};
	if (partialJson !== undefined) {
		setStreamingPartialJson(block, partialJson);
	}
	return block;
}

describe("openToolCallBlocks", () => {
	it("returns empty array for message with no toolCall blocks", () => {
		const msg = makeAssistantMessage([{ type: "text", text: "hello" } as never]);
		expect(openToolCallBlocks(msg)).toEqual([]);
	});

	it("returns empty array for message with toolCall blocks but no partial json", () => {
		const msg = makeAssistantMessage([makeToolCallBlock("tc1") as never]);
		expect(openToolCallBlocks(msg)).toEqual([]);
	});

	it("returns blocks that have kStreamingPartialJson set", () => {
		const block = makeToolCallBlock("tc1", '{"path":');
		const msg = makeAssistantMessage([block as never]);
		const result = openToolCallBlocks(msg);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("tc1");
	});

	it("returns multiple open blocks", () => {
		const block1 = makeToolCallBlock("tc1", '{"a":');
		const block2 = makeToolCallBlock("tc2", '{"b":');
		const msg = makeAssistantMessage([block1 as never, block2 as never]);
		expect(openToolCallBlocks(msg)).toHaveLength(2);
	});

	it("mixes open and closed blocks correctly", () => {
		const open1 = makeToolCallBlock("tc1", '{"path":');
		const closed = makeToolCallBlock("tc2");
		const open2 = makeToolCallBlock("tc3", '{"query":');
		const msg = makeAssistantMessage([open1 as never, closed as never, open2 as never]);
		const result = openToolCallBlocks(msg);
		expect(result).toHaveLength(2);
		expect(result[0].id).toBe("tc1");
		expect(result[1].id).toBe("tc3");
	});

	it("ignores non-toolCall blocks", () => {
		const block = makeToolCallBlock("tc1", '{"path":');
		const msg = makeAssistantMessage([
			{ type: "text", text: "thinking..." } as never,
			block as never,
			{ type: "text", text: "more" } as never,
		]);
		expect(openToolCallBlocks(msg)).toHaveLength(1);
	});

	it("returns empty array for empty content", () => {
		const msg = makeAssistantMessage([]);
		expect(openToolCallBlocks(msg)).toEqual([]);
	});

	it("does not return blocks with undefined partialJson", () => {
		const block = makeToolCallBlock("tc1");
		setStreamingPartialJson(block, undefined);
		const msg = makeAssistantMessage([block as never]);
		expect(openToolCallBlocks(msg)).toEqual([]);
	});

	it("returns blocks with empty string partialJson", () => {
		const block = makeToolCallBlock("tc1", "");
		const msg = makeAssistantMessage([block as never]);
		// empty string is not undefined, so it counts as open
		expect(openToolCallBlocks(msg)).toHaveLength(1);
	});
});
