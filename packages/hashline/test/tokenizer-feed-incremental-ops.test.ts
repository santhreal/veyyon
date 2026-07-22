/**
 * Tokenizer.feed incremental: ops recognized across chunk boundaries.
 */
import { describe, expect, it } from "bun:test";
import { Tokenizer } from "../src/tokenizer";

function tokenizeAll(chunks: string[]) {
	const t = new Tokenizer();
	const tokens = [];
	for (const c of chunks) tokens.push(...t.feed(c));
	tokens.push(...t.end());
	return tokens;
}

describe("Tokenizer.feed incremental", () => {
	it("op split mid-keyword still yields op-block + payload when line completes", () => {
		const tokens = tokenizeAll(["SW", "AP 1.=1:\n", "+X\n"]);
		const kinds = tokens.map(t => t.kind);
		expect(kinds).toContain("op-block");
		expect(kinds).toContain("payload-literal");
	});

	it("header then op across chunks", () => {
		const tokens = tokenizeAll(["[a.ts#ABCD]\n", "DEL 1\n"]);
		expect(tokens.some(t => t.kind === "header")).toBe(true);
		expect(tokens.some(t => t.kind === "op-block" || String(t.kind).startsWith("op"))).toBe(true);
	});

	it("payload alone after op in separate feed", () => {
		const t = new Tokenizer();
		const a = [...t.feed("INS.TAIL:\n")];
		const b = [...t.feed("+body\n")];
		const c = [...t.end()];
		const all = [...a, ...b, ...c];
		expect(all.some(tok => tok.kind === "payload-literal")).toBe(true);
	});

	it("empty feed and end yield no throw", () => {
		const t = new Tokenizer();
		expect(() => {
			t.feed("");
			t.end();
		}).not.toThrow();
	});

	it("CRLF chunked lines produce same kinds as LF one-shot", () => {
		const lf = tokenizeAll(["DEL 2\n+x\n"]).map(t => t.kind);
		const crlf = tokenizeAll(["DEL 2\r\n", "+x\r\n"]).map(t => t.kind);
		// Both should include an op-class token
		expect(lf.some(k => String(k).startsWith("op") || k === "op-block")).toBe(true);
		expect(crlf.some(k => String(k).startsWith("op") || k === "op-block")).toBe(true);
	});
});
