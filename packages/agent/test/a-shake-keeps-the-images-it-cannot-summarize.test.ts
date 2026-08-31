/**
 * WHY: `applyShakeRegion` reclaimed text tokens from a tool result by assigning
 * `message.content = [{ type: "text", text: replacement }]`. That assignment is
 * a whole-content overwrite, so a tool result carrying a screenshot lost the
 * image block along with the text, and the model went blind to a picture it had
 * already been shown while nothing in the transcript said the picture was gone.
 *
 * The class this closes is a compaction rewrite that flattens a multi-modal
 * message: any shake path that reaches a `toolResult` region must spend the
 * text budget and leave every other block kind in place. The suite drives the
 * real collectors and the real mutators over the real content union rather than
 * asserting on the one screenshot case from the report.
 *
 * What it does not catch: a provider transform that drops image blocks after
 * compaction hands the message on, and block-region shakes of an assistant
 * message, which splice inside one text block and never touch the block list.
 */

import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionMessageEntry, ShakeConfig } from "@veyyon/agent-core/compaction";
import {
	applyShakeRegion,
	applyShakeRegions,
	collectRedundantToolResultRegions,
	collectShakeRegions,
} from "@veyyon/agent-core/compaction";
import type { ImageContent, ToolResultMessage } from "@veyyon/ai";

let idCounter = 0;
function nextId(): string {
	return `entry-${idCounter++}`;
}

function messageEntry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: nextId(), parentId: null, timestamp: new Date().toISOString(), message };
}

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

/** A tool result whose content interleaves text and images, as a screenshot tool returns. */
function multimodalResult(content: ToolResultMessage["content"], toolName = "browser"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${idCounter++}`,
		toolName,
		content,
		isError: false,
		timestamp: Date.now(),
	};
}

function cfg(over: Partial<ShakeConfig> = {}): ShakeConfig {
	return { protectTokens: 0, minSavings: 0, protectedTools: [], fenceMinTokens: 50, ...over };
}

/** Big enough that the collectors judge the region worth shaking. */
const BULK = "x".repeat(4000);

describe("a shake keeps the blocks it cannot summarize", () => {
	test("an image survives while the text around it is replaced", () => {
		const result = multimodalResult([{ type: "text", text: BULK }, image("screenshot-payload")]);
		const regions = collectShakeRegions([messageEntry(result)], cfg());
		expect(regions).toHaveLength(1);

		applyShakeRegion(regions[0], "[shaken]");

		expect(result.content).toEqual([{ type: "text", text: "[shaken]" }, image("screenshot-payload")]);
		expect(result.prunedAt).toBeGreaterThan(0);
	});

	test("every image survives, in order, when several are interleaved with text", () => {
		const result = multimodalResult([
			image("first"),
			{ type: "text", text: BULK },
			image("second"),
			{ type: "text", text: BULK },
			image("third"),
		]);
		const regions = collectShakeRegions([messageEntry(result)], cfg());

		applyShakeRegion(regions[0], "[shaken]");

		expect(result.content).toEqual([
			{ type: "text", text: "[shaken]" },
			image("first"),
			image("second"),
			image("third"),
		]);
	});

	test("a text-only result still collapses to exactly one text block", () => {
		const result = multimodalResult([{ type: "text", text: BULK }], "bash");
		const regions = collectShakeRegions([messageEntry(result)], cfg());

		applyShakeRegion(regions[0], "[shaken]");

		expect(result.content).toEqual([{ type: "text", text: "[shaken]" }]);
	});

	test("an image-only result gains the placeholder and keeps the image", () => {
		const result = multimodalResult([image("only")]);

		applyShakeRegion({ kind: "toolResult", entry: messageEntry(result), tokens: 1 } as never, "[shaken]");

		expect(result.content).toEqual([{ type: "text", text: "[shaken]" }, image("only")]);
	});

	test("shaking twice keeps one placeholder and does not duplicate the image", () => {
		const result = multimodalResult([{ type: "text", text: BULK }, image("kept")]);
		const region = { kind: "toolResult", entry: messageEntry(result), tokens: 1 } as never;

		applyShakeRegion(region, "[shaken]");
		applyShakeRegion(region, "[shaken again]");

		expect(result.content).toEqual([{ type: "text", text: "[shaken again]" }, image("kept")]);
	});

	test("the batch mutator preserves images across every region it applies", () => {
		const first = multimodalResult([{ type: "text", text: BULK }, image("a")]);
		const second = multimodalResult([{ type: "text", text: BULK }, image("b")]);
		const entries = [messageEntry(first), messageEntry(second)];
		const regions = collectShakeRegions(entries, cfg());
		expect(regions.length).toBeGreaterThanOrEqual(2);

		applyShakeRegions(regions.map(region => ({ region, replacement: "[shaken]" })));

		expect(first.content).toEqual([{ type: "text", text: "[shaken]" }, image("a")]);
		expect(second.content).toEqual([{ type: "text", text: "[shaken]" }, image("b")]);
	});

	test("the redundant-tool-result path preserves images too", () => {
		// Two reads of the same target: the older one is the redundant region.
		const older = multimodalResult([{ type: "text", text: BULK }, image("stale-shot")], "read");
		const newer = multimodalResult([{ type: "text", text: BULK }, image("fresh-shot")], "read");
		const entries = [messageEntry(older), messageEntry(newer)];

		const regions = collectRedundantToolResultRegions(entries, cfg());
		for (const region of regions) applyShakeRegion(region, "[superseded]");

		// Whatever the collector judged redundant, no image may be lost by shaking it.
		for (const result of [older, newer]) {
			const images = result.content.filter(block => block.type === "image");
			expect(images.length).toBe(1);
		}
	});

	test("a block kind the union grows later is preserved by default", () => {
		// Fail-by-default guard: the mutator filters on `!== "text"`, so a kind
		// nobody here has heard of survives. A future filter that names image
		// explicitly turns this red.
		const exotic = { type: "document", data: "spec.pdf" } as never;
		const result = multimodalResult([{ type: "text", text: BULK }, exotic]);

		applyShakeRegion({ kind: "toolResult", entry: messageEntry(result), tokens: 1 } as never, "[shaken]");

		expect(result.content).toEqual([{ type: "text", text: "[shaken]" }, exotic]);
	});
});
