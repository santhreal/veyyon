import { describe, expect, it } from "bun:test";
import {
	DOUBLE_ESCAPE_WINDOW_MS,
	hasPasteText,
	isExpandable,
	LEFT_DOUBLE_TAP_MIN_GAP_MS,
	parsePythonCommandInput,
	pythonCommandPrefixLength,
	SHELL_PROMPT_COMMAND_RE,
	SHELL_PROMPT_OPERATOR_RE,
	shouldSkipHistory,
	TINY_TITLE_PROGRESS_DONE_TTL_MS,
	TINY_TITLE_PROGRESS_REVEAL_DELAY_MS,
	VEYYON_STATUS_LINE_RE,
	wrapPasteInAttachmentBlock,
} from "../src/modes/controllers/input-controller-helpers";

describe("shouldSkipHistory", () => {
	it("returns true for sensitive slash commands", () => {
		expect(shouldSkipHistory("/secret")).toBe(true);
	});

	it("returns false for non-sensitive commands", () => {
		expect(shouldSkipHistory("/help")).toBe(false);
	});

	it("returns false for plain text", () => {
		expect(shouldSkipHistory("hello world")).toBe(false);
	});
});

describe("isExpandable", () => {
	it("returns true for object with setExpanded method", () => {
		const obj = { setExpanded: () => {} };
		expect(isExpandable(obj)).toBe(true);
	});

	it("returns false for object without setExpanded", () => {
		expect(isExpandable({})).toBe(false);
	});

	it("returns false for null", () => {
		expect(isExpandable(null)).toBe(false);
	});

	it("returns false for non-object", () => {
		expect(isExpandable("string")).toBe(false);
		expect(isExpandable(42)).toBe(false);
	});

	it("returns false when setExpanded is not a function", () => {
		expect(isExpandable({ setExpanded: "not a function" })).toBe(false);
	});
});

describe("hasPasteText", () => {
	it("returns true for object with pasteText method", () => {
		const obj = { pasteText: () => {} };
		expect(hasPasteText(obj)).toBe(true);
	});

	it("returns false for object without pasteText", () => {
		expect(hasPasteText({})).toBe(false);
	});

	it("returns false for null", () => {
		expect(hasPasteText(null)).toBe(false);
	});

	it("returns false for non-object", () => {
		expect(hasPasteText("string")).toBe(false);
	});

	it("returns false when pasteText is not a function", () => {
		expect(hasPasteText({ pasteText: 42 })).toBe(false);
	});
});

describe("SHELL_PROMPT_COMMAND_RE", () => {
	it("matches cd command", () => {
		expect(SHELL_PROMPT_COMMAND_RE.test("cd /home")).toBe(true);
	});

	it("matches git command", () => {
		expect(SHELL_PROMPT_COMMAND_RE.test("git status")).toBe(true);
	});

	it("matches relative path", () => {
		expect(SHELL_PROMPT_COMMAND_RE.test("./script.sh")).toBe(true);
	});

	it("matches home path", () => {
		expect(SHELL_PROMPT_COMMAND_RE.test("~/script.sh")).toBe(true);
	});

	it("matches sudo", () => {
		expect(SHELL_PROMPT_COMMAND_RE.test("sudo apt update")).toBe(true);
	});

	it("does not match plain text", () => {
		expect(SHELL_PROMPT_COMMAND_RE.test("hello world")).toBe(false);
	});
});

describe("SHELL_PROMPT_OPERATOR_RE", () => {
	it("matches && operator", () => {
		expect(SHELL_PROMPT_OPERATOR_RE.test("cmd && cmd2")).toBe(true);
	});

	it("matches || operator", () => {
		expect(SHELL_PROMPT_OPERATOR_RE.test("cmd || cmd2")).toBe(true);
	});

	it("matches pipe operator", () => {
		expect(SHELL_PROMPT_OPERATOR_RE.test("cmd | cmd2")).toBe(true);
	});

	it("matches redirect operator", () => {
		expect(SHELL_PROMPT_OPERATOR_RE.test("cmd > file")).toBe(true);
	});

	it("matches 2>&1", () => {
		expect(SHELL_PROMPT_OPERATOR_RE.test("cmd 2>&1")).toBe(true);
	});

	it("does not match plain text", () => {
		expect(SHELL_PROMPT_OPERATOR_RE.test("hello world")).toBe(false);
	});
});

describe("VEYYON_STATUS_LINE_RE", () => {
	it("matches a veyyon status line", () => {
		expect(VEYYON_STATUS_LINE_RE.test("in: 100 out: 50 t: 1.5s tok/s: 40.0")).toBe(true);
	});

	it("matches with cache info", () => {
		expect(VEYYON_STATUS_LINE_RE.test("in: 100 out: 50 cache 1.2k t: 1.5s tok/s: 40.0")).toBe(true);
	});

	it("does not match plain text", () => {
		expect(VEYYON_STATUS_LINE_RE.test("hello world")).toBe(false);
	});
});

describe("pythonCommandPrefixLength", () => {
	it("returns 0 for text not starting with $", () => {
		expect(pythonCommandPrefixLength("hello")).toBe(0);
	});

	it("returns 1 for $ followed by space", () => {
		expect(pythonCommandPrefixLength("$ hello")).toBe(1);
	});

	it("returns 1 for $ followed by tab", () => {
		expect(pythonCommandPrefixLength("$\thello")).toBe(1);
	});

	it("returns 2 for $$ followed by space", () => {
		expect(pythonCommandPrefixLength("$$ hello")).toBe(2);
	});

	it("returns 0 for ${", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: input controller fixture contains literal ${...} syntax
		expect(pythonCommandPrefixLength("${hello}")).toBe(0);
	});

	it("returns 0 for $ followed by non-whitespace", () => {
		expect(pythonCommandPrefixLength("$hello")).toBe(0);
	});

	it("returns 0 for empty string", () => {
		expect(pythonCommandPrefixLength("")).toBe(0);
	});

	it("returns 1 for $ at end of string", () => {
		expect(pythonCommandPrefixLength("$")).toBe(1);
	});

	it("returns 2 for $$ at end of string", () => {
		expect(pythonCommandPrefixLength("$$")).toBe(2);
	});

	it("returns 0 for $$ followed by non-whitespace", () => {
		expect(pythonCommandPrefixLength("$$hello")).toBe(0);
	});
});

describe("parsePythonCommandInput", () => {
	it("parses $ prefix command", () => {
		const result = parsePythonCommandInput("$ print('hello')");
		expect(result).toEqual({ code: "print('hello')", isExcluded: false });
	});

	it("parses $$ prefix command as excluded", () => {
		const result = parsePythonCommandInput("$$ print('hello')");
		expect(result).toEqual({ code: "print('hello')", isExcluded: true });
	});

	it("returns undefined for non-$ text", () => {
		expect(parsePythonCommandInput("hello")).toBeUndefined();
	});

	it("returns undefined for ${", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: input controller fixture contains literal ${...} syntax
		expect(parsePythonCommandInput("${hello}")).toBeUndefined();
	});

	it("returns undefined for shell prompt with $ prefix", () => {
		expect(parsePythonCommandInput("$ cd /home")).toBeUndefined();
	});

	it("returns undefined for git command with $ prefix", () => {
		expect(parsePythonCommandInput("$ git status")).toBeUndefined();
	});

	it("handles $$ with shell prompt (not excluded since prefix is 2)", () => {
		const result = parsePythonCommandInput("$$ git status");
		expect(result).toEqual({ code: "git status", isExcluded: true });
	});

	it("trims whitespace from code", () => {
		const result = parsePythonCommandInput("$   print(1)  ");
		expect(result?.code).toBe("print(1)");
	});
});

describe("wrapPasteInAttachmentBlock", () => {
	it("wraps content in attachment tags", () => {
		const result = wrapPasteInAttachmentBlock("hello world");
		expect(result).toBe("<attachment>\nhello world\n</attachment>");
	});

	it("handles empty content", () => {
		const result = wrapPasteInAttachmentBlock("");
		expect(result).toBe("<attachment>\n\n</attachment>");
	});

	it("handles multiline content", () => {
		const result = wrapPasteInAttachmentBlock("line1\nline2");
		expect(result).toBe("<attachment>\nline1\nline2\n</attachment>");
	});
});

describe("timing constants", () => {
	it("TINY_TITLE_PROGRESS_DONE_TTL_MS is 3000", () => {
		expect(TINY_TITLE_PROGRESS_DONE_TTL_MS).toBe(3_000);
	});

	it("TINY_TITLE_PROGRESS_REVEAL_DELAY_MS is 1000", () => {
		expect(TINY_TITLE_PROGRESS_REVEAL_DELAY_MS).toBe(1_000);
	});

	it("LEFT_DOUBLE_TAP_MIN_GAP_MS is 40", () => {
		expect(LEFT_DOUBLE_TAP_MIN_GAP_MS).toBe(40);
	});

	it("DOUBLE_ESCAPE_WINDOW_MS is 500", () => {
		expect(DOUBLE_ESCAPE_WINDOW_MS).toBe(500);
	});
});
