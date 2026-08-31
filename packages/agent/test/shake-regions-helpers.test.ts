import { describe, expect, it } from "bun:test";
import type { ToolResultMessage } from "@veyyon/ai";
import type { SessionMessageEntry } from "../src/compaction/entries";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	applyShakeRegion,
	applyShakeRegions,
	DEFAULT_SHAKE_CONFIG,
} from "../src/compaction/shake";

function makeToolResultEntry(text: string, toolCallId = "tc1"): SessionMessageEntry {
	return {
		type: "message",
		id: "e1",
		parentId: null,
		timestamp: "0",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 0,
		} as ToolResultMessage,
	};
}

describe("DEFAULT_SHAKE_CONFIG", () => {
	it("has protectTokens of 16000", () => {
		expect(DEFAULT_SHAKE_CONFIG.protectTokens).toBe(16_000);
	});

	it("has minSavings of 4000", () => {
		expect(DEFAULT_SHAKE_CONFIG.minSavings).toBe(4_000);
	});

	it("has fenceMinTokens of 400", () => {
		expect(DEFAULT_SHAKE_CONFIG.fenceMinTokens).toBe(400);
	});

	it("has protectedTools array", () => {
		expect(Array.isArray(DEFAULT_SHAKE_CONFIG.protectedTools)).toBe(true);
		expect(DEFAULT_SHAKE_CONFIG.protectedTools.length).toBeGreaterThan(0);
	});
});

describe("AGGRESSIVE_SHAKE_CONFIG", () => {
	it("has protectTokens of 0", () => {
		expect(AGGRESSIVE_SHAKE_CONFIG.protectTokens).toBe(0);
	});

	it("has minSavings of 0", () => {
		expect(AGGRESSIVE_SHAKE_CONFIG.minSavings).toBe(0);
	});

	it("has fenceMinTokens of 400", () => {
		expect(AGGRESSIVE_SHAKE_CONFIG.fenceMinTokens).toBe(400);
	});
});

describe("applyShakeRegion (toolResult)", () => {
	it("replaces tool result content with replacement text", () => {
		const entry = makeToolResultEntry("original content here");
		const region = {
			kind: "toolResult" as const,
			entry,
			tokens: 100,
			originalText: "original content here",
			label: "read",
		};
		applyShakeRegion(region, "[pruned]");
		const msg = entry.message as ToolResultMessage;
		expect(msg.content).toEqual([{ type: "text", text: "[pruned]" }]);
	});

	it("sets prunedAt timestamp", () => {
		const entry = makeToolResultEntry("original");
		const region = {
			kind: "toolResult" as const,
			entry,
			tokens: 50,
			originalText: "original",
			label: "read",
		};
		const before = Date.now();
		applyShakeRegion(region, "[pruned]");
		const after = Date.now();
		const msg = entry.message as ToolResultMessage;
		expect(msg.prunedAt).toBeGreaterThanOrEqual(before);
		expect(msg.prunedAt).toBeLessThanOrEqual(after);
	});

	it("replaces multi-block content with single text block", () => {
		const entry = makeToolResultEntry("first");
		(entry.message as ToolResultMessage).content = [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		];
		const region = {
			kind: "toolResult" as const,
			entry,
			tokens: 100,
			originalText: "first\nsecond",
			label: "read",
		};
		applyShakeRegion(region, "replaced");
		const msg = entry.message as ToolResultMessage;
		expect(msg.content).toEqual([{ type: "text", text: "replaced" }]);
	});
});

describe("applyShakeRegions", () => {
	it("applies multiple regions in one call", () => {
		const entry1 = makeToolResultEntry("content1", "tc1");
		const entry2 = makeToolResultEntry("content2", "tc2");
		const regions = [
			{
				region: {
					kind: "toolResult" as const,
					entry: entry1,
					tokens: 50,
					originalText: "content1",
					label: "read",
				},
				replacement: "[pruned1]",
			},
			{
				region: {
					kind: "toolResult" as const,
					entry: entry2,
					tokens: 60,
					originalText: "content2",
					label: "write",
				},
				replacement: "[pruned2]",
			},
		];
		applyShakeRegions(regions);
		expect((entry1.message as ToolResultMessage).content).toEqual([{ type: "text", text: "[pruned1]" }]);
		expect((entry2.message as ToolResultMessage).content).toEqual([{ type: "text", text: "[pruned2]" }]);
	});

	it("handles empty array", () => {
		expect(() => applyShakeRegions([])).not.toThrow();
	});

	it("handles single region", () => {
		const entry = makeToolResultEntry("original");
		applyShakeRegions([
			{
				region: {
					kind: "toolResult" as const,
					entry,
					tokens: 50,
					originalText: "original",
					label: "read",
				},
				replacement: "done",
			},
		]);
		expect((entry.message as ToolResultMessage).content).toEqual([{ type: "text", text: "done" }]);
	});
});
