/**
 * formatDeleteHeader/formatReplaceHeader -> parsePatch -> applyEdits exact on n=100.
 * Why: formatter and parser must agree on every single-line and range header.
 */
import { describe, expect, it } from "bun:test";
import {
	applyEdits,
	formatDeleteHeader,
	formatReplaceHeader,
	parsePatch,
} from "@veyyon/hashline";

describe("applyEdits past 6000 format header parse apply roundtrip n100", () => {
	const n = 100;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let start = 1; start <= n; start++) {
		for (let end = start; end <= Math.min(start + 5, n); end++) {
			it(`DEL header ${start}..${end}`, () => {
				const header = formatDeleteHeader(start, end);
				const { text, firstChangedLine } = applyEdits(base, parsePatch(header).edits);
				expect(text === "" ? [] : text.split("\n")).toEqual([
					...lines.slice(0, start - 1),
					...lines.slice(end),
				]);
				expect(firstChangedLine).toBe(start);
			});

			it(`SWAP header ${start}..${end}`, () => {
				const header = formatReplaceHeader(start, end);
				const body = "+REPL";
				const { text, firstChangedLine } = applyEdits(
					base,
					parsePatch(`${header}\n${body}`).edits,
				);
				expect(text.split("\n")).toEqual([
					...lines.slice(0, start - 1),
					"REPL",
					...lines.slice(end),
				]);
				expect(firstChangedLine).toBe(start);
			});
		}
	}
});
