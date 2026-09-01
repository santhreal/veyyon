import { describe, expect, it } from "bun:test";
import { contentText } from "../src/content-text";
import { escapeTerminalText } from "../src/terminal-safe";

describe("contentText", () => {
	it("returns string as-is", () => {
		expect(contentText("hello")).toBe("hello");
	});
	it("returns empty string for non-array, non-string", () => {
		expect(contentText(42)).toBe("");
		expect(contentText(null)).toBe("");
		expect(contentText(undefined)).toBe("");
		expect(contentText({ a: 1 })).toBe("");
	});
	it("extracts text from content blocks", () => {
		const content = [
			{ type: "text", text: "hello" },
			{ type: "text", text: "world" },
		];
		expect(contentText(content)).toBe("hello\nworld");
	});
	it("uses custom separator", () => {
		const content = [
			{ type: "text", text: "hello" },
			{ type: "text", text: "world" },
		];
		expect(contentText(content, " ")).toBe("hello world");
	});
	it("skips non-text blocks", () => {
		const content = [
			{ type: "thinking", text: "thinking..." },
			{ type: "text", text: "hello" },
			{ type: "tool_use", name: "bash" },
		];
		expect(contentText(content)).toBe("hello");
	});
	it("skips blocks without string text", () => {
		const content = [
			{ type: "text", text: 123 },
			{ type: "text", text: "hello" },
		];
		expect(contentText(content)).toBe("hello");
	});
	it("skips null/undefined blocks", () => {
		const content = [null, undefined, { type: "text", text: "hello" }];
		expect(contentText(content)).toBe("hello");
	});
	it("returns empty string for empty array", () => {
		expect(contentText([])).toBe("");
	});
	it("returns empty string for array with no text blocks", () => {
		expect(contentText([{ type: "image", source: {} }])).toBe("");
	});
	it("handles single text block", () => {
		expect(contentText([{ type: "text", text: "hello" }])).toBe("hello");
	});
	it("handles blocks with extra properties", () => {
		const content = [{ type: "text", text: "hello", id: "1", extra: true }];
		expect(contentText(content)).toBe("hello");
	});
	it("skips blocks where type is not exactly 'text'", () => {
		const content = [{ type: "TEXT", text: "hello" }];
		expect(contentText(content)).toBe("");
	});
});

describe("escapeTerminalText", () => {
	it("preserves normal text", () => {
		expect(escapeTerminalText("hello world")).toBe("hello world");
	});
	it("preserves unicode text", () => {
		expect(escapeTerminalText("héllo wörld")).toBe("héllo wörld");
	});
	it("preserves emoji", () => {
		expect(escapeTerminalText("😀")).toBe("😀");
	});
	it("escapes NUL", () => {
		expect(escapeTerminalText("\0")).toBe("\\u0000");
	});
	it("escapes BEL (0x07)", () => {
		expect(escapeTerminalText("\x07")).toBe("\\u0007");
	});
	it("escapes ESC (0x1b)", () => {
		expect(escapeTerminalText("\x1b")).toBe("\\u001B");
	});
	it("escapes DEL (0x7f)", () => {
		expect(escapeTerminalText("\x7f")).toBe("\\u007F");
	});
	it("escapes C1 controls (0x80-0x9f)", () => {
		expect(escapeTerminalText("\x80")).toBe("\\u0080");
		expect(escapeTerminalText("\x9f")).toBe("\\u009F");
	});
	it("escapes line separator (U+2028)", () => {
		expect(escapeTerminalText("\u2028")).toBe("\\u2028");
	});
	it("escapes paragraph separator (U+2029)", () => {
		expect(escapeTerminalText("\u2029")).toBe("\\u2029");
	});
	it("escapes newlines and tabs (C0 controls)", () => {
		expect(escapeTerminalText("\n")).toBe("\\u000A");
		expect(escapeTerminalText("\t")).toBe("\\u0009");
	});
	it("preserves space", () => {
		expect(escapeTerminalText(" ")).toBe(" ");
	});
	it("handles empty string", () => {
		expect(escapeTerminalText("")).toBe("");
	});
	it("escapes lone high surrogate", () => {
		const lone = String.fromCharCode(0xd800);
		expect(escapeTerminalText(lone)).toBe("\\uD800");
	});
	it("escapes lone low surrogate", () => {
		const lone = String.fromCharCode(0xdc00);
		expect(escapeTerminalText(lone)).toBe("\\uDC00");
	});
	it("preserves valid surrogate pairs (emoji)", () => {
		// 😀 = U+1F600, surrogate pair D83D DE00
		expect(escapeTerminalText("😀")).toBe("😀");
	});
	it("escapes format characters (Cf)", () => {
		// Zero-width space U+200B is a format char
		expect(escapeTerminalText("\u200B")).toBe("\\u200B");
	});
	it("escapes BOM (U+FEFF, a format char)", () => {
		expect(escapeTerminalText("\uFEFF")).toBe("\\uFEFF");
	});
	it("handles mixed normal and control chars", () => {
		expect(escapeTerminalText("hello\x07world")).toBe("hello\\u0007world");
	});
	it("preserves printable ASCII", () => {
		expect(escapeTerminalText("ABCdef123!@#")).toBe("ABCdef123!@#");
	});
});
