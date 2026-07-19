import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@veyyon/ai";
import { type ContentBlockLike, contentText } from "../src/session/content-text";

const text = (value: string): TextContent => ({ type: "text", text: value });
const image = (): ImageContent => ({ type: "image", data: "AA", mimeType: "image/png" });

describe("contentText", () => {
	it("returns a plain string unchanged, or trimmed when asked", () => {
		expect(contentText("  hi  ")).toBe("  hi  ");
		expect(contentText("  hi  ", { trimString: true })).toBe("hi");
	});

	it("joins text blocks with the newline default and drops images", () => {
		expect(contentText([text("a"), image(), text("b")])).toBe("a\nb");
		expect(contentText([image()])).toBe("");
		expect(contentText([])).toBe("");
	});

	it("honors an explicit separator", () => {
		expect(contentText([text("a"), text("b")], { separator: " " })).toBe("a b");
		expect(contentText([text("a"), text("b")], { separator: "" })).toBe("ab");
	});

	it("renders images as a placeholder when one is given", () => {
		expect(contentText([text("a"), image(), text("b")], { image: "[image]" })).toBe("a\n[image]\nb");
	});

	it("trims each block and skips empties when trimBlocks is set", () => {
		expect(contentText([text("  a  "), text("   "), text("b")], { trimBlocks: true, separator: "\n\n" })).toBe(
			"a\n\nb",
		);
	});
});

describe("contentText reproduces the former per-site helpers exactly", () => {
	const blocks = [text("first"), image(), text("second")];

	it("getArrayContentText (messages.ts): text only, join newline", () => {
		expect(contentText(blocks)).toBe("first\nsecond");
	});

	it("extractTextFromContent (session-listing.ts): string passthrough, join space", () => {
		expect(contentText("raw")).toBe("raw");
		expect(contentText(blocks, { separator: " " })).toBe("first second");
	});

	it("getCustomMessageTextContent (agent-session.ts): string passthrough, join empty", () => {
		expect(contentText("raw")).toBe("raw");
		expect(contentText(blocks, { separator: "" })).toBe("firstsecond");
	});

	it("contentToText (session-history-format.ts): image placeholder, join newline", () => {
		expect(contentText(blocks, { image: "[image]" })).toBe("first\n[image]\nsecond");
	});
});

// textFromContent (agent-session.ts) is a thin adapter that hands the array
// branch to contentText with { separator: "\n\n", trimBlocks: true }. It runs at
// the `unknown` agent-message boundary where a block may be malformed, so the
// owner must reproduce the old hand-rolled loop's defensive skips exactly:
// non-record blocks, blocks with a non-string `text`, and blocks that are empty
// after trimming are all dropped — never do they throw or leak a placeholder.
describe("contentText tolerates the malformed agent-message boundary (textFromContent adapter)", () => {
	const opts = { separator: "\n\n", trimBlocks: true } as const;

	it("joins trimmed text blocks with a blank line", () => {
		expect(contentText([text("  a  "), text("b")], opts)).toBe("a\n\nb");
	});

	it("skips blocks whose text is not a string instead of throwing", () => {
		const blocks = [text("a"), { type: "text", text: 42 } as unknown as ContentBlockLike, text("b")];
		expect(contentText(blocks, opts)).toBe("a\n\nb");
	});

	it("skips a text block with an absent text field", () => {
		const blocks = [text("a"), { type: "text" } as ContentBlockLike, text("b")];
		expect(contentText(blocks, opts)).toBe("a\n\nb");
	});

	it("skips non-text blocks (thinking, tool-call) carried in the wider message union", () => {
		const blocks = [
			text("a"),
			{ type: "thinking", text: "hidden" } as ContentBlockLike,
			{ type: "toolCall" } as ContentBlockLike,
			text("b"),
		];
		expect(contentText(blocks, opts)).toBe("a\n\nb");
	});

	it("drops blocks that are only whitespace once trimmed", () => {
		expect(contentText([text("a"), text("   "), text("b")], opts)).toBe("a\n\nb");
	});
});

describe("content-text source lock", () => {
	const SESSION_DIR = path.join(import.meta.dir, "..", "src", "session");
	// contentText owns flattening user/custom content blocks to a string, and
	// @veyyon/ai's assistantText owns the same for assistant content. Any file that
	// hand-rolls the `.filter(... .type === "text").map(...).join()` chain has
	// re-created one of those owners and must import it instead. The lazy `[\s\S]`
	// spans the nested parens of a `.filter((b): b is TextContent => ...)` guard.
	// Exempt files own a genuinely different contract (see EXEMPT below).
	const FLATTEN_CHAIN = /\.filter\([\s\S]{0,90}?\.type === "text"[\s\S]{0,170}?\.join\(/;
	// snapcompact-inline.ts voids the whole result when any image is present
	// (a tool result with an image cannot be snapcompacted to text), so it is not
	// the per-block "drop or placeholder" contract contentText offers.
	// content-text.ts is the owner itself.
	const EXEMPT = new Set(["content-text.ts", "snapcompact-inline.ts"]);

	it("catches the flatten chain but not an unrelated filter", () => {
		expect(
			FLATTEN_CHAIN.test('c.filter((b): b is TextContent => b.type === "text").map(b => b.text).join(" ")'),
		).toBe(true);
		expect(FLATTEN_CHAIN.test('items.filter(x => x.active).map(x => x.name).join(", ")')).toBe(false);
	});

	it("no session source rebuilds the content-block flatten chain", async () => {
		const offenders: string[] = [];
		for (const entry of await readdir(SESSION_DIR, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
			if (EXEMPT.has(entry.name)) continue;
			const body = await readFile(path.join(SESSION_DIR, entry.name), "utf8");
			if (FLATTEN_CHAIN.test(body)) offenders.push(entry.name);
		}
		expect(offenders, "content-block flatten — call contentText or assistantText instead").toEqual([]);
	});
});
