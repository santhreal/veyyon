/**
 * WHY: the PDF content-stream tokenizer read a `<` as a dictionary opener when the next byte was `<` and
 * as a hex-string opener when it was anything else, but only while a next byte existed. A `<` that ended
 * the stream matched neither, the token reader stopped at it without consuming it, and the loop spun
 * forever: converting a PDF whose page content ended in `<` never returned.
 *
 * The class is a byte the tokenizer dispatches on that some branch leaves unconsumed. The sweep feeds
 * every ASCII byte, alone and in every two-byte pair, after each tokenizer state a stream can leave
 * behind, plus every three-byte run of bytes that are not letters or digits, so a byte the dispatch
 * gains later is swept with no list to update. The sweep runs in a child process with a timeout, because
 * a spinning tokenizer holds the thread that would report a test timeout.
 *
 * Not caught: a stall that needs four or more specific bytes in a row, or one on a character above
 * U+007F other than the three swept.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

const MODULE = new URL("../../../src/export/markit/converters/pdf/extract.ts", import.meta.url).pathname;
/** The sweep takes well under a second; the bound only has to end a spinning child. */
const CHILD_TIMEOUT_MS = 20_000;

const SWEEP = `
import { extractSegmentsFromContentStream as extract } from ${JSON.stringify(MODULE)};
const bytes = [];
for (let code = 0; code < 128; code++) bytes.push(String.fromCharCode(code));
bytes.push("\\u00a0", "\\u00e9", "\\uffff");
const loose = bytes.filter(byte => !/[A-Za-z0-9]/.test(byte));
// Plain, inside a graphics state, inside inline image data, and after a string, a hex string and an operand.
for (const prefix of ["", "q ", "BI ID ", "(a) <4> 10 10 m "]) {
	for (const a of bytes) {
		extract(prefix + a, 1);
		for (const b of bytes) extract(prefix + a + b, 1);
	}
}
for (const a of loose) for (const b of loose) for (const c of loose) extract(a + b + c, 1);
console.log(JSON.stringify(extract("10 10 m 110 10 l S <", 1)));
console.log(JSON.stringify(extract("10 10 m 110 10 l S <4865", 1)));
`;

describe("the PDF content-stream tokenizer", () => {
	it(
		"reads a stream ending in any byte to its end and keeps the operators before it",
		() => {
			// `cwd` pinned: the child otherwise inherits this process's cwd, which an earlier suite in the same
			// run can leave pointing at a temp directory it has since deleted.
			const child = spawnSync(process.execPath, ["-e", SWEEP], {
				cwd: import.meta.dirname,
				encoding: "utf8",
				timeout: CHILD_TIMEOUT_MS,
			});
			expect({ signal: child.signal, status: child.status, stderr: child.stderr }).toEqual({
				signal: null,
				status: 0,
				stderr: "",
			});
			const line = [{ id: "p1-s0", x1: 10, y1: 10, x2: 110, y2: 10 }];
			expect(
				child.stdout
					.trim()
					.split("\n")
					.map(row => JSON.parse(row)),
			).toEqual([line, line]);
		},
		CHILD_TIMEOUT_MS + 10_000,
	);
});
