import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem } from "@veyyon/hashline";

/**
 * InMemoryFilesystem get/set identity properties.
 */

describe("InMemoryFilesystem get/set property", () => {
	it("set then get returns exact content for many paths", () => {
		const mem = new InMemoryFilesystem();
		for (let i = 0; i < 30; i++) {
			const p = `src/f${i}.ts`;
			const body = `export const n = ${i};\n`;
			mem.set(p, body);
			expect(mem.get(p)).toBe(body);
		}
	});

	it("overwrite replaces previous content", () => {
		const mem = new InMemoryFilesystem([["a.ts", "old\n"]]);
		expect(mem.get("a.ts")).toBe("old\n");
		mem.set("a.ts", "new\n");
		expect(mem.get("a.ts")).toBe("new\n");
	});

	it("missing path returns undefined or empty depending on API", () => {
		const mem = new InMemoryFilesystem();
		const v = mem.get("missing.ts");
		expect(v === undefined || v === null || v === "").toBe(true);
	});

	it("constructor seeds are readable", () => {
		const mem = new InMemoryFilesystem([
			["a.ts", "A\n"],
			["b.ts", "B\n"],
		]);
		expect(mem.get("a.ts")).toBe("A\n");
		expect(mem.get("b.ts")).toBe("B\n");
	});
});
