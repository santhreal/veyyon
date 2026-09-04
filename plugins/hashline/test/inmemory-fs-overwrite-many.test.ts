import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem } from "@veyyon/hashline";

/**
 * InMemoryFilesystem many overwrites leave last content.
 */

describe("InMemoryFilesystem many overwrites", () => {
	it("100 sequential overwrites leave the last body", () => {
		const mem = new InMemoryFilesystem([["a.ts", "v0\n"]]);
		for (let i = 1; i <= 100; i++) {
			mem.set("a.ts", `v${i}\n`);
		}
		expect(mem.get("a.ts")).toBe("v100\n");
	});

	it("independent paths do not clobber each other", () => {
		const mem = new InMemoryFilesystem();
		for (let i = 0; i < 50; i++) {
			mem.set(`f${i}.ts`, `body-${i}\n`);
		}
		for (let i = 0; i < 50; i++) {
			expect(mem.get(`f${i}.ts`)).toBe(`body-${i}\n`);
		}
	});
});
