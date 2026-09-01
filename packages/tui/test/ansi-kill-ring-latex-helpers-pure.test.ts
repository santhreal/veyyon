import { describe, expect, it } from "bun:test";
import {
	BEL,
	CSI,
	ESC,
	OSC,
	OSC66,
	SGR_BG_RESET,
	SGR_FG_RESET,
	SGR_INTENSITY_RESET,
	SGR_RESET,
	SGR_RESET_SHORT,
	SGR_SEQUENCE_PATTERN,
	ST,
	sgrSequence,
} from "../src/ansi";
import { KillRing } from "../src/kill-ring";
import {
	ACCENTS,
	applyCombining,
	BIG_DELIM,
	codePointLength,
	FONTS,
	FUNCTIONS,
	MATH_FONT_COMMANDS,
	NOT_MAP,
	PRIMES,
	SUBSCRIPT,
	SUPERSCRIPT,
	styleChar,
	TEXT_COMMANDS,
	toSubscript,
	toSuperscript,
	unescapeText,
	VULGAR,
} from "../src/latex-to-unicode-helpers";

describe("ansi constants", () => {
	it("ESC is \\x1b", () => {
		expect(ESC).toBe("\x1b");
	});
	it("CSI is ESC[", () => {
		expect(CSI).toBe("\x1b[");
	});
	it("OSC is ESC]", () => {
		expect(OSC).toBe("\x1b]");
	});
	it("BEL is \\x07", () => {
		expect(BEL).toBe("\x07");
	});
	it("ST is ESC\\\\", () => {
		expect(ST).toBe("\x1b\\");
	});
	it("SGR_RESET is ESC[0m", () => {
		expect(SGR_RESET).toBe("\x1b[0m");
	});
	it("SGR_RESET_SHORT is ESC[m", () => {
		expect(SGR_RESET_SHORT).toBe("\x1b[m");
	});
	it("SGR_FG_RESET is ESC[39m", () => {
		expect(SGR_FG_RESET).toBe("\x1b[39m");
	});
	it("SGR_BG_RESET is ESC[49m", () => {
		expect(SGR_BG_RESET).toBe("\x1b[49m");
	});
	it("SGR_INTENSITY_RESET is ESC[22m", () => {
		expect(SGR_INTENSITY_RESET).toBe("\x1b[22m");
	});
	it("OSC66 is ESC]66;", () => {
		expect(OSC66).toBe("\x1b]66;");
	});
});

describe("SGR_SEQUENCE_PATTERN", () => {
	it("matches simple SGR reset", () => {
		expect(sgrSequence("").test("\x1b[0m")).toBe(true);
	});
	it("matches SGR with semicolons", () => {
		expect(sgrSequence("").test("\x1b[1;31m")).toBe(true);
	});
	it("matches SGR with colons", () => {
		expect(sgrSequence("").test("\x1b[38:2::255:0:0m")).toBe(true);
	});
	it("matches empty params SGR", () => {
		expect(sgrSequence("").test("\x1b[m")).toBe(true);
	});
	it("does not match non-SGR sequence", () => {
		expect(sgrSequence("").test("\x1b[2J")).toBe(false);
	});
	it("captures parameters", () => {
		const match = sgrSequence("").exec("\x1b[1;31m");
		expect(match?.[1]).toBe("1;31");
	});
	it("global flag matches multiple", () => {
		const re = sgrSequence("g");
		const matches = "\x1b[1mhello\x1b[0m".match(re);
		expect(matches?.length).toBe(2);
	});
});

describe("KillRing", () => {
	it("starts empty", () => {
		const ring = new KillRing();
		expect(ring.length).toBe(0);
		expect(ring.peek()).toBeUndefined();
	});
	it("pushes text", () => {
		const ring = new KillRing();
		ring.push("hello", { prepend: false });
		expect(ring.length).toBe(1);
		expect(ring.peek()).toBe("hello");
	});
	it("does not push empty string", () => {
		const ring = new KillRing();
		ring.push("", { prepend: false });
		expect(ring.length).toBe(0);
	});
	it("accumulates by appending", () => {
		const ring = new KillRing();
		ring.push("hello", { prepend: false });
		ring.push(" world", { prepend: false, accumulate: true });
		expect(ring.peek()).toBe("hello world");
		expect(ring.length).toBe(1);
	});
	it("accumulates by prepending", () => {
		const ring = new KillRing();
		ring.push("world", { prepend: false });
		ring.push("hello ", { prepend: true, accumulate: true });
		expect(ring.peek()).toBe("hello world");
		expect(ring.length).toBe(1);
	});
	it("does not accumulate when ring is empty", () => {
		const ring = new KillRing();
		ring.push("hello", { prepend: false, accumulate: true });
		expect(ring.peek()).toBe("hello");
		expect(ring.length).toBe(1);
	});
	it("rotate cycles entries", () => {
		const ring = new KillRing();
		ring.push("a", { prepend: false });
		ring.push("b", { prepend: false });
		ring.push("c", { prepend: false });
		ring.rotate();
		expect(ring.peek()).toBe("b");
		ring.rotate();
		expect(ring.peek()).toBe("a");
		ring.rotate();
		expect(ring.peek()).toBe("c");
	});
	it("rotate does nothing with single entry", () => {
		const ring = new KillRing();
		ring.push("a", { prepend: false });
		ring.rotate();
		expect(ring.peek()).toBe("a");
	});
	it("rotate does nothing when empty", () => {
		const ring = new KillRing();
		ring.rotate();
		expect(ring.length).toBe(0);
	});
	it("caps at MAX_ENTRIES", () => {
		const ring = new KillRing();
		for (let i = 0; i < 70; i++) ring.push(`entry${i}`, { prepend: false });
		expect(ring.length).toBe(60);
	});
});

describe("unescapeText", () => {
	it("unescapes \\&", () => {
		expect(unescapeText("hello\\&world")).toBe("hello&world");
	});
	it("unescapes \\%", () => {
		expect(unescapeText("50\\%")).toBe("50%");
	});
	it("unescapes \\$", () => {
		expect(unescapeText("\\$100")).toBe("$100");
	});
	it("unescapes \\#", () => {
		expect(unescapeText("\\#1")).toBe("#1");
	});
	it("unescapes \\_", () => {
		expect(unescapeText("hello\\_world")).toBe("hello_world");
	});
	it("unescapes \\{ and \\}", () => {
		expect(unescapeText("\\{\\}")).toBe("{}");
	});
	it("converts ~ to space", () => {
		expect(unescapeText("hello~world")).toBe("hello world");
	});
	it("unescapes \\\\s (backslash-space)", () => {
		expect(unescapeText("hello\\ world")).toBe("hello world");
	});
	it("handles plain text", () => {
		expect(unescapeText("hello world")).toBe("hello world");
	});
	it("handles empty string", () => {
		expect(unescapeText("")).toBe("");
	});
});

describe("codePointLength", () => {
	it("counts ASCII chars", () => {
		expect(codePointLength("hello")).toBe(5);
	});
	it("counts emoji as single code point", () => {
		expect(codePointLength("👋")).toBe(1);
	});
	it("counts mixed ASCII and emoji", () => {
		expect(codePointLength("hi👋")).toBe(3);
	});
	it("counts empty string as 0", () => {
		expect(codePointLength("")).toBe(0);
	});
});

describe("styleChar", () => {
	it("returns char unchanged for null style", () => {
		expect(styleChar("a", null)).toBe("a");
	});
	it("styles char with bold", () => {
		const result = styleChar("a", "bold");
		expect(result).not.toBe("a");
	});
	it("styles char with italic", () => {
		const result = styleChar("a", "italic");
		expect(result).not.toBe("a");
	});
	it("styles digit with bold", () => {
		expect(styleChar("1", "bold")).not.toBe("1");
	});
});

describe("applyCombining", () => {
	it("appends combining mark to text", () => {
		const result = applyCombining("a", "\u0301");
		expect(result).toBe("a\u0301");
	});
	it("returns empty for empty text", () => {
		expect(applyCombining("", "\u0301")).toBe("");
	});
});

describe("toSuperscript", () => {
	it("converts digits to superscript", () => {
		const result = toSuperscript("123", false);
		expect(result).not.toBe("123");
	});
	it("converts lowercase letters to superscript", () => {
		const result = toSuperscript("abc", false);
		expect(result).not.toBe("abc");
	});
});

describe("toSubscript", () => {
	it("converts digits to subscript", () => {
		const result = toSubscript("123", false);
		expect(result).not.toBe("123");
	});
});

describe("PRIMES", () => {
	it("has 5 entries", () => {
		expect(PRIMES.length).toBe(5);
	});
	it("first is empty string", () => {
		expect(PRIMES[0]).toBe("");
	});
	it("second is prime mark", () => {
		expect(PRIMES[1]).toBe("′");
	});
	it("third is double prime", () => {
		expect(PRIMES[2]).toBe("″");
	});
});

describe("SUPERSCRIPT", () => {
	it("maps 0", () => {
		expect(SUPERSCRIPT["0"]).toBe("⁰");
	});
	it("maps 1", () => {
		expect(SUPERSCRIPT["1"]).toBe("¹");
	});
	it("maps +", () => {
		expect(SUPERSCRIPT["+"]).toBe("⁺");
	});
	it("maps -", () => {
		expect(SUPERSCRIPT["-"]).toBe("⁻");
	});
});

describe("SUBSCRIPT", () => {
	it("maps 0", () => {
		expect(SUBSCRIPT["0"]).toBe("₀");
	});
	it("maps 1", () => {
		expect(SUBSCRIPT["1"]).toBe("₁");
	});
	it("maps +", () => {
		expect(SUBSCRIPT["+"]).toBe("₊");
	});
});

describe("VULGAR", () => {
	it("maps 1/2", () => {
		expect(VULGAR["1/2"]).toBe("½");
	});
	it("maps 1/4", () => {
		expect(VULGAR["1/4"]).toBe("¼");
	});
	it("maps 3/4", () => {
		expect(VULGAR["3/4"]).toBe("¾");
	});
});

describe("NOT_MAP", () => {
	it("maps = (not equal)", () => {
		expect(NOT_MAP["="]).toBeDefined();
	});
	it("maps < (not less than)", () => {
		expect(NOT_MAP["<"]).toBeDefined();
	});
	it("maps > (not greater than)", () => {
		expect(NOT_MAP[">"]).toBeDefined();
	});
	it("maps ≤ (not less or equal)", () => {
		expect(NOT_MAP["≤"]).toBeDefined();
	});
});

describe("ACCENTS", () => {
	it("maps hat", () => {
		expect(ACCENTS["hat"]).toBeDefined();
	});
	it("maps bar", () => {
		expect(ACCENTS["bar"]).toBeDefined();
	});
	it("maps dot", () => {
		expect(ACCENTS["dot"]).toBeDefined();
	});
});

describe("FUNCTIONS", () => {
	it("includes sin", () => {
		expect(FUNCTIONS["sin"]).toBe(true);
	});
	it("includes cos", () => {
		expect(FUNCTIONS["cos"]).toBe(true);
	});
	it("includes log", () => {
		expect(FUNCTIONS["log"]).toBe(true);
	});
	it("does not include foo", () => {
		expect(FUNCTIONS["foo"]).toBeUndefined();
	});
});

describe("FONTS", () => {
	it("maps mathbf to bold", () => {
		expect(FONTS["mathbf"]).toBe("bold");
	});
	it("maps mathit to italic", () => {
		expect(FONTS["mathit"]).toBe("italic");
	});
	it("maps mathbb to doublestruck", () => {
		expect(FONTS["mathbb"]).toBe("doublestruck");
	});
});

describe("MATH_FONT_COMMANDS", () => {
	it("is a Set", () => {
		expect(MATH_FONT_COMMANDS instanceof Set).toBe(true);
	});
	it("contains mathbf", () => {
		expect(MATH_FONT_COMMANDS.has("mathbf")).toBe(true);
	});
});

describe("TEXT_COMMANDS", () => {
	it("includes text", () => {
		expect(TEXT_COMMANDS["text"]).toBe(true);
	});
	it("includes textrm", () => {
		expect(TEXT_COMMANDS["textrm"]).toBe(true);
	});
	it("includes emph", () => {
		expect(TEXT_COMMANDS["emph"]).toBe(true);
	});
	it("includes mathrm", () => {
		expect(TEXT_COMMANDS["mathrm"]).toBe(true);
	});
});

describe("BIG_DELIM", () => {
	it("matches big", () => {
		expect(BIG_DELIM.test("big")).toBe(true);
	});
	it("matches Big", () => {
		expect(BIG_DELIM.test("Big")).toBe(true);
	});
	it("matches bigg", () => {
		expect(BIG_DELIM.test("bigg")).toBe(true);
	});
	it("matches Bigl", () => {
		expect(BIG_DELIM.test("Bigl")).toBe(true);
	});
	it("matches Bigr", () => {
		expect(BIG_DELIM.test("Bigr")).toBe(true);
	});
	it("does not match small", () => {
		expect(BIG_DELIM.test("small")).toBe(false);
	});
	it("does not match empty string", () => {
		expect(BIG_DELIM.test("")).toBe(false);
	});
});
