import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem } from "@veyyon/hashline";

/**
 * InMemoryFilesystem empty string content.
 */

describe("InMemoryFilesystem empty string content", () => {
	it("stores empty string distinctly from missing", () => {
		const mem = new InMemoryFilesystem();
		mem.set("empty.ts", "");
		expect(mem.get("empty.ts")).toBe("");
		expect(mem.get("missing.ts")).toBeUndefined();
	});

	it("stores newline-only", () => {
		const mem = new InMemoryFilesystem();
		mem.set("nl.ts", "\n");
		expect(mem.get("nl.ts")).toBe("\n");
	});
});
