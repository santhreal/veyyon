import { describe, expect, it } from "bun:test";
import { contentText } from "@veyyon/coding-agent/session/content-text";

/**
 * contentText is the ONE owner for flattening string-or-block content back to a string; every call
 * site that used to hand-roll this (the join separator, dropping vs. placeholdering images, whether
 * to trim) now passes an options object instead. It had no direct test. Because the differences
 * between variants are intentional and reader-visible, a regression here silently changes what a
 * user sees in transcripts and history. These pin each option's effect and the malformed-block
 * guard (a non-string `text` reads as absent, never throws).
 */

describe("contentText", () => {
	describe("plain string input", () => {
		it("returns the string verbatim by default and trims only with trimString", () => {
			expect(contentText("  hi  ")).toBe("  hi  ");
			expect(contentText("  hi  ", { trimString: true })).toBe("hi");
		});
	});

	describe("block array joining", () => {
		it("joins text blocks with a newline by default and honors a custom separator", () => {
			const blocks = [
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			];
			expect(contentText(blocks)).toBe("a\nb");
			expect(contentText(blocks, { separator: " " })).toBe("a b");
		});

		it("reads only text-typed blocks, skipping thinking and tool-call blocks", () => {
			expect(
				contentText([
					{ type: "text", text: "a" },
					{ type: "thinking", text: "t" },
					{ type: "toolCall" },
					{ type: "text", text: "b" },
				]),
			).toBe("a\nb");
		});

		it("returns an empty string for an empty block array", () => {
			expect(contentText([])).toBe("");
		});
	});

	describe("image blocks", () => {
		it("drops image blocks by default and renders any other string as a literal placeholder", () => {
			const blocks = [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }];
			expect(contentText(blocks)).toBe("a\nb");
			expect(contentText(blocks, { image: "[img]" })).toBe("a\n[img]\nb");
		});
	});

	describe("trimBlocks", () => {
		it("keeps untrimmed text (including whitespace-only blocks) when disabled", () => {
			expect(
				contentText([
					{ type: "text", text: "  a  " },
					{ type: "text", text: "   " },
				]),
			).toBe("  a  \n   ");
		});

		it("trims each block and skips ones that become empty when enabled", () => {
			expect(
				contentText(
					[
						{ type: "text", text: "  a  " },
						{ type: "text", text: "   " },
						{ type: "text", text: "b" },
					],
					{ trimBlocks: true },
				),
			).toBe("a\nb");
		});
	});

	describe("malformed block guard", () => {
		it("treats a non-string text as an empty block instead of throwing", () => {
			const blocks = [
				{ type: "text", text: 123 as unknown as string },
				{ type: "text", text: "b" },
			];
			// Without trimBlocks the empty block still contributes a separator slot.
			expect(contentText(blocks)).toBe("\nb");
			// With trimBlocks the now-empty block is skipped entirely.
			expect(contentText(blocks, { trimBlocks: true })).toBe("b");
		});
	});
});
