import { describe, expect, it } from "bun:test";
import { AnsiStripper, stripAnsi } from "../src/strip-ansi";
import { C1_MAP, HAS_ESCAPE_OR_C1, OPEN_FRAGMENT_LIMIT } from "../src/strip-ansi-helpers";

describe("stripAnsi", () => {
	it("returns plain text unchanged", () => {
		expect(stripAnsi("hello world")).toBe("hello world");
	});
	it("strips SGR color sequences", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m text")).toBe("red text");
	});
	it("strips bold and reset", () => {
		expect(stripAnsi("\x1b[1mbold\x1b[22m text")).toBe("bold text");
	});
	it("strips cursor movement", () => {
		expect(stripAnsi("\x1b[2Jhello")).toBe("hello");
	});
	it("strips OSC sequences (BEL-terminated)", () => {
		expect(stripAnsi("\x1b]0;title\x07hello")).toBe("hello");
	});
	it("strips OSC sequences (ST-terminated)", () => {
		expect(stripAnsi("\x1b]0;title\x1b\\hello")).toBe("hello");
	});
	it("strips DCS sequences", () => {
		expect(stripAnsi("\x1bPdata\x1b\\hello")).toBe("hello");
	});
	it("handles empty string", () => {
		expect(stripAnsi("")).toBe("");
	});
	it("handles string with only ANSI", () => {
		expect(stripAnsi("\x1b[31m\x1b[0m")).toBe("");
	});
	it("preserves text between sequences", () => {
		expect(stripAnsi("a\x1b[31mb\x1b[0mc")).toBe("abc");
	});
	it("handles lone ESC at end", () => {
		expect(stripAnsi("text\x1b")).toBe("text");
	});
	it("handles C1 CSI (0x9b)", () => {
		expect(stripAnsi("text\x9b31mred\x9b0m")).toBe("textred");
	});
	it("handles C1 OSC (0x9d)", () => {
		expect(stripAnsi("text\x9d0;title\x07hello")).toBe("texthello");
	});
	it("strips hyperlinks (OSC 8)", () => {
		expect(stripAnsi("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBe("link");
	});
	it("returns same reference when no escapes", () => {
		const input = "hello";
		expect(stripAnsi(input)).toBe(input);
	});
});

describe("HAS_ESCAPE_OR_C1", () => {
	it("matches ESC character", () => {
		expect(HAS_ESCAPE_OR_C1.test("\x1b")).toBe(true);
	});
	it("matches C1 CSI (0x9b)", () => {
		expect(HAS_ESCAPE_OR_C1.test("\x9b")).toBe(true);
	});
	it("does not match plain text", () => {
		expect(HAS_ESCAPE_OR_C1.test("hello")).toBe(false);
	});
});

describe("C1_MAP", () => {
	it("maps 0x90 to ESC P (DCS)", () => {
		expect(C1_MAP["\x90"]).toBe("\x1bP");
	});
	it("maps 0x9b to ESC [ (CSI)", () => {
		expect(C1_MAP["\x9b"]).toBe("\x1b[");
	});
	it("maps 0x9d to ESC ] (OSC)", () => {
		expect(C1_MAP["\x9d"]).toBe("\x1b]");
	});
	it("has 7 entries", () => {
		expect(Object.keys(C1_MAP).length).toBe(7);
	});
});

describe("OPEN_FRAGMENT_LIMIT", () => {
	it("is 64 KiB", () => {
		expect(OPEN_FRAGMENT_LIMIT).toBe(64 * 1024);
	});
});

describe("AnsiStripper", () => {
	it("strips complete sequences from chunks", () => {
		const stripper = new AnsiStripper();
		expect(stripper.push("\x1b[31mred\x1b[0m")).toBe("red");
	});
	it("handles split sequences across chunks", () => {
		const stripper = new AnsiStripper();
		const part1 = stripper.push("text\x1b[31");
		const part2 = stripper.push("mred\x1b[0m");
		expect(part1).toBe("text");
		expect(part2).toBe("red");
	});
	it("handles split OSC across chunks", () => {
		const stripper = new AnsiStripper();
		const part1 = stripper.push("text\x1b]0;tit");
		const part2 = stripper.push("le\x07more");
		expect(part1).toBe("text");
		expect(part2).toBe("more");
	});
	it("pending is empty when no open sequence", () => {
		const stripper = new AnsiStripper();
		stripper.push("hello");
		expect(stripper.pending).toBe("");
		expect(stripper.held).toBe(0);
	});
	it("pending strips ESC from incomplete sequence held in buffer", () => {
		const stripper = new AnsiStripper();
		stripper.push("text\x1b[31");
		expect(stripper.pending).toBe("[31");
		expect(stripper.held).toBe(4);
	});
	it("handles plain text without escapes", () => {
		const stripper = new AnsiStripper();
		expect(stripper.push("hello world")).toBe("hello world");
	});
	it("handles empty input", () => {
		const stripper = new AnsiStripper();
		expect(stripper.push("")).toBe("");
	});
	it("processes multiple chunks", () => {
		const stripper = new AnsiStripper();
		expect(stripper.push("hello ")).toBe("hello ");
		expect(stripper.push("\x1b[31mworld\x1b[0m")).toBe("world");
		expect(stripper.pending).toBe("");
		expect(stripper.held).toBe(0);
	});
});
