/**
 * WHY. `elisionMarker` spelled its ellipses `…`, and `capTextBytes` splices that
 * marker into the middle of an oversized tool result which the session then
 * holds for the rest of the conversation. JSC stores a string at one byte per
 * character only while every character fits in latin1, so those two characters
 * doubled the resident cost of the entire surrounding body. Measured on a real
 * session: one 891,309-character ASCII tool result occupied 1,782,618 bytes with
 * the marker in it and 891,309 without, and across a 60-round session retained
 * string bytes fell from 115.7 MB to 64.7 MB — exactly one byte per character of
 * conversation instead of two.
 *
 * The class this closes: a truncation helper that introduces a character wider
 * than its input, taxing every other character in the body it was summarising.
 * The variant space is every function this module exports, read from the module
 * at run time, so a new helper lands here red instead of silently uncovered.
 *
 * Widening is only forbidden when the helper is the one that introduced it. A
 * caller whose own text needs more than latin1 still gets that text back
 * untouched, which is pinned below so the fix cannot degrade into mangling real
 * content.
 *
 * What it does not catch: the ad-hoc `[...N elided...]` markers built inline
 * across `coding-agent` (the read tool, the LSP output cap, the web scrapers)
 * rather than through this module — nothing forces those through this choke
 * point, so each is only as correct as its own literal. It also cannot observe
 * the byte width JSC actually chose; it pins the property that decides the
 * width, not the width itself.
 */
import { describe, expect, it } from "bun:test";
import * as byteTruncate from "../src/byte-truncate";
import { capTextBytes, elisionMarker, truncateHeadBytes, truncateTailBytes } from "../src/byte-truncate";

/** Highest code point in `text`, without materialising an array per character. */
function widestCodePoint(text: string): number {
	let widest = 0;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code > widest) widest = code;
	}
	return widest;
}

/** Large enough to force every helper here past its budget. */
const ASCII_BODY = Array.from({ length: 4_000 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
const BUDGET = 4_096;

/**
 * Every export, paired with a call that makes it truncate. Keyed by export name
 * so the coverage check below can compare against the module itself.
 */
const EXERCISED: Record<string, () => string> = {
	truncateTailBytes: () => truncateTailBytes(ASCII_BODY, BUDGET).text,
	truncateHeadBytes: () => truncateHeadBytes(ASCII_BODY, BUDGET).text,
	capTextBytes: () => capTextBytes(ASCII_BODY, BUDGET).text,
	elisionMarker: () => elisionMarker(188_726),
};

describe("a truncation helper never widens the text it marks", () => {
	it("exercises every function the module exports", () => {
		const exported = Object.entries(byteTruncate)
			.filter(([, value]) => typeof value === "function")
			.map(([name]) => name)
			.sort();

		// A new helper added to this module fails here until it is given a call
		// above. Silence would mean the invariant simply stopped applying to it.
		expect(exported).toEqual(Object.keys(EXERCISED).sort());
	});

	for (const [name, invoke] of Object.entries(EXERCISED)) {
		it(`${name} returns latin1 for latin1 input`, () => {
			expect(widestCodePoint(invoke())).toBeLessThanOrEqual(255);
		});
	}

	it("states the elided byte count without a character wider than the text it marks", () => {
		expect(elisionMarker(188_726)).toBe("[...188726B elided...]");
	});

	it("leaves a body that genuinely needs more than latin1 exactly as it was given", () => {
		// The marker is ASCII; the content is not. The helper must not normalise,
		// transliterate or drop the caller's own characters to stay narrow.
		const wide = `${"\u4e2d".repeat(4_000)}\n${"\u4e2d".repeat(4_000)}`;

		const result = capTextBytes(wide, BUDGET);

		expect(result.elidedBytes).toBeGreaterThan(0);
		expect(result.text).toContain(elisionMarker(result.elidedBytes));
		expect(result.text.startsWith("\u4e2d")).toBe(true);
		expect(widestCodePoint(result.text)).toBe(0x4e2d);
	});

	it("keeps a capped ASCII body free of the marker's own characters", () => {
		const result = capTextBytes(ASCII_BODY, BUDGET);

		// The whole point: the body was ASCII before the cap and is still ASCII
		// after it, so the marker costs its own length and nothing more.
		expect(result.elidedBytes).toBeGreaterThan(0);
		expect(widestCodePoint(result.text)).toBeLessThanOrEqual(127);
	});
});
