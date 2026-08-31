/**
 * Multilingual multi-line file: SWAP/DEL/INS preserve non-target scripts.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits mixed script multilingual file", () => {
	const base = "Hello\nこんにちは\nمرحبا\nשלום\nWorld";

	it("SWAP japanese line", () => {
		const { text } = applyEdits(base, parsePatch("SWAP 2.=2:\n+日本語").edits);
		expect(text.split("\n")[1]).toBe("日本語");
		expect(text.split("\n")[0]).toBe("Hello");
		expect(text.split("\n")[2]).toBe("مرحبا");
	});

	it("DEL arabic line", () => {
		const { text } = applyEdits(base, parsePatch("DEL 3").edits);
		expect(text.split("\n")).toEqual(["Hello", "こんにちは", "שלום", "World"]);
	});

	it("INS.HEAD korean", () => {
		const { text } = applyEdits(base, parsePatch("INS.HEAD:\n+안녕").edits);
		expect(text.split("\n")[0]).toBe("안녕");
		expect(text.split("\n").slice(1).join("\n")).toBe(base);
	});
});
