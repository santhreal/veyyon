import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry, ShakeConfig } from "@veyyon/agent-core/compaction";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	applyShakeRegion,
	applyShakeRegions,
	collectRedundantToolResultRegions,
	collectShakeRegions,
	DEFAULT_SHAKE_CONFIG,
	estimateTokens,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage } from "@veyyon/ai";

let idCounter = 0;
function nextId(): string {
	return `entry-${idCounter++}`;
}

function messageEntry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: nextId(), parentId: null, timestamp: new Date().toISOString(), message };
}

function toolResultMessage(toolName: string, text: string, extra?: Partial<ToolResultMessage>): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${idCounter++}`,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
		...extra,
	};
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

/** Repeat a representative code line enough to clear ~`approxTokens` tokens. */
function fencedBlock(approxTokens: number, lang = "ts"): string {
	const line = "const value = computeSomething(alpha, beta, gamma, delta, epsilon);";
	const count = Math.ceil((approxTokens * 4) / line.length);
	return `\`\`\`${lang}\n${Array(count).fill(line).join("\n")}\n\`\`\``;
}

function xmlBlock(approxTokens: number, tag = "example"): string {
	const line = "  payload row with identifiers alpha beta gamma delta epsilon zeta;";
	const count = Math.ceil((approxTokens * 4) / line.length);
	return `<${tag}>\n${Array(count).fill(line).join("\n")}\n</${tag}>`;
}

function cfg(over: Partial<ShakeConfig> = {}): ShakeConfig {
	return { protectTokens: 0, minSavings: 0, protectedTools: [], fenceMinTokens: 50, ...over };
}

describe("collectShakeRegions — tool results", () => {
	test("collects unprotected tool results and applyShakeRegion sets prunedAt", () => {
		const tr = toolResultMessage("bash", "x".repeat(400));
		const entry = messageEntry(tr);
		const regions = collectShakeRegions([entry], cfg());

		expect(regions).toHaveLength(1);
		const region = regions[0];
		expect(region.kind).toBe("toolResult");
		expect(region.tokens).toBeGreaterThan(0);

		applyShakeRegion(region, "[shaken]");
		expect(tr.prunedAt).toBeGreaterThan(0);
		expect(tr.content).toEqual([{ type: "text", text: "[shaken]" }]);
	});

	test("never collects protected tools", () => {
		const entry = messageEntry(toolResultMessage("skill", "y".repeat(800)));
		const regions = collectShakeRegions([entry], cfg({ protectedTools: ["skill"] }));
		expect(regions).toHaveLength(0);
	});

	test("never collects already-pruned tool results", () => {
		const entry = messageEntry(toolResultMessage("bash", "z".repeat(800), { prunedAt: Date.now() }));
		const regions = collectShakeRegions([entry], cfg());
		expect(regions).toHaveLength(0);
	});

	test("honors the protect-recent token window", () => {
		const text = "word ".repeat(160); // ~ deterministic token block
		const older = messageEntry(toolResultMessage("bash", text));
		const middle = messageEntry(toolResultMessage("bash", text));
		const recent = messageEntry(toolResultMessage("bash", text));
		const perEntry = estimateTokens(older.message);
		// Window covers the most recent ~1.5 entries → middle & recent protected, older eligible.
		const regions = collectShakeRegions([older, middle, recent], cfg({ protectTokens: Math.floor(perEntry * 1.5) }));

		expect(regions).toHaveLength(1);
		expect(regions[0].entry).toBe(older);
	});

	test("minSavings gates the whole batch", () => {
		const entry = messageEntry(toolResultMessage("bash", "q".repeat(800)));
		const tokens = estimateTokens(entry.message);
		expect(collectShakeRegions([entry], cfg({ minSavings: tokens * 10 }))).toHaveLength(0);
		expect(collectShakeRegions([entry], cfg({ minSavings: 0 }))).toHaveLength(1);
	});
});

describe("collectShakeRegions — fenced / XML blocks", () => {
	test("detects a large fenced block and applyShakeRegion splices it out", () => {
		const fence = fencedBlock(120);
		const text = `intro line\n${fence}\noutro line`;
		const entry = messageEntry(assistantMessage([{ type: "text", text }]));
		const regions = collectShakeRegions([entry], cfg());

		expect(regions).toHaveLength(1);
		const region = regions[0];
		expect(region.kind).toBe("block");
		if (region.kind !== "block") throw new Error("expected block region");
		expect(text.slice(region.start, region.end)).toBe(fence);

		applyShakeRegion(region, "[shaken]");
		const block = (entry.message as AssistantMessage).content[0] as TextContent;
		expect(block.text).toBe("intro line\n[shaken]\noutro line");
	});

	test("ignores fenced blocks below fenceMinTokens", () => {
		const text = "intro\n```ts\nconst a = 1;\n```\noutro";
		const entry = messageEntry(assistantMessage([{ type: "text", text }]));
		expect(collectShakeRegions([entry], cfg({ fenceMinTokens: 400 }))).toHaveLength(0);
	});

	test("detects a top-level XML block", () => {
		const xml = xmlBlock(120);
		const text = `before\n${xml}\nafter`;
		const entry = messageEntry(assistantMessage([{ type: "text", text }]));
		const regions = collectShakeRegions([entry], cfg());

		expect(regions).toHaveLength(1);
		const region = regions[0];
		if (region.kind !== "block") throw new Error("expected block region");
		expect(text.slice(region.start, region.end)).toBe(xml);
	});

	test("never targets toolCall blocks and points blockIndex at the text block", () => {
		const fence = fencedBlock(120);
		const toolCall: ToolCall = { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "x" } };
		const entry = messageEntry(
			assistantMessage([{ type: "text", text: "tiny" }, toolCall, { type: "text", text: `pre\n${fence}\npost` }]),
		);
		const regions = collectShakeRegions([entry], cfg());

		expect(regions).toHaveLength(1);
		const region = regions[0];
		if (region.kind !== "block") throw new Error("expected block region");
		expect(region.blockIndex).toBe(2);
	});

	test("does not cross message boundaries — each large block stays in its own entry", () => {
		const a = messageEntry(assistantMessage([{ type: "text", text: `a\n${fencedBlock(120)}\na` }]));
		const b = messageEntry(assistantMessage([{ type: "text", text: `b\n${fencedBlock(120, "py")}\nb` }]));
		const regions = collectShakeRegions([a, b], cfg());

		expect(regions).toHaveLength(2);
		expect(regions[0].entry).toBe(a);
		expect(regions[1].entry).toBe(b);
	});

	test("ignores unterminated fences (conservative)", () => {
		const text = `intro\n\`\`\`ts\n${"const a = 1;\n".repeat(60)}`; // never closes
		const entry = messageEntry(assistantMessage([{ type: "text", text }]));
		expect(collectShakeRegions([entry], cfg())).toHaveLength(0);
	});
});

describe("applyShakeRegions — multi-region ordering", () => {
	test("splices two blocks in one text block correctly (highest-start-first)", () => {
		const first = fencedBlock(80);
		const second = fencedBlock(80, "py");
		const text = `head\n${first}\nmiddle\n${second}\ntail`;
		const entry = messageEntry(assistantMessage([{ type: "text", text }]));
		const regions = collectShakeRegions([entry], cfg());
		expect(regions).toHaveLength(2);

		applyShakeRegions([
			{ region: regions[0], replacement: "[A]" },
			{ region: regions[1], replacement: "[B]" },
		]);
		const block = (entry.message as AssistantMessage).content[0] as TextContent;
		expect(block.text).toBe("head\n[A]\nmiddle\n[B]\ntail");
	});
});

describe("shake config presets", () => {
	test("aggressive preset protects skill and drops everything else", () => {
		expect(AGGRESSIVE_SHAKE_CONFIG.protectTokens).toBe(0);
		expect(AGGRESSIVE_SHAKE_CONFIG.minSavings).toBe(0);
		expect(AGGRESSIVE_SHAKE_CONFIG.protectedTools).toContain("skill");
	});

	test("default preset keeps a protect window", () => {
		expect(DEFAULT_SHAKE_CONFIG.protectTokens).toBeGreaterThan(0);
		expect(DEFAULT_SHAKE_CONFIG.protectedTools).toContain("skill");
	});

	test("empty branch yields no regions", () => {
		expect(collectShakeRegions([] as SessionEntry[], AGGRESSIVE_SHAKE_CONFIG)).toHaveLength(0);
	});
});

describe("collectShakeRegions — useless results", () => {
	test("useless tool result inside the protect window yields a region; identical plain result does not", () => {
		const text = "No matches found in any scanned file.\n".repeat(20);
		const flagged = messageEntry(toolResultMessage("search", text, { useless: true }));
		const plain = messageEntry(toolResultMessage("search", text));
		// Window far larger than the whole branch: only the flagged result bypasses it.
		const regions = collectShakeRegions([flagged, plain], cfg({ protectTokens: 1_000_000 }));
		expect(regions).toHaveLength(1);
		expect(regions[0].entry).toBe(flagged);
	});

	test("an error result never bypasses the window even when flagged", () => {
		const entry = messageEntry(toolResultMessage("search", "boom\n".repeat(50), { useless: true, isError: true }));
		expect(collectShakeRegions([entry], cfg({ protectTokens: 1_000_000 }))).toHaveLength(0);
	});
});

function customMessageEntry(customType: string, content: CustomMessageEntry["content"]): CustomMessageEntry {
	return {
		type: "custom_message",
		id: nextId(),
		parentId: null,
		timestamp: new Date().toISOString(),
		customType,
		content,
		display: true,
	};
}

describe("collectShakeRegions — user / developer / custom_message blocks", () => {
	test("collects a block from string-form user content and splices it in place", () => {
		const entry = messageEntry({ role: "user", content: `intro\n${fencedBlock(120)}\ntrailer`, timestamp: 0 });

		const regions = collectShakeRegions([entry], cfg());
		expect(regions).toHaveLength(1);
		const [region] = regions;
		expect(region.kind).toBe("block");
		if (region.kind !== "block") throw new Error("expected a block region");
		expect(region.blockIndex).toBe(-1);
		expect(region.label).toBe("user");

		applyShakeRegion(region, "[shaken]");
		expect((entry.message as { content: string }).content).toBe("intro\n[shaken]\ntrailer");
	});

	test("collects a block from array-form developer content and points blockIndex at the text block", () => {
		const entry = messageEntry({
			role: "developer",
			content: [{ type: "text", text: fencedBlock(120) }],
			timestamp: 0,
		});

		const regions = collectShakeRegions([entry], cfg());
		expect(regions).toHaveLength(1);
		const [region] = regions;
		if (region.kind !== "block") throw new Error("expected a block region");
		expect(region.blockIndex).toBe(0);
		expect(region.label).toBe("developer");
	});

	test("collects and splices a block inside a string-form custom_message", () => {
		const entry = customMessageEntry("plan", `note\n${fencedBlock(120)}\nend`);

		const regions = collectShakeRegions([entry], cfg());
		expect(regions).toHaveLength(1);
		const [region] = regions;
		if (region.kind !== "block") throw new Error("expected a block region");
		expect(region.blockIndex).toBe(-1);
		expect(region.label).toBe("plan");

		applyShakeRegion(region, "[shaken]");
		expect(entry.content).toBe("note\n[shaken]\nend");
	});

	test("collects and splices a block inside array-form custom_message content", () => {
		const entry = customMessageEntry("plan", [{ type: "text", text: fencedBlock(120) }]);

		const regions = collectShakeRegions([entry], cfg());
		expect(regions).toHaveLength(1);
		const [region] = regions;
		if (region.kind !== "block") throw new Error("expected a block region");
		expect(region.blockIndex).toBe(0);

		applyShakeRegion(region, "[shaken]");
		const block = (entry.content as TextContent[])[0];
		expect(block.text).toBe("[shaken]");
	});
});

describe("collectShakeRegions — compaction boundary", () => {
	test("skips entries before keepBoundaryId and shakes only from the boundary onward", () => {
		// A non-message/non-custom entry still flows through the token accounting
		// (entryTokens returns 0 for it) without ever producing a region.
		const other: SessionEntry = {
			type: "model_change",
			id: nextId(),
			parentId: null,
			timestamp: new Date().toISOString(),
			model: "mock/mock-model",
		};
		const before = messageEntry(toolResultMessage("read", "BEFORE_BOUNDARY_PAYLOAD\n".repeat(40)));
		const boundary = messageEntry({ role: "user", content: "resume here", timestamp: 0 });
		const after = messageEntry(toolResultMessage("read", "AFTER_BOUNDARY_PAYLOAD\n".repeat(40)));

		// Sanity: with no boundary both tool results are eligible.
		expect(collectShakeRegions([other, before, boundary, after], cfg())).toHaveLength(2);

		const regions = collectShakeRegions([other, before, boundary, after], cfg({ keepBoundaryId: boundary.id }));
		expect(regions).toHaveLength(1);
		const [region] = regions;
		expect(region.entry).toBe(after);
		expect(region.originalText).toContain("AFTER_BOUNDARY_PAYLOAD");
		expect(region.originalText).not.toContain("BEFORE_BOUNDARY_PAYLOAD");
	});
});

describe("collectRedundantToolResultRegions — identical re-reads / re-runs", () => {
	/** Build a paired assistant tool-call + its tool-result so the call's arguments are visible to the dedup signature. */
	function callPair(
		toolName: string,
		args: Record<string, unknown>,
		output: string,
		extra?: Partial<ToolResultMessage>,
	): { assistant: SessionMessageEntry; result: SessionMessageEntry; toolResult: ToolResultMessage } {
		const id = `tc-${idCounter++}`;
		const toolCall: ToolCall = { type: "toolCall", id, name: toolName, arguments: args };
		const assistant = messageEntry(assistantMessage([toolCall]));
		const toolResult = toolResultMessage(toolName, output, { toolCallId: id, ...extra });
		return { assistant, result: messageEntry(toolResult), toolResult };
	}

	test("elides every earlier byte-identical result and keeps the newest copy", () => {
		const body = "FILE_CONTENT_LINE\n".repeat(40);
		const first = callPair("read", { path: "a.ts" }, body);
		const second = callPair("read", { path: "a.ts" }, body);
		const entries = [first.assistant, first.result, second.assistant, second.result];

		const regions = collectRedundantToolResultRegions(entries, cfg());
		expect(regions).toHaveLength(1);
		expect(regions[0].entry).toBe(first.result);
		expect(regions[0].originalText).toBe(body);

		// Applying the region prunes the earlier copy; the newest copy is untouched.
		applyShakeRegion(regions[0], "[deduped]");
		expect(first.toolResult.prunedAt).toBeGreaterThan(0);
		expect(first.toolResult.content).toEqual([{ type: "text", text: "[deduped]" }]);
		expect(second.toolResult.prunedAt).toBeUndefined();
		expect(second.toolResult.content).toEqual([{ type: "text", text: body }]);
	});

	test("with three identical runs, both older copies are elided and the last survives", () => {
		const out = "PASS 128 tests\n".repeat(30);
		const runs = [
			callPair("bash", { command: "cargo test" }, out),
			callPair("bash", { command: "cargo test" }, out),
			callPair("bash", { command: "cargo test" }, out),
		];
		const entries = runs.flatMap(r => [r.assistant, r.result]);

		const regions = collectRedundantToolResultRegions(entries, cfg());
		expect(regions).toHaveLength(2);
		expect(regions.map(r => r.entry)).toEqual([runs[0].result, runs[1].result]);
	});

	test("does not dedup when the output differs (same command, changed result)", () => {
		const before = callPair("bash", { command: "cargo test" }, "FAIL 3 tests\n".repeat(30));
		const after = callPair("bash", { command: "cargo test" }, "PASS 128 tests\n".repeat(30));
		const entries = [before.assistant, before.result, after.assistant, after.result];
		expect(collectRedundantToolResultRegions(entries, cfg())).toHaveLength(0);
	});

	test("does not dedup when the arguments differ even if the output is identical", () => {
		const out = "ok\n".repeat(30);
		const a = callPair("bash", { command: "touch a" }, out);
		const b = callPair("bash", { command: "touch b" }, out);
		const entries = [a.assistant, a.result, b.assistant, b.result];
		expect(collectRedundantToolResultRegions(entries, cfg())).toHaveLength(0);
	});

	test("dedups bare (unpaired) identical results by tool name and output alone", () => {
		const body = "grep hit line\n".repeat(40);
		const first = messageEntry(toolResultMessage("grep", body));
		const second = messageEntry(toolResultMessage("grep", body));
		const regions = collectRedundantToolResultRegions([first, second], cfg());
		expect(regions).toHaveLength(1);
		expect(regions[0].entry).toBe(first);
	});

	test("ignores the protect-recent window and the savings gate (a duplicate is always eligible)", () => {
		// collectShakeRegions would protect both recent copies and gate on minSavings;
		// dedup elides the older copy regardless because it carries no unique info.
		const body = "SMALL\n".repeat(4);
		const first = messageEntry(toolResultMessage("read", body));
		const second = messageEntry(toolResultMessage("read", body));
		const entries = [first, second];
		expect(collectShakeRegions(entries, cfg({ protectTokens: 1_000_000, minSavings: 1_000_000 }))).toHaveLength(0);
		const regions = collectRedundantToolResultRegions(
			entries,
			cfg({ protectTokens: 1_000_000, minSavings: 1_000_000 }),
		);
		expect(regions).toHaveLength(1);
		expect(regions[0].entry).toBe(first);
	});

	test("never dedups protected tools, error results, pruned results, or empty results", () => {
		const skillA = messageEntry(toolResultMessage("skill", "SKILL_BODY\n".repeat(20)));
		const skillB = messageEntry(toolResultMessage("skill", "SKILL_BODY\n".repeat(20)));
		expect(collectRedundantToolResultRegions([skillA, skillB], cfg({ protectedTools: ["skill"] }))).toHaveLength(0);

		const errA = messageEntry(toolResultMessage("bash", "boom\n".repeat(20), { isError: true }));
		const errB = messageEntry(toolResultMessage("bash", "boom\n".repeat(20), { isError: true }));
		expect(collectRedundantToolResultRegions([errA, errB], cfg())).toHaveLength(0);

		const prunedA = messageEntry(toolResultMessage("bash", "old\n".repeat(20), { prunedAt: Date.now() }));
		const liveB = messageEntry(toolResultMessage("bash", "old\n".repeat(20)));
		// Only the live copy exists as a signature; nothing older to elide.
		expect(collectRedundantToolResultRegions([prunedA, liveB], cfg())).toHaveLength(0);

		const emptyA = messageEntry(toolResultMessage("bash", ""));
		const emptyB = messageEntry(toolResultMessage("bash", ""));
		expect(collectRedundantToolResultRegions([emptyA, emptyB], cfg())).toHaveLength(0);
	});

	test("skips duplicates that live before the compaction boundary", () => {
		const body = "PAYLOAD\n".repeat(40);
		const before = messageEntry(toolResultMessage("read", body));
		const boundary = messageEntry({ role: "user", content: "resume", timestamp: 0 });
		const after = messageEntry(toolResultMessage("read", body));
		// Without a boundary, the earlier copy is deduped.
		expect(collectRedundantToolResultRegions([before, boundary, after], cfg())).toHaveLength(1);
		// With the boundary at `boundary`, the pre-boundary copy is never sent, so
		// only the after-boundary copy is seen — nothing to dedup.
		expect(
			collectRedundantToolResultRegions([before, boundary, after], cfg({ keepBoundaryId: boundary.id })),
		).toHaveLength(0);
	});

	test("non-identical results interleaved between duplicates do not break matching", () => {
		const body = "DUP\n".repeat(40);
		const first = messageEntry(toolResultMessage("read", body));
		const noise = messageEntry(toolResultMessage("bash", "unrelated\n".repeat(40)));
		const second = messageEntry(toolResultMessage("read", body));
		const regions = collectRedundantToolResultRegions([first, noise, second], cfg());
		expect(regions).toHaveLength(1);
		expect(regions[0].entry).toBe(first);
	});
});
