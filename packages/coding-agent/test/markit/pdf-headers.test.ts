import { describe, expect, it } from "bun:test";
import { stripHeadersFooters } from "@veyyon/coding-agent/markit/converters/pdf/headers";
import type { PageContent, TextBox } from "@veyyon/coding-agent/markit/converters/pdf/types";

/**
 * stripHeadersFooters removes repeated top/bottom-zone text (running titles, page
 * numbers, copyright lines) so they do not pollute the markdown as false headings.
 * It mutates the pages array in place and had ZERO tests. Two properties MUST hold
 * or it either leaves noise in or eats real content:
 *
 *  - It only ever removes boxes in the top zone (midY >= 700) or bottom zone
 *    (midY <= 80). A body box that happens to repeat the header's text is kept.
 *  - A zone text is stripped when it appears on >= max(3, 20% of pages) OR on >= 8
 *    CONSECUTIVE pages (chapter headers), and only when there are >= 5 pages.
 *
 * These build synthetic pages in PDF coords (Y up) and assert exactly which boxes
 * survive.
 */

const tb = (text: string, midY: number, id: string): TextBox => ({
	id,
	text,
	bounds: { left: 0, right: 100, top: midY + 5, bottom: midY - 5 },
	pageNumber: 1,
	fontSize: 10,
	isBold: false,
});
const page = (boxes: TextBox[]): PageContent =>
	({ pageNumber: 1, textBoxes: boxes, imageBlocks: [], segments: [] }) as unknown as PageContent;
const texts = (p: PageContent): string[] => p.textBoxes.map(b => b.text);

describe("stripHeadersFooters", () => {
	it("removes a top-zone title repeated on every page but keeps the body", () => {
		const pages = [0, 1, 2, 3, 4].map(i => page([tb("Title", 720, `h${i}`), tb(`para ${i}`, 400, `b${i}`)]));
		stripHeadersFooters(pages);
		expect(texts(pages[0])).toEqual(["para 0"]);
		expect(texts(pages[4])).toEqual(["para 4"]);
	});

	it("keeps a zone text that appears on too few pages (below the 20%/min-3 threshold)", () => {
		const pages = [0, 1, 2, 3, 4].map(i =>
			page(i < 2 ? [tb("Foot", 50, `f${i}`), tb("body", 400, `b${i}`)] : [tb("body", 400, `b${i}`)]),
		);
		stripHeadersFooters(pages);
		expect(texts(pages[0])).toEqual(["Foot", "body"]);
	});

	it("never touches a body-zone box even when its text matches the running header", () => {
		const pages = [0, 1, 2, 3, 4].map(i => page([tb("Repeat", 720, `h${i}`), tb("Repeat", 400, `body${i}`)]));
		stripHeadersFooters(pages);
		// the top-zone "Repeat" is stripped, the body-zone one survives.
		expect(pages[0].textBoxes.map(b => b.id)).toEqual(["body0"]);
	});

	it("does nothing when there are fewer than 5 pages", () => {
		const pages = [0, 1, 2].map(i => page([tb("Title", 720, `h${i}`)]));
		stripHeadersFooters(pages);
		expect(texts(pages[0])).toEqual(["Title"]);
	});

	it("strips a chapter header via the 8-consecutive-page rule even below the global threshold", () => {
		// 50 pages -> global threshold max(3, floor(10)) = 10.
		// "Chap" runs on pages 0..7 (8 consecutive, gc=8 < 10) -> removed by the run rule.
		// "Rare" appears on 7 scattered pages (gc=7 < 10, run=1) -> kept.
		const pages: PageContent[] = [];
		for (let i = 0; i < 50; i++) {
			const boxes: TextBox[] = [tb(`para ${i}`, 400, `b${i}`)];
			if (i < 8) boxes.unshift(tb("Chap", 720, `c${i}`));
			if (i >= 20 && i < 34 && i % 2 === 0) boxes.unshift(tb("Rare", 720, `r${i}`));
			pages.push(page(boxes));
		}
		stripHeadersFooters(pages);
		expect(texts(pages[0])).toEqual(["para 0"]);
		expect(texts(pages[20])).toEqual(["Rare", "para 20"]);
	});
});
