/**
 * WHY: a resumed read result's card is rebuilt from the result's numbered rows, and the rows are
 * scanned in place, character by character, rather than sliced and matched per line. The defect
 * class this closes is a scanner that reads a different row grammar than the one the read tool
 * writes: a leading zero taken as a number, a merged brace pair (`12-18:`) with a missing or zero end
 * accepted, a separator other than `:` or `|` accepted, a prefix run past its line, the elision row
 * or the `[…]` snapshot header misread, a line number of more digits than a double holds exactly
 * rounded differently than `Number` rounds it, or the rows read past the empty line that ends them.
 *
 * The grammar is stated below as the regular expression the scanner replaced, and every body built
 * from a set of boundary atoms, up to three per row, is restored through the shipped read codec and
 * compared with what that grammar reads: the line numbers the card stores, the card text, and
 * whether the result rebuilds a card at all.
 *
 * What it does not catch: a row longer than three atoms whose defect needs more context than that,
 * and anything about which bodies the read tool writes; `a-session-file-stores-a-read-card-once`
 * covers the bodies the tool produces.
 */

import { describe, expect, it } from "bun:test";
import { type ResolvedReadDisplay, readResultCodec } from "@veyyon/coding-agent/tools/fs/read-display";

const ROW_GRAMMAR = /^([1-9]\d*)(?:-[1-9]\d*)?[:|]/;
const ELISION_ROW = "…";

/** The rows `body` holds under the row grammar, or undefined when a row is not a numbered row. */
function grammarRows(body: string): { numbers: Array<number | null>; texts: string[] } | undefined {
	const lines = body.split("\n");
	let index = 0;
	if (lines[0]!.startsWith("[") && lines[0]!.endsWith("]")) {
		if (lines.length === 1) return undefined;
		index = 1;
	}
	const numbers: Array<number | null> = [];
	const texts: string[] = [];
	for (; index < lines.length && lines[index] !== ""; index++) {
		const line = lines[index]!;
		if (line === ELISION_ROW) {
			numbers.push(null);
			texts.push(line);
			continue;
		}
		const prefix = ROW_GRAMMAR.exec(line);
		if (!prefix) return undefined;
		numbers.push(Number(prefix[1]));
		texts.push(line.slice(prefix[0].length));
	}
	return numbers.length > 0 ? { numbers, texts } : undefined;
}

const ATOMS = ["", "0", "1", "9", "12", "-", ":", "|", "…", "[", "]", "x", "9-12", "1-", "-0", "12345678901234567890"];
const HEADERS = ["", "[a.ts#1F2E]\n", "[", "[]\n"];
const TAILS = ["", "\n", "\n\nnotice 3:x", "\n7:after"];

function* bodies(): Generator<string> {
	for (const header of HEADERS) {
		for (const a of ATOMS) {
			for (const b of ATOMS) {
				for (const c of ATOMS) {
					for (const tail of TAILS) yield `${header}${a}${b}${c}${tail}`;
				}
			}
		}
	}
}

function restored(body: string, startLine: number): ResolvedReadDisplay | undefined {
	const details: Record<string, unknown> = { displayContent: { startLine, from: "rows" } };
	readResultCodec.restore?.(details, [{ type: "text", text: body }]);
	const display = details.displayContent as ResolvedReadDisplay & { from?: string };
	return display.from === "rows" ? undefined : display;
}

describe("a resumed read's rows", () => {
	it("are numbered and drawn as the row grammar reads them, for every body of up to three atoms a row", () => {
		const outcomes = { rebuilt: 0, refused: 0, elided: 0, merged: 0, piped: 0, beyondExact: 0 };
		for (const body of bodies()) {
			const want = grammarRows(body);
			const got = restored(body, 1);
			if (want === undefined) {
				expect({ body, got }).toEqual({ body, got: undefined });
				outcomes.refused++;
				continue;
			}
			const contiguous = want.numbers.every((value, index) => value === 1 + index);
			expect({ body, text: got?.text, lineNumbers: got?.lineNumbers }).toEqual({
				body,
				text: want.texts.join("\n"),
				lineNumbers: contiguous ? undefined : want.numbers,
			});
			outcomes.rebuilt++;
			if (want.numbers.includes(null)) outcomes.elided++;
			if (/^\d+-\d+:/m.test(body)) outcomes.merged++;
			if (/^\d+\|/m.test(body)) outcomes.piped++;
			if (want.numbers.some(value => value !== null && value > Number.MAX_SAFE_INTEGER)) outcomes.beyondExact++;
		}
		// The sweep reaches each row form, and refuses as well as rebuilds.
		for (const [form, count] of Object.entries(outcomes))
			expect({ form, reached: count > 0 }).toEqual({ form, reached: true });
	});
});
