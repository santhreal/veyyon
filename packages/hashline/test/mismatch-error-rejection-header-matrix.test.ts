/**
 * MismatchError.rejectionHeader: hashRecognized false vs true wording is exact;
 * path optional; displayMessage joins header + anchored context.
 */
import { describe, expect, it } from "bun:test";
import { MismatchError } from "@veyyon/hashline";

describe("MismatchError rejection header matrix", () => {
	it("unrecognized hash message for path", () => {
		const lines = MismatchError.rejectionHeader({
			path: "src/a.ts",
			expectedFileHash: "AAAA",
			actualFileHash: "BBBB",
			fileLines: ["x"],
			hashRecognized: false,
		});
		expect(lines[0]).toBe("Edit rejected for src/a.ts: hash #AAAA is not from this session.");
		expect(lines[1]).toContain("#BBBB");
		expect(lines[1]).toContain("never invent the tag");
	});

	it("recognized drift message", () => {
		const lines = MismatchError.rejectionHeader({
			path: "f.ts",
			expectedFileHash: "1111",
			actualFileHash: "2222",
			fileLines: ["a", "b"],
			hashRecognized: true,
		});
		expect(lines[0]).toBe("Edit rejected for f.ts: file changed between read and edit.");
		expect(lines[1]).toContain("#1111");
		expect(lines[1]).toContain("#2222");
		expect(lines[1]).toContain("re-read");
	});

	it("default hashRecognized is true", () => {
		const lines = MismatchError.rejectionHeader({
			expectedFileHash: "ABCD",
			actualFileHash: "EF01",
			fileLines: [],
		});
		expect(lines[0]).toContain("file changed between read and edit");
		expect(lines[0]).not.toContain(" for ");
	});

	it("constructor message equals displayMessage without anchors", () => {
		const err = new MismatchError({
			path: "p.ts",
			expectedFileHash: "0001",
			actualFileHash: "0002",
			fileLines: ["only"],
			hashRecognized: false,
		});
		expect(err.message).toBe(err.displayMessage);
		expect(err.name).toBe("MismatchError");
		expect(err.expectedFileHash).toBe("0001");
		expect(err.actualFileHash).toBe("0002");
		expect(err.hashRecognized).toBe(false);
	});

	it("with anchors includes context lines in message", () => {
		const err = new MismatchError({
			path: "p.ts",
			expectedFileHash: "AAAA",
			actualFileHash: "BBBB",
			fileLines: ["L1", "L2", "L3", "L4", "L5"],
			anchorLines: [3],
			hashRecognized: true,
		});
		expect(err.message).toContain("L3");
		expect(err.anchorLines).toEqual([3]);
	});
});
