import { describe, expect, it } from "bun:test";
import { shortenPathDisplay } from "../src/path-display";

describe("shortenPathDisplay", () => {
	it("substitutes ~ for /home/<user> and /Users/<user> prefixes", () => {
		expect(shortenPathDisplay("/home/alice/projects/app/src/main.ts")).toBe("~/projects/app/src/main.ts");
		expect(shortenPathDisplay("/Users/bob/code/tool.rs")).toBe("~/code/tool.rs");
	});

	it("handles the bare home directory and non-home paths", () => {
		expect(shortenPathDisplay("/home/alice")).toBe("~");
		expect(shortenPathDisplay("/opt/data/file.txt")).toBe("/opt/data/file.txt");
		// Segment must end at a separator: /homework is not a home prefix.
		expect(shortenPathDisplay("/homework/file")).toBe("/homework/file");
	});

	it("returns empty string for empty input", () => {
		expect(shortenPathDisplay("")).toBe("");
	});

	it("middle-elides only past maxSegments, keeping first and last two segments", () => {
		const p = "/home/alice/a/b/c/d.ts"; // → "~/a/b/c/d.ts" = 5 segments
		expect(shortenPathDisplay(p, { maxSegments: 4 })).toBe("~/…/c/d.ts");
		expect(shortenPathDisplay(p, { maxSegments: 5 })).toBe("~/a/b/c/d.ts");
		expect(shortenPathDisplay("~/a/b.ts", { maxSegments: 4 })).toBe("~/a/b.ts");
	});

	it("never elides without maxSegments", () => {
		const deep = `/home/x/${"d/".repeat(20)}f.ts`;
		expect(shortenPathDisplay(deep)).toBe(`~/${"d/".repeat(20)}f.ts`);
	});
});
