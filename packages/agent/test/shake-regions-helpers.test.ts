import { describe, expect, it } from "bun:test";
import type { TextContent, ToolResultMessage } from "@veyyon/ai";
import type { SessionEntry, SessionMessageEntry } from "../src/compaction/entries";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	applyShakeRegion,
	applyShakeRegions,
	collectRedundantToolResultRegions,
	collectShakeRegions,
	DEFAULT_SHAKE_CONFIG,
	type ShakeRegion,
} from "../src/compaction/shake";
import type { AgentMessage } from "../src/types";

function makeEntryBase(id: string) {
	return { id, parentId: null, timestamp: "2024-01-01T00:00:00Z" };
}

function makeToolResultEntry(
	id: string,
	toolCallId: string,
	toolName: string,
	text: string,
	extras: Partial<ToolResultMessage> = {},
): SessionMessageEntry {
	return {
		...makeEntryBase(id),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			...extras,
		} as AgentMessage,
	};
}

function makeAssistantEntry(id: string, toolCalls: Array<{ id: string; name: string }>): SessionMessageEntry {
	return {
		...makeEntryBase(id),
		type: "message",
		message: {
			role: "assistant",
			content: toolCalls.map(tc => ({
				type: "toolCall",
				id: tc.id,
				name: tc.name,
				arguments: {},
			})),
			stopReason: "tool_use",
		} as unknown as AgentMessage,
	};
}
function makeUserEntry(id: string, text: string): SessionMessageEntry {
	return {
		...makeEntryBase(id),
		type: "message",
		message: {
			role: "user",
			content: [{ type: "text", text }],
		} as unknown as AgentMessage,
	};
}

describe("DEFAULT_SHAKE_CONFIG", () => {
	it("has protectTokens 16000", () => {
		expect(DEFAULT_SHAKE_CONFIG.protectTokens).toBe(16_000);
	});
	it("has minSavings 4000", () => {
		expect(DEFAULT_SHAKE_CONFIG.minSavings).toBe(4_000);
	});
	it("has fenceMinTokens 400", () => {
		expect(DEFAULT_SHAKE_CONFIG.fenceMinTokens).toBe(400);
	});
	it("has protectedTools with skill and skill read matcher", () => {
		expect(DEFAULT_SHAKE_CONFIG.protectedTools).toHaveLength(2);
	});
});

describe("AGGRESSIVE_SHAKE_CONFIG", () => {
	it("has protectTokens 0", () => {
		expect(AGGRESSIVE_SHAKE_CONFIG.protectTokens).toBe(0);
	});
	it("has minSavings 0", () => {
		expect(AGGRESSIVE_SHAKE_CONFIG.minSavings).toBe(0);
	});
	it("has fenceMinTokens 400", () => {
		expect(AGGRESSIVE_SHAKE_CONFIG.fenceMinTokens).toBe(400);
	});
});

describe("collectShakeRegions", () => {
	it("returns empty for empty entries", () => {
		expect(collectShakeRegions([], DEFAULT_SHAKE_CONFIG)).toEqual([]);
	});
	it("returns empty for entries with only short text", () => {
		const entries: SessionEntry[] = [makeUserEntry("e1", "hello")];
		expect(collectShakeRegions(entries, DEFAULT_SHAKE_CONFIG)).toEqual([]);
	});
	it("detects fenced code blocks as regions", () => {
		const longCode = "x".repeat(2000);
		const text = `Here is code:\n\`\`\`\n${longCode}\n\`\`\`\nDone.`;
		const entries: SessionEntry[] = [makeUserEntry("e1", text)];
		const regions = collectShakeRegions(entries, AGGRESSIVE_SHAKE_CONFIG);
		expect(regions.length).toBeGreaterThan(0);
		expect(regions[0].kind).toBe("block");
	});
	it("detects XML blocks as regions", () => {
		const longContent = "x".repeat(2000);
		const text = `<item>\n${longContent}\n</item>`;
		const entries: SessionEntry[] = [makeUserEntry("e1", text)];
		const regions = collectShakeRegions(entries, AGGRESSIVE_SHAKE_CONFIG);
		expect(regions.length).toBeGreaterThan(0);
	});
});

describe("collectRedundantToolResultRegions", () => {
	it("returns empty for empty entries", () => {
		expect(collectRedundantToolResultRegions([], DEFAULT_SHAKE_CONFIG)).toEqual([]);
	});
	it("returns empty when no tool results", () => {
		const entries: SessionEntry[] = [makeUserEntry("e1", "hello")];
		expect(collectRedundantToolResultRegions(entries, DEFAULT_SHAKE_CONFIG)).toEqual([]);
	});
	it("returns empty for single tool result (no redundancy)", () => {
		const entries: SessionEntry[] = [
			makeAssistantEntry("a1", [{ id: "c1", name: "read" }]),
			makeToolResultEntry("t1", "c1", "read", "output"),
		];
		expect(collectRedundantToolResultRegions(entries, AGGRESSIVE_SHAKE_CONFIG)).toEqual([]);
	});
	it("detects duplicate tool results", () => {
		const entries: SessionEntry[] = [
			makeAssistantEntry("a1", [{ id: "c1", name: "read" }]),
			makeToolResultEntry("t1", "c1", "read", "same output"),
			makeAssistantEntry("a2", [{ id: "c2", name: "read" }]),
			makeToolResultEntry("t2", "c2", "read", "same output"),
		];
		const regions = collectRedundantToolResultRegions(entries, AGGRESSIVE_SHAKE_CONFIG);
		expect(regions).toHaveLength(1);
		expect(regions[0].kind).toBe("toolResult");
	});
	it("keeps the latest duplicate and marks earlier ones", () => {
		const entries: SessionEntry[] = [
			makeAssistantEntry("a1", [{ id: "c1", name: "read" }]),
			makeToolResultEntry("t1", "c1", "read", "same output"),
			makeAssistantEntry("a2", [{ id: "c2", name: "read" }]),
			makeToolResultEntry("t2", "c2", "read", "same output"),
		];
		const regions = collectRedundantToolResultRegions(entries, AGGRESSIVE_SHAKE_CONFIG);
		expect(regions[0].kind).toBe("toolResult");
		const region = regions[0] as Extract<ShakeRegion, { kind: "toolResult" }>;
		expect(region.entry.id).toBe("t1");
	});
	it("skips error tool results", () => {
		const entries: SessionEntry[] = [
			makeAssistantEntry("a1", [{ id: "c1", name: "read" }]),
			makeToolResultEntry("t1", "c1", "read", "output", { isError: true }),
			makeAssistantEntry("a2", [{ id: "c2", name: "read" }]),
			makeToolResultEntry("t2", "c2", "read", "output", { isError: true }),
		];
		expect(collectRedundantToolResultRegions(entries, AGGRESSIVE_SHAKE_CONFIG)).toEqual([]);
	});
	it("skips already pruned tool results", () => {
		const entries: SessionEntry[] = [
			makeAssistantEntry("a1", [{ id: "c1", name: "read" }]),
			makeToolResultEntry("t1", "c1", "read", "output", { prunedAt: 1000 }),
			makeAssistantEntry("a2", [{ id: "c2", name: "read" }]),
			makeToolResultEntry("t2", "c2", "read", "output"),
		];
		expect(collectRedundantToolResultRegions(entries, AGGRESSIVE_SHAKE_CONFIG)).toEqual([]);
	});
	it("skips empty text tool results", () => {
		const entries: SessionEntry[] = [
			makeAssistantEntry("a1", [{ id: "c1", name: "read" }]),
			makeToolResultEntry("t1", "c1", "read", ""),
			makeAssistantEntry("a2", [{ id: "c2", name: "read" }]),
			makeToolResultEntry("t2", "c2", "read", ""),
		];
		expect(collectRedundantToolResultRegions(entries, AGGRESSIVE_SHAKE_CONFIG)).toEqual([]);
	});
	it("does not detect redundancy for different tool names", () => {
		const entries: SessionEntry[] = [
			makeAssistantEntry("a1", [{ id: "c1", name: "read" }]),
			makeToolResultEntry("t1", "c1", "read", "output"),
			makeAssistantEntry("a2", [{ id: "c2", name: "write" }]),
			makeToolResultEntry("t2", "c2", "write", "output"),
		];
		expect(collectRedundantToolResultRegions(entries, AGGRESSIVE_SHAKE_CONFIG)).toEqual([]);
	});
	it("detects three duplicates producing two regions", () => {
		const entries: SessionEntry[] = [
			makeAssistantEntry("a1", [{ id: "c1", name: "read" }]),
			makeToolResultEntry("t1", "c1", "read", "same"),
			makeAssistantEntry("a2", [{ id: "c2", name: "read" }]),
			makeToolResultEntry("t2", "c2", "read", "same"),
			makeAssistantEntry("a3", [{ id: "c3", name: "read" }]),
			makeToolResultEntry("t3", "c3", "read", "same"),
		];
		const regions = collectRedundantToolResultRegions(entries, AGGRESSIVE_SHAKE_CONFIG);
		expect(regions).toHaveLength(2);
	});
});

describe("applyShakeRegion", () => {
	it("replaces tool result content and sets prunedAt", () => {
		const entry = makeToolResultEntry("t1", "c1", "read", "original output text");
		const region: ShakeRegion = {
			kind: "toolResult",
			entry,
			tokens: 100,
			originalText: "original output text",
			label: "read",
		};
		applyShakeRegion(region, "[pruned]");
		const message = entry.message as ToolResultMessage;
		const textBlock = message.content[0] as TextContent;
		expect(textBlock.text).toBe("[pruned]");
		expect(message.prunedAt).toBeDefined();
	});
	it("replaces block text within a region", () => {
		const entry = makeUserEntry("e1", "before<prune>content</prune>after");
		const region: ShakeRegion = {
			kind: "block",
			entry,
			blockIndex: 0,
			start: 6,
			end: 28,
			tokens: 50,
			originalText: "<prune>content</prune>",
			label: "user",
		};
		applyShakeRegion(region, "[pruned]");
		const message = entry.message as { content: TextContent[] };
		expect(message.content[0].text).toBe("before[pruned]after");
	});
	it("does nothing for invalid block slot", () => {
		const entry = makeUserEntry("e1", "hello");
		const region: ShakeRegion = {
			kind: "block",
			entry,
			blockIndex: 99,
			start: 0,
			end: 3,
			tokens: 10,
			originalText: "hel",
			label: "user",
		};
		applyShakeRegion(region, "[pruned]");
		const message = entry.message as { content: TextContent[] };
		expect(message.content[0].text).toBe("hello");
	});
});

describe("applyShakeRegions", () => {
	it("applies multiple regions in reverse order", () => {
		const entry = makeUserEntry("e1", "AAAAABBBBBCCCCC");
		const items = [
			{
				region: {
					kind: "block" as const,
					entry,
					blockIndex: 0,
					start: 0,
					end: 5,
					tokens: 10,
					originalText: "AAAAA",
					label: "user",
				},
				replacement: "[A]",
			},
			{
				region: {
					kind: "block" as const,
					entry,
					blockIndex: 0,
					start: 5,
					end: 10,
					tokens: 10,
					originalText: "BBBBB",
					label: "user",
				},
				replacement: "[B]",
			},
		];
		applyShakeRegions(items);
		const message = entry.message as { content: TextContent[] };
		expect(message.content[0].text).toBe("[A][B]CCCCC");
	});
	it("handles empty items", () => {
		expect(() => applyShakeRegions([])).not.toThrow();
	});
	it("handles mixed toolResult and block regions", () => {
		const toolEntry = makeToolResultEntry("t1", "c1", "read", "output");
		const userEntry = makeUserEntry("u1", "text to prune");
		const items = [
			{
				region: {
					kind: "toolResult" as const,
					entry: toolEntry,
					tokens: 100,
					originalText: "output",
					label: "read",
				},
				replacement: "[tool pruned]",
			},
			{
				region: {
					kind: "block" as const,
					entry: userEntry,
					blockIndex: 0,
					start: 0,
					end: 4,
					tokens: 10,
					originalText: "text",
					label: "user",
				},
				replacement: "[X]",
			},
		];
		applyShakeRegions(items);
		const toolMessage = toolEntry.message as ToolResultMessage;
		expect((toolMessage.content[0] as TextContent).text).toBe("[tool pruned]");
		const userMessage = userEntry.message as { content: TextContent[] };
		expect(userMessage.content[0].text).toBe("[X] to prune");
	});
});
