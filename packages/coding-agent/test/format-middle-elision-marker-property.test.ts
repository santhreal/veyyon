/**
 * formatMiddleElisionMarker: lines<=1 uses bytes form; lines>=2 uses ln form.
 * Exact strings for the operator-visible marker.
 */
import { describe, expect, it } from "bun:test";
import { formatMiddleElisionMarker } from "@veyyon/coding-agent/session/streaming-output";

describe("formatMiddleElisionMarker property", () => {
	for (const bytes of [0, 1, 10, 512, 4096, 1_000_000]) {
		it(`0 lines → bytes form (${bytes})`, () => {
			expect(formatMiddleElisionMarker(0, bytes)).toBe(`[…${bytes}B elided…]`);
		});
		it(`1 line → bytes form (${bytes})`, () => {
			expect(formatMiddleElisionMarker(1, bytes)).toBe(`[…${bytes}B elided…]`);
		});
	}

	for (const lines of [2, 3, 10, 123, 9999]) {
		for (const bytes of [0, 99]) {
			it(`${lines}ln ignores bytes=${bytes}`, () => {
				expect(formatMiddleElisionMarker(lines, bytes)).toBe(`[…${lines}ln elided…]`);
			});
		}
	}

	it("negative lines treated as <=1 byte form", () => {
		expect(formatMiddleElisionMarker(-1, 50)).toBe("[…50B elided…]");
	});
});
