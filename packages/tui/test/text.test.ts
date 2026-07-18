import { describe, expect, it } from "bun:test";
import { Text } from "@veyyon/tui/components/text";
import { visibleWidth } from "@veyyon/tui/utils";

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
