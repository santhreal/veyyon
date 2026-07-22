import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem } from "@veyyon/hashline";

/**
 * InMemoryFilesystem large body get/set.
 */

describe("InMemoryFilesystem large body", () => {
	it("round-trips a 100k character body", () => {
		const mem = new InMemoryFilesystem();
		const body = "z".repeat(100_000) + "\n";
		mem.set("big.ts", body);
		expect(mem.get("big.ts")).toBe(body);
		expect(mem.get("big.ts")!.length).toBe(100_001);
	});
});
