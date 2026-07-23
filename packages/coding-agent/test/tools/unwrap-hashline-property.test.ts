import { describe, expect, it } from "bun:test";
import { unwrapHashlineHeaderPath } from "@veyyon/coding-agent/tools/plan-mode-guard";

/**
 * unwrapHashlineHeaderPath properties over many path/tag combinations.
 */

function hex4(n: number): string {
	return (n % 0x10000).toString(16).padStart(4, "0");
}

describe("unwrapHashlineHeaderPath property-style", () => {
	it("valid [path#hex4] always unwraps to path for many paths", () => {
		const paths = ["a.ts", "src/b.ts", "/abs/c.ts", "deep/nested/x.ts", "file-name_1.ts"];
		for (const p of paths) {
			for (let i = 0; i < 20; i++) {
				const tag = hex4(i * 97 + p.length);
				expect(unwrapHashlineHeaderPath(`[${p}#${tag}]`)).toBe(p);
			}
		}
	});

	it("bare paths are identity", () => {
		for (const p of ["a.ts", "src/b.ts", "/etc/hosts", ""]) {
			expect(unwrapHashlineHeaderPath(p)).toBe(p);
		}
	});

	it("non-hex 4 tags are not unwrapped", () => {
		for (const tag of ["zzzz", "abc", "ABCDEFG", "12", "!!!!"]) {
			const wrapped = `[src/a.ts#${tag}]`;
			expect(unwrapHashlineHeaderPath(wrapped)).toBe(wrapped);
		}
	});

	it("missing brackets are not unwrapped", () => {
		expect(unwrapHashlineHeaderPath("src/a.ts#ab12")).toBe("src/a.ts#ab12");
		expect(unwrapHashlineHeaderPath("[src/a.ts#ab12")).toBe("[src/a.ts#ab12");
		expect(unwrapHashlineHeaderPath("src/a.ts#ab12]")).toBe("src/a.ts#ab12]");
	});
});
