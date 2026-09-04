import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	formatDeleteHeader,
	formatHashlineHeader,
	formatNumberedLine,
	formatReplaceHeader,
} from "@veyyon/hashline";

/**
 * Hashline format helpers property-style over many line numbers and paths.
 */

describe("hashline format helpers property-style", () => {
	it("formatHashlineHeader always wraps path and 4-hex hash", () => {
		const paths = ["a.ts", "src/b.ts", "/abs/c.ts", "日本語.ts", "a-b_c.d.ts"];
		for (const p of paths) {
			const h = computeFileHash(`${p}\n`);
			const header = formatHashlineHeader(p, h);
			expect(header).toBe(`[${p}#${h}]`);
			expect(header.startsWith("[")).toBe(true);
			expect(header.endsWith("]")).toBe(true);
			expect(header).toContain("#");
		}
	});

	it("formatNumberedLine embeds every line number 1..200 exactly once as prefix", () => {
		for (let n = 1; n <= 200; n++) {
			const line = formatNumberedLine(n, "body");
			expect(line.startsWith(`${n}:`)).toBe(true);
			expect(line).toBe(`${n}:body`);
		}
	});

	it("formatReplaceHeader includes both endpoints", () => {
		for (let start = 1; start <= 20; start++) {
			for (let end = start; end <= start + 5; end++) {
				const h = formatReplaceHeader(start, end);
				expect(h).toMatch(/SWAP/i);
				expect(h).toContain(String(start));
				expect(h).toContain(String(end));
			}
		}
	});

	it("formatDeleteHeader includes start", () => {
		for (let start = 1; start <= 30; start++) {
			const h = formatDeleteHeader(start, start + 2);
			expect(h).toMatch(/DEL/i);
			expect(h).toContain(String(start));
		}
	});
});
