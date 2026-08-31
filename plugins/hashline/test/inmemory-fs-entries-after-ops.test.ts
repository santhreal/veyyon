/**
 * InMemoryFilesystem entries after set/delete/move.
 */
import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem } from "@veyyon/hashline";

describe("InMemoryFilesystem entries after ops", () => {
	it("set adds paths", () => {
		const fs = new InMemoryFilesystem();
		fs.set("a", "1");
		fs.set("b", "2");
		expect([...fs.entries()].map(([p]) => p).sort()).toEqual(["a", "b"]);
	});

	it("delete removes from entries", async () => {
		const fs = new InMemoryFilesystem([
			["a", "1"],
			["b", "2"],
		]);
		await fs.delete("a");
		expect([...fs.entries()].map(([p]) => p)).toEqual(["b"]);
	});

	it("move renames in entries", async () => {
		const fs = new InMemoryFilesystem([["old", "v"]]);
		await fs.move("old", "new");
		expect([...fs.entries()].map(([p]) => p)).toEqual(["new"]);
		expect(fs.get("new")).toBe("v");
	});

	it("clear empties entries", () => {
		const fs = new InMemoryFilesystem([["a", "1"]]);
		fs.clear();
		expect([...fs.entries()]).toEqual([]);
	});
});
