import { describe, expect, it } from "bun:test";
import { computeFileHash, formatHashlineHeader } from "@veyyon/hashline";

/**
 * formatHashlineHeader property: bracket wrap and hash embedding.
 */

describe("formatHashlineHeader property", () => {
	const paths = ["a.ts", "src/b.ts", "/abs/c.ts", "deep/nested/x.ts", "file-name_1.ts", "日本語.ts", "a.b.c.ts"];

	it("always wraps as [path#hash] for many paths and contents", () => {
		for (const p of paths) {
			for (let i = 0; i < 10; i++) {
				const body = `${p}\n${i}\n`;
				const h = computeFileHash(body);
				const header = formatHashlineHeader(p, h);
				expect(header).toBe(`[${p}#${h}]`);
				expect(header.startsWith("[")).toBe(true);
				expect(header.endsWith("]")).toBe(true);
				const m = /#([0-9A-Fa-f]{4})\]$/.exec(header);
				expect(m?.[1]?.toLowerCase()).toBe(h.toLowerCase());
			}
		}
	});

	it("different paths with same hash still embed the given path", () => {
		const h = "abcd";
		expect(formatHashlineHeader("a.ts", h)).toBe("[a.ts#abcd]");
		expect(formatHashlineHeader("b.ts", h)).toBe("[b.ts#abcd]");
	});
});
