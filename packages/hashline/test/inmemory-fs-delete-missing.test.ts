import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem } from "@veyyon/hashline";

/**
 * InMemoryFilesystem missing path behavior.
 */

describe("InMemoryFilesystem missing path", () => {
	it("get missing returns undefined", () => {
		const mem = new InMemoryFilesystem([["a.ts", "A\n"]]);
		expect(mem.get("missing.ts")).toBeUndefined();
		expect(mem.get("a.ts")).toBe("A\n");
	});

	it("set then get missing becomes defined", () => {
		const mem = new InMemoryFilesystem();
		expect(mem.get("new.ts")).toBeUndefined();
		mem.set("new.ts", "x\n");
		expect(mem.get("new.ts")).toBe("x\n");
	});
});
