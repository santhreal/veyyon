import { describe, expect, it } from "bun:test";
import { ABORT_MARKER, END_PATCH_MARKER } from "../src/messages";
import { Executor } from "../src/parser";
import { Tokenizer } from "../src/tokenizer";

/** Drive a whole hashline body through a fresh tokenizer into `ex`, then end. */
function feedAll(ex: Executor, text: string): ReturnType<Executor["end"]> {
	const tok = new Tokenizer();
	for (const token of tok.tokenizeAll(text)) ex.feed(token);
	return ex.end();
}

describe("Executor streaming lifecycle", () => {
	it("reset() clears accumulated edits and re-opens a terminated executor", () => {
		const ex = new Executor();
		const first = feedAll(ex, "DEL 2");
		expect(first.edits).toHaveLength(1);
		expect(first.edits[0]).toMatchObject({ kind: "delete", anchor: { line: 2 } });

		ex.reset();
		const second = feedAll(ex, "DEL 5");
		// A fresh, single edit — not two — proving reset() dropped the DEL 2 state.
		expect(second.edits).toHaveLength(1);
		expect(second.edits[0]).toMatchObject({ kind: "delete", anchor: { line: 5 } });
		expect(second.warnings).toEqual([]);
	});

	it("stops consuming tokens after an End Patch marker terminates it", () => {
		const ex = new Executor();
		const tok = new Tokenizer();
		// DEL 2, then the envelope-end marker, then DEL 9 which must be dropped.
		for (const token of tok.tokenizeAll(`DEL 2\n${END_PATCH_MARKER}\nDEL 9`)) ex.feed(token);
		const result = ex.end();
		expect(result.edits).toHaveLength(1);
		expect(result.edits[0]).toMatchObject({ kind: "delete", anchor: { line: 2 } });
	});

	it("stops consuming tokens after an Abort marker terminates it", () => {
		const ex = new Executor();
		const tok = new Tokenizer();
		for (const token of tok.tokenizeAll(`DEL 2\n${ABORT_MARKER}\nDEL 9`)) ex.feed(token);
		expect(ex.end().edits).toHaveLength(1);
	});
});
