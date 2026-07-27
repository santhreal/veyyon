/**
 * "What counts as assistant text" is answered in one place.
 *
 * WHY THIS EXISTS. An assistant message's content is a list of blocks, only some of which
 * are text: thinking blocks, tool calls and tool results sit in the same list. Pulling the
 * text out means knowing which blocks count, and three modules knew it independently.
 * `@veyyon/ai/utils/message-text` had `assistantTextBlocks` for content already typed as
 * `AssistantMessage["content"]`, while `coding-agent/src/mnemopi/state.ts` and
 * `typescript-edit-benchmark/src/argot-bench.ts` each hand-rolled the same walk for
 * content arriving as `unknown` from a session log or a benchmark transcript.
 *
 * WHAT DRIFT WOULD HAVE COST. Nothing throws when a copy falls behind. A new content-block
 * shape lands, the owner learns about it, and the copies keep working while silently
 * returning less text than the message contained. A memory that records half an answer and
 * a benchmark that scores half a response are both wrong in a way that looks fine.
 *
 * `assistantTextBlocksFromUnknown` is now the one owner of the unvalidated case, and this
 * suite pins that it agrees with the typed extractor and survives the hostile inputs the
 * hand-rolled copies were each written to survive.
 */

import { describe, expect, it } from "bun:test";

import {
	assistantText,
	assistantTextBlocks,
	assistantTextBlocksFromUnknown,
	assistantTextFromUnknown,
} from "../message-text";

/** A well-formed content list with text, thinking and tool blocks interleaved. */
const MIXED_CONTENT = [
	{ type: "thinking", thinking: "hidden reasoning" },
	{ type: "text", text: "first" },
	{ type: "tool_use", id: "t1", name: "read", input: {} },
	{ type: "text", text: "second" },
];

describe("the two extractors agree", () => {
	/**
	 * THE regression. The typed path and the unvalidated path answer the same question,
	 * so on content both can read they must return the same blocks in the same order.
	 * When the extraction was written out three times this held by coincidence.
	 */
	it("return the same blocks for well-formed content", () => {
		const typed = assistantTextBlocks({ content: MIXED_CONTENT as never });

		expect(assistantTextBlocksFromUnknown(MIXED_CONTENT)).toEqual(typed);
		expect(typed).toEqual(["first", "second"]);
	});

	/** And the joined forms agree too, separator for separator. */
	it("join identically", () => {
		const message = { content: MIXED_CONTENT as never };

		expect(assistantTextFromUnknown(MIXED_CONTENT)).toBe(assistantText(message));
		expect(assistantTextFromUnknown(MIXED_CONTENT, "")).toBe(assistantText(message, ""));
	});

	/** Real values, not merely mutual agreement. */
	it("join with a newline by default and nothing when asked", () => {
		expect(assistantTextFromUnknown(MIXED_CONTENT)).toBe("first\nsecond");
		expect(assistantTextFromUnknown(MIXED_CONTENT, "")).toBe("firstsecond");
		expect(assistantTextFromUnknown(MIXED_CONTENT, " | ")).toBe("first | second");
	});

	/** Order is preserved: text blocks come back in the order the model wrote them. */
	it("preserve block order", () => {
		const content = [
			{ type: "text", text: "one" },
			{ type: "text", text: "two" },
			{ type: "text", text: "three" },
		];

		expect(assistantTextBlocksFromUnknown(content)).toEqual(["one", "two", "three"]);
	});
});

describe("content that has not been validated", () => {
	/**
	 * A `null` entry inside the array is the case that separates the unvalidated
	 * extractor from the typed one: reading `.type` off `null` throws, so a caller that
	 * cast its way to the typed extractor would crash on a session log with a hole in it.
	 */
	it("skips a null block instead of throwing", () => {
		const content = [null, { type: "text", text: "kept" }, undefined];

		expect(assistantTextBlocksFromUnknown(content)).toEqual(["kept"]);
	});

	/** A primitive where a block should be is skipped for the same reason. */
	it("skips primitives", () => {
		expect(assistantTextBlocksFromUnknown(["raw string", 42, true, { type: "text", text: "kept" }])).toEqual(["kept"]);
	});

	/**
	 * A text block whose `text` is not a string contributes nothing, rather than pushing
	 * `undefined` into the middle of the joined output where it would render as the
	 * literal word "undefined".
	 */
	it("skips a text block with no usable text", () => {
		const content = [
			{ type: "text" },
			{ type: "text", text: null },
			{ type: "text", text: 7 },
			{ type: "text", text: "kept" },
		];

		expect(assistantTextBlocksFromUnknown(content)).toEqual(["kept"]);
		expect(assistantTextFromUnknown(content)).toBe("kept");
	});

	/** Content that is not an array at all yields nothing rather than throwing. */
	it("yields nothing for content that is not a list", () => {
		expect(assistantTextBlocksFromUnknown(undefined)).toEqual([]);
		expect(assistantTextBlocksFromUnknown(null)).toEqual([]);
		expect(assistantTextBlocksFromUnknown("a plain string")).toEqual([]);
		expect(assistantTextBlocksFromUnknown({ type: "text", text: "not in a list" })).toEqual([]);
		expect(assistantTextFromUnknown(undefined)).toBe("");
	});

	/** An empty list is empty, not an empty string in a one-element list. */
	it("yields nothing for an empty list", () => {
		expect(assistantTextBlocksFromUnknown([])).toEqual([]);
		expect(assistantTextFromUnknown([])).toBe("");
	});

	/**
	 * An empty text block is real content and is kept. Dropping it would silently close
	 * a paragraph gap the model wrote.
	 */
	it("keeps an empty text block", () => {
		expect(assistantTextBlocksFromUnknown([{ type: "text", text: "" }])).toEqual([""]);
		expect(assistantTextFromUnknown([{ type: "text", text: "a" }, { type: "text", text: "" }])).toBe("a\n");
	});

	/** A non-text block type is not text, however close its shape looks. */
	it("does not read text off a block of another type", () => {
		const content = [
			{ type: "thinking", text: "reasoning that is not an answer" },
			{ type: "tool_result", text: "output that is not an answer" },
		];

		expect(assistantTextBlocksFromUnknown(content)).toEqual([]);
	});
});
