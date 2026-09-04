/**
 * InMemoryFilesystem path isolation: get/set/delete, missing, overwrite.
 */
import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem } from "@veyyon/hashline";

describe("InMemoryFilesystem path matrix", () => {
	it("constructor seeds are readable by exact path", () => {
		const fs = new InMemoryFilesystem([
			["a.ts", "A"],
			["dir/b.ts", "B"],
		]);
		expect(fs.get("a.ts")).toBe("A");
		expect(fs.get("dir/b.ts")).toBe("B");
	});

	it("set then get returns exact bytes including empty string", () => {
		const fs = new InMemoryFilesystem();
		fs.set("e.ts", "");
		expect(fs.get("e.ts")).toBe("");
		fs.set("e.ts", "nonempty");
		expect(fs.get("e.ts")).toBe("nonempty");
	});

	it("paths are isolated: writing one does not touch another", () => {
		const fs = new InMemoryFilesystem([
			["x", "1"],
			["y", "2"],
		]);
		fs.set("x", "changed");
		expect(fs.get("x")).toBe("changed");
		expect(fs.get("y")).toBe("2");
	});

	it("delete removes path; subsequent get is missing", async () => {
		const fs = new InMemoryFilesystem([["d.ts", "z"]]);
		await fs.delete("d.ts");
		expect(fs.get("d.ts")).toBeUndefined();
	});

	it("unicode path and content round-trip", () => {
		const fs = new InMemoryFilesystem();
		const p = "日本語/ファイル.ts";
		const body = "const ☃ = 'café';\n";
		fs.set(p, body);
		expect(fs.get(p)).toBe(body);
	});

	it("many paths property: N independent set/get", () => {
		const fs = new InMemoryFilesystem();
		const n = 50;
		for (let i = 0; i < n; i++) {
			fs.set(`f${i}.ts`, `content-${i}`);
		}
		for (let i = 0; i < n; i++) {
			expect(fs.get(`f${i}.ts`)).toBe(`content-${i}`);
		}
	});

	it("writeText/readText async API matches set/get", async () => {
		const fs = new InMemoryFilesystem();
		await fs.writeText("w.ts", "via-writeText");
		expect(await fs.readText("w.ts")).toBe("via-writeText");
		expect(fs.get("w.ts")).toBe("via-writeText");
	});

	it("move relocates content", async () => {
		const fs = new InMemoryFilesystem([["src.ts", "body"]]);
		await fs.move("src.ts", "dst.ts");
		expect(fs.get("src.ts")).toBeUndefined();
		expect(fs.get("dst.ts")).toBe("body");
	});

	it("clear empties the store", () => {
		const fs = new InMemoryFilesystem([["a", "1"]]);
		fs.clear();
		expect(fs.get("a")).toBeUndefined();
		expect([...fs.entries()]).toEqual([]);
	});
});
