import { describe, expect, it } from "bun:test";
import { Text } from "@veyyon/pi-tui/components/text";
import { visibleWidth } from "@veyyon/pi-tui/utils";

describe("Text component", () => {
	it("reports whether setText changed the stored text", () => {
		const text = new Text("a");

		expect(text.setText("a")).toBe(false);
		expect(text.setText("b")).toBe(true);
		expect(text.getText()).toBe("b");
	});

	it("streams token appends through the incremental wrap identically to a fresh render", () => {
		// The append-aware wrap cache re-wraps only the unfinished last line on
		// each setText append. Every intermediate frame must be byte-identical
		// to rendering the same accumulated text from scratch — including
		// across newline boundaries, width in play, and mid-word wraps.
		const words = "the quick brown fox jumps over the lazy dog streaming tokens into a transcript".split(" ");
		const streaming = new Text("", 1, 0);
		let accumulated = "";
		for (let t = 0; t < 300; t++) {
			accumulated += t % 17 === 0 ? `${words[t % words.length]}\n` : `${words[t % words.length]} `;
			streaming.setText(accumulated);
			const incremental = streaming.render(32);
			const fresh = new Text(accumulated, 1, 0).render(32);
			expect(incremental).toEqual(fresh);
		}
	});

	it("recovers from non-append text changes and width changes mid-stream", () => {
		const streaming = new Text("alpha beta\ngamma", 0, 0);
		expect(streaming.render(20)).toEqual(new Text("alpha beta\ngamma", 0, 0).render(20));
		// Width change invalidates the committed prefix rows.
		expect(streaming.render(9)).toEqual(new Text("alpha beta\ngamma", 0, 0).render(9));
		// A rewrite that is NOT an extension of the previous text (edited
		// history) must fall back to a full re-wrap, not reuse stale rows.
		streaming.setText("zeta\nomega tail");
		expect(streaming.render(9)).toEqual(new Text("zeta\nomega tail", 0, 0).render(9));
		// Shrinking to a strict prefix of the old text is also a non-append.
		streaming.setText("zeta");
		expect(streaming.render(9)).toEqual(new Text("zeta", 0, 0).render(9));
	});

	it("carries open SGR styling across the incremental reuse boundary", () => {
		// A color opened before a "\n" boundary must survive into re-wrapped
		// tail rows. Byte form of the restored codes may differ from a fresh
		// wrap, so compare with codes stripped (layout) and assert the live
		// rows still carry the red foreground.
		const red = "\x1b[31m";
		const reset = "\x1b[0m";
		const streaming = new Text("", 0, 0);
		streaming.setText(`${red}first line\n`);
		streaming.render(20);
		streaming.setText(`${red}first line\nstill red tail`);
		const rows = streaming.render(20);
		const freshRows = new Text(`${red}first line\nstill red tail`, 0, 0).render(20);
		const strip = (line: string) => line.replace(/\x1b\[[0-9;:]*m/g, "");
		expect(rows.map(strip)).toEqual(freshRows.map(strip));
		const tailRow = rows.find(line => line.includes("still red tail"));
		expect(tailRow).toBeDefined();
		expect(tailRow?.startsWith(red)).toBe(true);
		// And a reset before the boundary must NOT leak styling into the tail.
		streaming.setText(`${red}first line${reset}\n`);
		streaming.render(20);
		streaming.setText(`${red}first line${reset}\nplain tail`);
		const plainTail = streaming.render(20).find(line => line.includes("plain tail"));
		expect(plainTail?.includes("\x1b[31m")).toBe(false);
	});

	it("reports a stable prefix that is byte-identical between consecutive streamed renders", () => {
		// Engine contract (RenderStablePrefix): every row before the reported
		// count must hold the identical string value at the identical index in
		// the previously observed render array.
		const text = new Text("", 1, 1);
		let accumulated = "";
		let observed: readonly string[] = [];
		const words = "alpha beta gamma delta epsilon zeta".split(" ");
		for (let t = 0; t < 120; t++) {
			accumulated += t % 7 === 0 ? `${words[t % words.length]}\n` : `${words[t % words.length]} `;
			text.setText(accumulated);
			const rows = text.render(24);
			const report = text.getRenderStablePrefixRows(rows);
			expect(report).toBeGreaterThanOrEqual(0);
			expect(report).toBeLessThanOrEqual(Math.min(rows.length, observed.length || 0));
			for (let i = 0; i < report; i++) expect(rows[i]).toBe(observed[i] as string);
			observed = rows;
		}
		// Deep into the stream the settled prefix must actually be reported
		// (paddingY + committed wrapped rows), not perpetually zero.
		text.setText(`${accumulated}more`);
		const rows = text.render(24);
		expect(text.getRenderStablePrefixRows(rows)).toBeGreaterThan(rows.length - 5);
	});

	it("consuming the stable-prefix report re-bases it to the full current render", () => {
		const text = new Text("one\ntwo three four five six seven", 1, 1);
		const rows = text.render(12);
		text.getRenderStablePrefixRows(rows); // consume whatever the first render left
		// Nothing changed since the read: the whole array is now observed.
		expect(text.getRenderStablePrefixRows(text.render(12))).toBe(rows.length);
	});

	it("reports zero for an array it did not return", () => {
		// Contract guard for row-transforming subclass overrides: a report may
		// only cover the exact array the reader received.
		const text = new Text("one\ntwo", 1, 1);
		const rows = text.render(12);
		text.getRenderStablePrefixRows(rows);
		expect(text.getRenderStablePrefixRows(rows.slice())).toBe(0);
		// And the mismatch resets the accumulator, never resurrecting a claim.
		expect(text.getRenderStablePrefixRows(rows)).toBe(0);
	});

	it("drops the stable-prefix report to zero on non-append edits and width changes", () => {
		const text = new Text("alpha beta\ngamma delta", 1, 1);
		text.getRenderStablePrefixRows(text.render(20));
		// Non-append rewrite: nothing provably carries over.
		text.setText("zeta\nomega");
		expect(text.getRenderStablePrefixRows(text.render(20))).toBe(0);
		// Re-observe, then change width: every row re-pads.
		text.getRenderStablePrefixRows(text.render(20));
		expect(text.getRenderStablePrefixRows(text.render(11))).toBe(0);
	});

	it("accumulates the minimum stable prefix across renders between reads", () => {
		const text = new Text("first\nsecond", 1, 1);
		text.getRenderStablePrefixRows(text.render(20));
		// Append (keeps a prefix), then rewrite (keeps nothing) before the next
		// read: the report must be the min of the interval, i.e. zero.
		text.setText("first\nsecond third");
		text.render(20);
		text.setText("rewritten\nentirely");
		expect(text.getRenderStablePrefixRows(text.render(20))).toBe(0);
	});

	it("renders CRLF and bare-CR content without leaving a stray carriage return", () => {
		// End-to-end guard through the real render sink: a surviving `\r` would move
		// the terminal cursor to column 0 and corrupt the row. CRLF and bare CR both
		// break into clean separate lines.
		for (const src of ["First\r\nSecond", "Alpha\rBeta", "a\r\nb\rc"]) {
			const lines = new Text(src, 0, 0).render(40);
			for (const line of lines) {
				expect(line.includes("\r")).toBe(false);
				// Rows are padded to the render width; none may exceed it.
				expect(visibleWidth(line)).toBeLessThanOrEqual(40);
			}
		}
	});
});
