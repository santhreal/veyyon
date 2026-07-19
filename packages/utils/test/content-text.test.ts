import { describe, expect, it } from "bun:test";
import { contentText } from "../src/content-text";

// `contentText` is the ONE owner for tolerant text-only extraction from an
// untyped message-content value. hindsight/transcript.ts (separator "\n") and
// stats/parser.ts (separator "") both re-point here; these lock the behavior
// each depended on.
describe("contentText", () => {
	it("returns a raw string unchanged", () => {
		expect(contentText("hello")).toBe("hello");
	});

	it("returns '' for null, undefined, numbers, and plain objects", () => {
		expect(contentText(null)).toBe("");
		expect(contentText(undefined)).toBe("");
		expect(contentText(42)).toBe("");
		expect(contentText({ text: "nope" })).toBe("");
	});

	it("joins text blocks with the default newline separator", () => {
		const content = [
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		];
		expect(contentText(content)).toBe("a\nb");
	});

	it("honors a custom separator (stats uses empty string)", () => {
		const content = [
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		];
		expect(contentText(content, "")).toBe("ab");
	});

	it("skips non-text blocks, thinking blocks, and malformed entries", () => {
		const content = [
			{ type: "text", text: "keep" },
			{ type: "thinking", thinking: "drop" },
			{ type: "tool_use", id: "x" },
			null,
			"loose string",
			{ type: "text", text: 5 },
		];
		expect(contentText(content)).toBe("keep");
	});
});
