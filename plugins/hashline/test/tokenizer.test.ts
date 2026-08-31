import { describe, expect, it } from "bun:test";
import { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER } from "../src/messages";
import { parseLid, splitHashlineLines, Tokenizer } from "../src/tokenizer";

describe("splitHashlineLines", () => {
	it("returns a single empty line for empty input", () => {
		expect(splitHashlineLines("")).toEqual([""]);
	});

	it("splits on LF and drops the separators", () => {
		expect(splitHashlineLines("a\nb\nc")).toEqual(["a", "b", "c"]);
	});

	it("strips a trailing CR from each CRLF-terminated line", () => {
		expect(splitHashlineLines("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
	});

	it("keeps a trailing final line that has no newline", () => {
		expect(splitHashlineLines("a\nb")).toEqual(["a", "b"]);
	});

	it("yields a trailing empty line when the text ends with a newline", () => {
		expect(splitHashlineLines("a\n")).toEqual(["a"]);
		expect(splitHashlineLines("a\n\n")).toEqual(["a", ""]);
	});

	it("strips a lone trailing CR on the final unterminated line", () => {
		expect(splitHashlineLines("a\nb\r")).toEqual(["a", "b"]);
	});
});

describe("parseLid", () => {
	it("parses a bare line-number anchor", () => {
		expect(parseLid("119", 1)).toEqual({ line: 119 });
	});

	it("tolerates surrounding whitespace", () => {
		expect(parseLid("  42  ", 1)).toEqual({ line: 42 });
	});

	it("throws on a non-numeric anchor, naming the offending input", () => {
		expect(() => parseLid("abc", 7)).toThrow(/line 7:/);
		expect(() => parseLid("abc", 7)).toThrow(/"abc"/);
	});

	it("throws on trailing garbage after the number", () => {
		expect(() => parseLid("42x", 3)).toThrow(/line 3:/);
	});

	it("throws on a leading zero (line numbers are non-zero)", () => {
		expect(() => parseLid("0", 1)).toThrow();
	});
});

describe("Tokenizer classification helpers", () => {
	const tok = new Tokenizer();

	it("isHeader recognizes a [path#hash] header and rejects plain text", () => {
		expect(tok.isHeader("[src/foo.ts#1A2B]")).toBe(true);
		expect(tok.isHeader("just some code")).toBe(false);
	});

	it("isEnvelopeMarker recognizes begin/end/abort markers and nothing else", () => {
		expect(tok.isEnvelopeMarker(BEGIN_PATCH_MARKER)).toBe(true);
		expect(tok.isEnvelopeMarker(END_PATCH_MARKER)).toBe(true);
		expect(tok.isEnvelopeMarker(ABORT_MARKER)).toBe(true);
		expect(tok.isEnvelopeMarker("*** Something Else")).toBe(false);
		expect(tok.isEnvelopeMarker("plain line")).toBe(false);
	});

	it("isOp recognizes a SWAP hunk header and rejects prose", () => {
		expect(tok.isOp("SWAP 10.=10:")).toBe(true);
		expect(tok.isOp("not an op")).toBe(false);
	});
});

describe("Tokenizer streaming", () => {
	it("tokenizeAll classifies every line of a multi-line document", () => {
		const tokens = new Tokenizer().tokenizeAll(`${BEGIN_PATCH_MARKER}\n[src/foo.ts#1A2B]\nplain code\n`);
		expect(tokens.map(t => t.kind)).toEqual(["envelope-begin", "header", "raw"]);
		const header = tokens[1];
		if (header.kind !== "header") throw new Error("expected header token");
		expect(header.path).toBe("src/foo.ts");
		expect(header.fileHash).toBe("1A2B");
	});

	it("tokenizeAll emits the final unterminated line via end()", () => {
		const tokens = new Tokenizer().tokenizeAll("first\nlast-no-newline");
		expect(tokens.map(t => t.kind)).toEqual(["raw", "raw"]);
		expect(tokens).toHaveLength(2);
	});

	it("assigns increasing 1-based line numbers across the stream", () => {
		const tokens = new Tokenizer().tokenizeAll("a\nb\nc");
		expect(tokens.map(t => t.lineNum)).toEqual([1, 2, 3]);
	});

	it("feed after end() throws until reset() clears the closed flag", () => {
		const t = new Tokenizer();
		t.feed("line one\n");
		t.end();
		expect(() => t.feed("more")).toThrow(/closed/);
		t.reset();
		// reset() re-opens the tokenizer and restarts line numbering at 1.
		const tokens = t.tokenizeAll("fresh");
		expect(tokens).toHaveLength(1);
		expect(tokens[0].lineNum).toBe(1);
	});

	it("end() is idempotent and returns nothing once closed", () => {
		const t = new Tokenizer();
		t.feed("only\n");
		t.end();
		expect(t.end()).toEqual([]);
	});
});
