import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem } from "@veyyon/hashline";

/**
 * Empty InMemoryFilesystem constructor behavior.
 */

describe("InMemoryFilesystem empty constructor", () => {
	it("starts with no paths", () => {
		const mem = new InMemoryFilesystem();
		expect(mem.get("anything.ts")).toBeUndefined();
	});

	it("empty seed array is fine", () => {
		const mem = new InMemoryFilesystem([]);
		expect(mem.get("x")).toBeUndefined();
		mem.set("x", "y\n");
		expect(mem.get("x")).toBe("y\n");
	});
});
