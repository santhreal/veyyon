/**
 * WHY. `capTextBytes` is the last defense between a runaway tool result and the request body: the
 * agent's per-result backstop (`packages/agent/src/tool-result-cap.ts`) and the coding agent's
 * inline cap (`enforceInlineByteCap`) both reduce to it. It shipped with no test of its own, so
 * every property callers rely on — that the byte accounting is exact, that the marker states the
 * real number of dropped bytes, that a multibyte sequence is never cut in half — was unpinned.
 *
 * The class this closes: silent drift in what "cut this text to N bytes" means. That covers the
 * accounting identity, the two opposite meanings this module gives a non-positive budget, the
 * share budget the two windows actually obey, and multibyte safety across a sweep of budgets
 * rather than one hand-picked value.
 *
 * Two behaviors here are pinned as they are rather than as the prose around them reads. A budget
 * too small to hold the marker produces output LARGER than the budget, which is why
 * `tool-result-cap.ts` compares sizes and keeps the original instead of capping. And a tail window
 * narrower than one line keeps a partial line, because the line-boundary trim has no newline to cut
 * on. Both are load-bearing for callers; a change to either should fail here and be argued.
 *
 * What it does not catch: how a caller chooses its budget, and the artifact-spill footer
 * `enforceInlineByteCap` appends afterwards, which is that function's own contract.
 */
import { describe, expect, it } from "bun:test";
import { capTextBytes, elisionMarker, truncateHeadBytes } from "../src/byte-truncate";

/** Numbered lines, so a retained window can be traced back to the end of the input it came from. */
function numberedLines(count: number, width: number): string {
	return Array.from({ length: count }, (_, i) => `line ${i} ${"x".repeat(width)}`).join("\n");
}

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf-8");

/** The head and tail windows either side of the marker `capTextBytes` wrote. */
function windows(result: { text: string; elidedBytes: number }): { head: string; tail: string } {
	const [head = "", tail = ""] = result.text.split(`\n${elisionMarker(result.elidedBytes)}\n`);
	return { head, tail };
}

describe("capTextBytes", () => {
	it("returns the input untouched when it already fits, and reports its true size", () => {
		const text = "one\ntwo\nthree";

		const result = capTextBytes(text, 1_000);

		expect(result).toEqual({ text, originalBytes: 13, elidedBytes: 0 });
	});

	it("treats a non-positive budget as unbounded, the opposite of the windowed helpers", () => {
		const text = numberedLines(50, 20);

		expect(capTextBytes(text, 0)).toEqual({ text, originalBytes: bytesOf(text), elidedBytes: 0 });
		expect(capTextBytes(text, -1)).toEqual({ text, originalBytes: bytesOf(text), elidedBytes: 0 });
		// Same module, same value, deliberately opposite meaning: a windowed cut of zero bytes is
		// empty, while a cap of zero means "no cap". A reader who assumes one from the other is wrong.
		expect(truncateHeadBytes(text, 0)).toEqual({ text: "", bytes: 0 });
	});

	it("holds both windows inside their shares of the budget for every budget that elides", () => {
		const violations: number[] = [];

		for (const width of [5, 20, 60, 200]) {
			const text = numberedLines(200, width);
			for (let max = 1; max <= 4_000; max += 3) {
				const result = capTextBytes(text, max);
				if (result.elidedBytes === 0) continue;
				const { head, tail } = windows(result);
				// 60% head, 25% tail, and the marker plus its two newlines is the rest.
				if (bytesOf(head) > Math.floor(max * 0.6)) violations.push(max);
				if (bytesOf(tail) > Math.floor(max * 0.25)) violations.push(max);
			}
		}

		expect(violations).toEqual([]);
	});

	it("stays inside a realistic caller budget", () => {
		const text = numberedLines(5_000, 60);

		const result = capTextBytes(text, 4_096);

		expect(result.elidedBytes).toBeGreaterThan(0);
		expect(bytesOf(result.text)).toBeLessThanOrEqual(4_096);
	});

	it("overshoots a budget too small to hold the marker, which is why the caller compares sizes", () => {
		const text = numberedLines(200, 20);

		const tiny = capTextBytes(text, 20);

		expect(bytesOf(tiny.text)).toBeGreaterThan(20);
		// The marker and its two newlines alone outweigh a budget this small, so capping grows the payload.
		expect(bytesOf(elisionMarker(tiny.elidedBytes)) + 2).toBeGreaterThan(20);
	});

	it("states the exact number of dropped bytes in a marker callers can recognise", () => {
		const text = numberedLines(200, 20);

		const result = capTextBytes(text, 500);
		const { head, tail } = windows(result);

		expect(result.originalBytes).toBe(bytesOf(text));
		expect(result.text).toContain(elisionMarker(result.elidedBytes));
		expect(result.elidedBytes).toBe(result.originalBytes - bytesOf(head) - bytesOf(tail));
		expect(result.elidedBytes).toBeGreaterThan(0);
	});

	it("keeps the real head and the real tail of the input", () => {
		const text = numberedLines(200, 20);

		const result = capTextBytes(text, 600);
		const { head, tail } = windows(result);

		expect(head.startsWith("line 0 xxxxxxxxxxxxxxxxxxxx\n")).toBe(true);
		expect(tail.endsWith("line 199 xxxxxxxxxxxxxxxxxxxx")).toBe(true);
		// The head is cut on a line boundary, so every line it keeps is a whole input line.
		const inputLines = new Set(text.split("\n"));
		expect(head.split("\n").filter(line => !inputLines.has(line))).toEqual([]);
	});

	it("keeps a partial line when the tail window is narrower than one line", () => {
		const text = numberedLines(200, 20);

		const { tail } = windows(capTextBytes(text, 97));

		// No newline fell inside the window, so there was no boundary to cut on. The tail is the
		// end of the last line rather than the whole line.
		expect(tail).toBe("199 xxxxxxxxxxxxxxxxxxxx");
		expect(text.endsWith(tail)).toBe(true);
	});

	it("never splits a multibyte sequence, across a sweep of budgets", () => {
		const text = Array.from({ length: 120 }, (_, i) => `${i} 😀 ふりがな ${"é".repeat(6)}`).join("\n");
		const damaged: number[] = [];

		for (let max = 1; max <= 2_000; max += 7) {
			if (capTextBytes(text, max).text.includes("\uFFFD")) damaged.push(max);
		}

		expect(damaged).toEqual([]);
	});

	it("reports originalBytes in bytes, not characters, for multibyte input", () => {
		const text = "😀".repeat(10);

		const result = capTextBytes(text, 1_000);

		expect(text.length).toBe(20);
		expect(result.originalBytes).toBe(40);
		expect(result.elidedBytes).toBe(0);
	});
});

describe("elisionMarker", () => {
	it("names the byte count it was given so a caller can match its own elision", () => {
		expect(elisionMarker(0)).toBe("[...0B elided...]");
		expect(elisionMarker(5_872)).toBe("[...5872B elided...]");
	});
});
