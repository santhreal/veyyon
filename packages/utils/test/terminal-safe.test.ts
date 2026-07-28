/**
 * Behavioral contract for terminal-bound untrusted text. These are visibility escapes rather than
 * deletion: operators must still be able to distinguish the exact hostile code point in evidence.
 */
import { describe, expect, it } from "bun:test";
import { escapeTerminalText } from "@veyyon/utils";

function visibleEscape(codePoint: number): string {
	const width = codePoint <= 0xffff ? 4 : 5;
	const digits = codePoint.toString(16).toUpperCase().padStart(width, "0");
	return codePoint <= 0xffff ? `\\u${digits}` : `\\u{${digits}}`;
}

describe("escapeTerminalText", () => {
	/** ECMA terminal controls can erase, move, or rewrite prior audit output unless made visible. */
	it("escapes every C0, C1, and DEL code point while retaining ordinary text", () => {
		const controls = [
			...Array.from({ length: 0x20 }, (_, codePoint) => codePoint),
			...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
		];
		const input = `before${controls.map(codePoint => String.fromCodePoint(codePoint)).join("")}after`;
		const expected = `before${controls.map(visibleEscape).join("")}after`;

		expect(escapeTerminalText(input)).toBe(expected);
	});

	/** Unicode format controls spoof ordering invisibly, including astral tag characters. */
	it("escapes every Unicode format character, including bidi isolates and astral tags", () => {
		const formats: number[] = [];
		for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
			if (/\p{Cf}/u.test(String.fromCodePoint(codePoint))) formats.push(codePoint);
		}
		const input = formats.map(codePoint => String.fromCodePoint(codePoint)).join("");
		const escaped = escapeTerminalText(input);

		expect(formats).toContain(0x00ad);
		expect(formats).toContain(0x202e);
		expect(formats).toContain(0x2066);
		expect(formats).toContain(0xe0001);
		expect(escaped).toBe(formats.map(visibleEscape).join(""));
		expect(escaped).not.toMatch(/\p{Cf}/u);
	});

	/** Line separators split renderers and lone surrogates must not be normalized into replacement glyphs. */
	it("makes JavaScript line separators and malformed UTF-16 visible without damaging valid astral text", () => {
		const input = `A\u2028B\u2029C\ud800D\udc00E😀F`;

		expect(escapeTerminalText(input)).toBe("A\\u2028B\\u2029C\\uD800D\\uDC00E😀F");
	});

	/** Sanitizing inert text must not degrade legitimate multilingual operator evidence. */
	it("is unchanged for inert printable Unicode", () => {
		const text = "plain café Ελληνικά 漢字 😀";
		expect(escapeTerminalText(text)).toBe(text);
	});
});
