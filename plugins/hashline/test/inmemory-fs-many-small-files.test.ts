import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem } from "@veyyon/hashline";

/**
 * InMemoryFilesystem with many small files.
 */

describe("InMemoryFilesystem many small files", () => {
	it("stores and retrieves 200 files", () => {
		const mem = new InMemoryFilesystem();
		for (let i = 0; i < 200; i++) {
			mem.set(`f${i}.ts`, `${i}\n`);
		}
		for (let i = 0; i < 200; i++) {
			expect(mem.get(`f${i}.ts`)).toBe(`${i}\n`);
		}
	});
});
