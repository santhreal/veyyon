import { describe, expect, it } from "bun:test";
import { AnsiStripper, stripAnsi } from "../src/strip-ansi";
import { escapeTerminalText } from "../src/terminal-safe";
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS, WEEK_MS } from "../src/time";

describe("stripAnsi", () => {
	it("returns plain text unchanged", () => {
		expect(stripAnsi("hello world")).toBe("hello world");
	});

	it("strips CSI color codes", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("strips CSI with multiple parameters", () => {
		expect(stripAnsi("\x1b[1;31;42mbold red on green\x1b[0m")).toBe("bold red on green");
	});

	it("strips empty CSI", () => {
		expect(stripAnsi("\x1b[mtext")).toBe("text");
	});

	it("handles text without escape sequences", () => {
		expect(stripAnsi("just text")).toBe("just text");
	});

	it("handles empty string", () => {
		expect(stripAnsi("")).toBe("");
	});

	it("strips cursor movement", () => {
		expect(stripAnsi("\x1b[2Atext")).toBe("text");
	});

	it("strips OSC sequences", () => {
		expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
	});

	it("preserves newlines", () => {
		expect(stripAnsi("\x1b[31mhello\nworld\x1b[0m")).toBe("hello\nworld");
	});
});

describe("AnsiStripper", () => {
	it("returns plain text unchanged", () => {
		const s = new AnsiStripper();
		expect(s.push("hello")).toBe("hello");
	});

	it("strips ANSI from chunks", () => {
		const s = new AnsiStripper();
		expect(s.push("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("handles split escape sequences across chunks", () => {
		const s = new AnsiStripper();
		const r1 = s.push("\x1b[3");
		expect(r1).toBe("");
		const r2 = s.push("1mred\x1b[0m");
		expect(r2).toBe("red");
	});

	it("held tracks pending bytes", () => {
		const s = new AnsiStripper();
		s.push("\x1b[3");
		expect(s.held).toBeGreaterThan(0);
	});

	it("pending returns stripped pending text", () => {
		const s = new AnsiStripper();
		s.push("\x1b[3");
		// pending is the stripped version of the open fragment
		expect(typeof s.pending).toBe("string");
	});

	it("handles multiple chunks", () => {
		const s = new AnsiStripper();
		expect(s.push("hello ")).toBe("hello ");
		expect(s.push("world")).toBe("world");
	});

	it("handles empty chunk", () => {
		const s = new AnsiStripper();
		expect(s.push("")).toBe("");
	});

	it("strips C1 8-bit sequences", () => {
		const s = new AnsiStripper();
		// C1 introducer \x9b (CSI) equivalent
		expect(s.push("\x9b31mred\x1b[0m")).toBe("red");
	});
});

describe("escapeTerminalText", () => {
	it("returns plain text unchanged", () => {
		expect(escapeTerminalText("hello world")).toBe("hello world");
	});

	it("escapes NUL", () => {
		expect(escapeTerminalText("a\x00b")).toBe("a\\u0000b");
	});

	it("escapes BEL", () => {
		expect(escapeTerminalText("a\x07b")).toBe("a\\u0007b");
	});

	it("escapes ESC", () => {
		expect(escapeTerminalText("a\x1bb")).toBe("a\\u001Bb");
	});

	it("escapes DEL", () => {
		expect(escapeTerminalText("a\x7Fb")).toBe("a\\u007Fb");
	});

	it("escapes C1 controls", () => {
		expect(escapeTerminalText("a\x9bb")).toBe("a\\u009Bb");
	});

	it("escapes line separator U+2028", () => {
		expect(escapeTerminalText("a\u2028b")).toBe("a\\u2028b");
	});

	it("escapes paragraph separator U+2029", () => {
		expect(escapeTerminalText("a\u2029b")).toBe("a\\u2029b");
	});

	it("escapes newlines and tabs as C0 controls", () => {
		expect(escapeTerminalText("hello\n\tworld")).toBe("hello\\u000A\\u0009world");
	});

	it("preserves printable ASCII", () => {
		expect(escapeTerminalText("ABC123!@#")).toBe("ABC123!@#");
	});

	it("preserves Unicode text", () => {
		expect(escapeTerminalText("你好世界")).toBe("你好世界");
	});

	it("preserves emoji", () => {
		expect(escapeTerminalText("hello 😀 world")).toBe("hello 😀 world");
	});

	it("escapes lone high surrogate", () => {
		expect(escapeTerminalText("\uD800")).toBe("\\uD800");
	});

	it("escapes lone low surrogate", () => {
		expect(escapeTerminalText("\uDC00")).toBe("\\uDC00");
	});

	it("preserves valid surrogate pairs (non-format)", () => {
		// 😀 = U+1F600, not a format character
		expect(escapeTerminalText("😀")).toBe("😀");
	});

	it("handles empty string", () => {
		expect(escapeTerminalText("")).toBe("");
	});

	it("escapes tab as C0 control", () => {
		expect(escapeTerminalText("\t")).toBe("\\u0009");
	});

	it("escapes backspace", () => {
		expect(escapeTerminalText("\x08")).toBe("\\u0008");
	});

	it("escapes form feed", () => {
		expect(escapeTerminalText("\x0C")).toBe("\\u000C");
	});
});

describe("time constants", () => {
	it("SECOND_MS is 1000", () => {
		expect(SECOND_MS).toBe(1000);
	});

	it("MINUTE_MS is 60000", () => {
		expect(MINUTE_MS).toBe(60_000);
	});

	it("HOUR_MS is 3600000", () => {
		expect(HOUR_MS).toBe(3_600_000);
	});

	it("DAY_MS is 86400000", () => {
		expect(DAY_MS).toBe(86_400_000);
	});

	it("WEEK_MS is 604800000", () => {
		expect(WEEK_MS).toBe(604_800_000);
	});

	it("MINUTE_MS = 60 * SECOND_MS", () => {
		expect(MINUTE_MS).toBe(60 * SECOND_MS);
	});

	it("HOUR_MS = 60 * MINUTE_MS", () => {
		expect(HOUR_MS).toBe(60 * MINUTE_MS);
	});

	it("DAY_MS = 24 * HOUR_MS", () => {
		expect(DAY_MS).toBe(24 * HOUR_MS);
	});

	it("WEEK_MS = 7 * DAY_MS", () => {
		expect(WEEK_MS).toBe(7 * DAY_MS);
	});
});
