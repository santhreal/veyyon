/**
 * InMemoryFilesystem exists/move/delete matrix with exact outcomes.
 */
import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem, isNotFound } from "@veyyon/hashline";

describe("InMemoryFilesystem exists/move/delete", () => {
	it("exists false then true after set", async () => {
		const fs = new InMemoryFilesystem();
		expect(await fs.exists("x")).toBe(false);
		fs.set("x", "1");
		expect(await fs.exists("x")).toBe(true);
	});

	it("move overwrites dest if present", async () => {
		const fs = new InMemoryFilesystem([
			["from", "F"],
			["to", "T"],
		]);
		await fs.move("from", "to");
		expect(fs.get("from")).toBeUndefined();
		expect(fs.get("to")).toBe("F");
	});

	it("move with content argument uses provided content", async () => {
		const fs = new InMemoryFilesystem([["from", "F"]]);
		await fs.move("from", "to", "OVERRIDE");
		expect(fs.get("to")).toBe("OVERRIDE");
		expect(fs.get("from")).toBeUndefined();
	});

	it("delete then exists false and readText isNotFound", async () => {
		const fs = new InMemoryFilesystem([["d", "z"]]);
		await fs.delete("d");
		expect(await fs.exists("d")).toBe(false);
		try {
			await fs.readText("d");
			throw new Error("expected");
		} catch (e) {
			expect(isNotFound(e)).toBe(true);
		}
	});

	it("entries lists all paths after multi-set", () => {
		const fs = new InMemoryFilesystem();
		fs.set("a", "1");
		fs.set("b", "2");
		const paths = [...fs.entries()].map(([p]) => p).sort();
		expect(paths).toEqual(["a", "b"]);
	});
});
