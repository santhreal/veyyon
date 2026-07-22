import { describe, expect, it } from "bun:test";
import { formatMatchLine } from "@veyyon/coding-agent/tools/match-line-format";

/**
 * formatMatchLine full matrix of match/context × plain/hashline.
 */

describe("formatMatchLine matrix", () => {
	const bodies = ["", "x", "hello world", "  spaced", "日本語", "a:b|c"];

	it("plain match always starts with * and uses |", () => {
		for (const body of bodies) {
			for (const n of [1, 10, 100, 1000]) {
				const text = formatMatchLine(n, body, true, { useHashLines: false });
				expect(text).toBe(`*${n}|${body}`);
			}
		}
	});

	it("plain context always starts with space and uses |", () => {
		for (const body of bodies) {
			for (const n of [1, 10, 100]) {
				const text = formatMatchLine(n, body, false, { useHashLines: false });
				expect(text).toBe(` ${n}|${body}`);
			}
		}
	});

	it("hashline match always starts with * and uses :", () => {
		for (const body of bodies) {
			for (const n of [1, 10, 100]) {
				const text = formatMatchLine(n, body, true, { useHashLines: true });
				expect(text).toBe(`*${n}:${body}`);
			}
		}
	});

	it("hashline context always starts with space and uses :", () => {
		for (const body of bodies) {
			for (const n of [1, 10, 100]) {
				const text = formatMatchLine(n, body, false, { useHashLines: true });
				expect(text).toBe(` ${n}:${body}`);
			}
		}
	});
});
