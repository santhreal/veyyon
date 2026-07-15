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
