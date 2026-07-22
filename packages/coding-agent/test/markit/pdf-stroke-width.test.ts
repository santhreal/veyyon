import { describe, expect, it } from "bun:test";
import { extractSegmentsFromContentStream } from "@veyyon/coding-agent/markit/converters/pdf/extract";

/**
 * Locks FINDING-PDF-STROKEWIDTH-ZERO-DISCARDED. The `w` (line width) operator
 * handler used `Number(token) || strokeWidth`, so `0 w` — a valid hairline that
 * PDFs commonly use for table rules — was falsy and discarded, leaving the
 * previous width in place. When that stale width exceeded MAX_THICKNESS (3),
 * flushPath("stroke") skipped the path and the hairline rules vanished from the
 * extracted segments, destroying the table grid. The fix assigns the width
 * whenever it parses to a finite number (so 0 sticks) and ignores garbage. With
 * an identity CTM the emitted segment coordinates equal the content-stream
 * operands, so these assert exact numbers.
 */
describe("extractSegmentsFromContentStream stroke width handling", () => {
	it("keeps a hairline (0 w) line even after a prior thick width", () => {
		// 5 w sets a width above MAX_THICKNESS; 0 w must reset it to a hairline so
		// the horizontal rule is extracted. Before the fix, 0 w was dropped and the
		// width stayed 5, so the stroke was skipped and this returned [].
		const segments = extractSegmentsFromContentStream("5 w 0 w 10 10 m 110 10 l S", 1);
		expect(segments).toEqual([{ id: "p1-s0", x1: 10, y1: 10, x2: 110, y2: 10 }]);
	});

	it("ignores a non-numeric width operand and keeps the previous (thin) width", () => {
		// `xyz w` is garbage: Number("xyz") is NaN, so the width stays 2 (<= 3) and
		// the rule is still extracted.
		const segments = extractSegmentsFromContentStream("2 w xyz w 10 10 m 110 10 l S", 1);
		expect(segments).toEqual([{ id: "p1-s0", x1: 10, y1: 10, x2: 110, y2: 10 }]);
	});

	it("still drops a genuinely thick stroke, proving the threshold is intact", () => {
		// 5 w stays above MAX_THICKNESS, so the stroke is not treated as a thin
		// rule. The fix must not turn into "always keep".
		const segments = extractSegmentsFromContentStream("5 w 10 10 m 110 10 l S", 1);
		expect(segments).toEqual([]);
	});

	it("extracts a vertical hairline rule set with 0 w as well", () => {
		const segments = extractSegmentsFromContentStream("4 w 0 w 20 5 m 20 105 l S", 1);
		expect(segments).toEqual([{ id: "p1-s0", x1: 20, y1: 5, x2: 20, y2: 105 }]);
	});
});
