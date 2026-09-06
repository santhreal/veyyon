/**
 * WHY: `contentText` is the one owner for flattening message content — a plain
 * string or an array of blocks — back to a string, for every package. It was
 * two owners: this tolerant one, and a richer typed copy in the coding agent's
 * session directory, each with its own suite and each doc claiming to be the
 * only one. They disagreed on the input neither suite shared, a text block
 * whose `text` is not a string: this one skipped it, the copy pushed an empty
 * part, so the same malformed block vanished on one path and opened a blank
 * line on the other.
 *
 * The class this closes is the block-kind space against the option space, not
 * the four call shapes that happen to exist today. Every kind of entry an array
 * can hold is asserted to contribute either its text or nothing at all —
 * including the entries that are not blocks, since the input is `unknown` and
 * arrives from a provider. "Nothing at all" is the load-bearing half: a block
 * that contributes an empty string is not absent, because `join` still puts a
 * separator beside it, which is exactly how the two owners drifted.
 *
 * The former per-call-site variants are pinned too, so consolidating the
 * options cannot silently re-point a caller at a different separator or image
 * rendering.
 *
 * Not covered: assistant content, which `assistantText` in `@veyyon/ai` owns.
 */

import { describe, expect, it } from "bun:test";
import { type ContentBlockLike, contentText } from "../src/content-text";

const text = (value: string): ContentBlockLike => ({ type: "text", text: value });
const image = (): ContentBlockLike => ({ type: "image" });

describe("a plain string", () => {
	it("is returned verbatim", () => {
		expect(contentText("  hi  ")).toBe("  hi  ");
	});

	it("is trimmed only when asked", () => {
		expect(contentText("  hi  ", { trimString: true })).toBe("hi");
	});

	it("is unaffected by the block options", () => {
		expect(contentText("  hi  ", { trimBlocks: true, separator: "|", image: "[i]" })).toBe("  hi  ");
	});
});

describe("a value that is neither a string nor an array", () => {
	it.each([
		["null", null],
		["undefined", undefined],
		["a number", 42],
		["a plain object", { text: "nope" }],
		["a message-like wrapper", { content: [{ type: "text", text: "nope" }] }],
	])("%s yields an empty string", (_label, value) => {
		expect(contentText(value)).toBe("");
	});
});

describe("joining text blocks", () => {
	it("joins with a newline by default", () => {
		expect(contentText([text("a"), text("b")])).toBe("a\nb");
	});

	it.each([
		[" ", "a b"],
		["", "ab"],
		["\n\n", "a\n\nb"],
	])("honors the separator %j", (separator, expected) => {
		expect(contentText([text("a"), text("b")], { separator })).toBe(expected);
	});

	it("returns an empty string for an empty array", () => {
		expect(contentText([])).toBe("");
	});

	it("keeps a text block that is only whitespace when not trimming", () => {
		expect(contentText([text("  a  "), text("   ")])).toBe("  a  \n   ");
	});
});

describe("an entry that carries no text contributes nothing, not an empty slot", () => {
	// Each of these sits between two text blocks with a visible separator, so a
	// block that contributed "" instead of being skipped would show as "a||b".
	it.each([
		["a thinking block", { type: "thinking", text: "hidden" }],
		["a tool call", { type: "toolCall" }],
		["a tool_use block", { type: "tool_use", id: "x" }],
		["a text block whose text is a number", { type: "text", text: 42 }],
		["a text block whose text is null", { type: "text", text: null }],
		["a text block with no text field", { type: "text" }],
		["null", null],
		["undefined", undefined],
		["a loose string", "loose"],
		["a number", 7],
		["an image block, by default", { type: "image" }],
	])("%s is skipped", (_label, block) => {
		expect(contentText([text("a"), block, text("b")], { separator: "|" })).toBe("a|b");
	});

	it("an array of nothing but skipped entries yields an empty string", () => {
		expect(contentText([{ type: "thinking" }, null, { type: "text", text: 1 }, image()])).toBe("");
	});

	it("skips a malformed block instead of throwing when trimming", () => {
		expect(contentText([text("a"), { type: "text", text: 42 }, text("b")], { trimBlocks: true })).toBe("a\nb");
	});
});

describe("image blocks", () => {
	it("are dropped by default", () => {
		expect(contentText([text("a"), image(), text("b")])).toBe("a\nb");
	});

	it("render as a literal placeholder when one is given", () => {
		expect(contentText([text("a"), image(), text("b")], { image: "[image]" })).toBe("a\n[image]\nb");
	});

	it("yield an empty string when they are the only blocks and are dropped", () => {
		expect(contentText([image()])).toBe("");
	});

	it("are placeholdered even with no text beside them", () => {
		expect(contentText([image(), image()], { image: "[i]" })).toBe("[i]\n[i]");
	});
});

describe("trimBlocks", () => {
	it("trims each block and skips ones that become empty", () => {
		expect(contentText([text("  a  "), text("   "), text("b")], { trimBlocks: true })).toBe("a\nb");
	});

	it("applies the separator only between the blocks that survive", () => {
		expect(contentText([text("  a  "), text("   "), text("b")], { trimBlocks: true, separator: "\n\n" })).toBe(
			"a\n\nb",
		);
	});

	it("leaves a whitespace-only run as an empty string when every block is dropped", () => {
		expect(contentText([text("   "), text("\t")], { trimBlocks: true })).toBe("");
	});
});

describe("the call shapes this owner replaced", () => {
	const blocks = [text("first"), image(), text("second")];

	it("message text: text only, joined by newline", () => {
		expect(contentText(blocks)).toBe("first\nsecond");
	});

	it("session listing: string passthrough, joined by a space", () => {
		expect(contentText("raw")).toBe("raw");
		expect(contentText(blocks, { separator: " " })).toBe("first second");
	});

	it("custom message text: string passthrough, joined by nothing", () => {
		expect(contentText("raw")).toBe("raw");
		expect(contentText(blocks, { separator: "" })).toBe("firstsecond");
	});

	it("history format: image placeholder, joined by newline", () => {
		expect(contentText(blocks, { image: "[image]" })).toBe("first\n[image]\nsecond");
	});

	it("the agent-message boundary: trimmed blocks joined by a blank line", () => {
		const messy = [text("  a  "), { type: "text", text: 42 }, { type: "thinking" }, text("   "), text("b")];
		expect(contentText(messy, { separator: "\n\n", trimBlocks: true })).toBe("a\n\nb");
	});

	it("stats: joined by nothing", () => {
		expect(contentText([text("a"), text("b")], { separator: "" })).toBe("ab");
	});
});
