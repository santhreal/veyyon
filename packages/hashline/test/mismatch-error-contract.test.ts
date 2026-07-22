/**
 * MismatchError and parseTag/validateLineRef are the fail-closed hash contract.
 * Tests assert exact headers, anchor context, and parse rejection shapes.
 */
import { describe, expect, it } from "bun:test";
import {
	formatFullAnchorRequirement,
	MismatchError,
	parseTag,
	validateLineRef,
} from "../src/mismatch";
import { HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "../src/format";

describe("parseTag", () => {
	it("accepts bare line numbers and decorated anchors", () => {
		expect(parseTag("42")).toEqual({ line: 42 });
		expect(parseTag("  7  ")).toEqual({ line: 7 });
		expect(parseTag("*42:foo")).toEqual({ line: 42 });
		expect(parseTag(" > 7")).toEqual({ line: 7 });
		expect(parseTag("+3:body")).toEqual({ line: 3 });
		expect(parseTag("- 99")).toEqual({ line: 99 });
	});

	it("rejects non-numeric and zero line refs; leading - is decoration not a sign", () => {
		expect(() => parseTag("nope")).toThrow(/Invalid line reference/);
		expect(() => parseTag("")).toThrow(/Invalid line reference/);
		expect(() => parseTag("0")).toThrow(/Line number must be >= 1/);
		// LINE_REF_RE treats a leading `-` as optional decoration (list/diff bullet),
		// so "-1" parses as line 1 — same as "*1" / ">1".
		expect(parseTag("-1")).toEqual({ line: 1 });
	});

	it("formatFullAnchorRequirement names shape and optional received", () => {
		const base = formatFullAnchorRequirement();
		expect(base).toContain("bare line number");
		expect(base).toContain(HL_FILE_PREFIX);
		expect(base).toContain(HL_FILE_HASH_SEP);
		expect(base).toContain(HL_FILE_SUFFIX);
		expect(base).not.toContain("Received");

		const withRaw = formatFullAnchorRequirement("xyz");
		expect(withRaw).toContain('Received "xyz"');
	});
});

describe("validateLineRef", () => {
	it("accepts in-range lines", () => {
		expect(() => validateLineRef({ line: 1 }, ["a"])).not.toThrow();
		expect(() => validateLineRef({ line: 2 }, ["a", "b"])).not.toThrow();
	});

	it("throws with exact bounds for out-of-range", () => {
		expect(() => validateLineRef({ line: 0 }, ["a"])).toThrow("Line 0 does not exist (file has 1 lines)");
		expect(() => validateLineRef({ line: 3 }, ["a", "b"])).toThrow("Line 3 does not exist (file has 2 lines)");
	});
});

describe("MismatchError", () => {
	const fileLines = ["one", "two", "three", "four", "five"];

	it("recognized drift header points at prior-edit or re-read recovery", () => {
		const err = new MismatchError({
			path: "src/a.ts",
			expectedFileHash: "AAAA",
			actualFileHash: "BBBB",
			fileLines,
			anchorLines: [3],
			hashRecognized: true,
		});
		expect(err.name).toBe("MismatchError");
		expect(err.path).toBe("src/a.ts");
		expect(err.expectedFileHash).toBe("AAAA");
		expect(err.actualFileHash).toBe("BBBB");
		expect(err.hashRecognized).toBe(true);
		expect(err.message).toContain("file changed between read and edit");
		expect(err.message).toContain(`${HL_FILE_HASH_SEP}AAAA`);
		expect(err.message).toContain(`${HL_FILE_HASH_SEP}BBBB`);
		expect(err.message).toContain("*3:three");
		expect(err.displayMessage).toBe(err.message);
	});

	it("unrecognized hash header forbids inventing or reusing prior-session tags", () => {
		const err = new MismatchError({
			path: "x.ts",
			expectedFileHash: "DEAD",
			actualFileHash: "BEEF",
			fileLines: ["only"],
			hashRecognized: false,
		});
		expect(err.hashRecognized).toBe(false);
		expect(err.message).toContain("is not from this session");
		expect(err.message).toContain("never invent the tag");
		expect(err.message).toContain(`${HL_FILE_HASH_SEP}DEAD`);
		expect(err.message).toContain(`${HL_FILE_HASH_SEP}BEEF`);
	});

	it("defaults hashRecognized to true for backward-compatible callers", () => {
		const err = new MismatchError({
			expectedFileHash: "1111",
			actualFileHash: "2222",
			fileLines: [],
		});
		expect(err.hashRecognized).toBe(true);
		expect(err.anchorLines).toEqual([]);
		expect(err.path).toBeUndefined();
		expect(err.message).toContain("file changed between read and edit");
		expect(err.message).not.toContain("*");
	});

	it("rejectionHeader without path omits for-path clause", () => {
		const lines = MismatchError.rejectionHeader({
			expectedFileHash: "ABCD",
			actualFileHash: "EF01",
			fileLines: [],
		});
		expect(lines[0]).toBe("Edit rejected: file changed between read and edit.");
		expect(lines[0]).not.toContain(" for ");
	});

	it("rejectionHeader with path includes path", () => {
		const lines = MismatchError.rejectionHeader({
			path: "p.ts",
			expectedFileHash: "ABCD",
			actualFileHash: "EF01",
			fileLines: [],
			hashRecognized: false,
		});
		expect(lines[0]).toContain(" for p.ts");
		expect(lines[0]).toContain("not from this session");
	});

	it("embeds multi-anchor context with ellipsis between distant windows", () => {
		const long = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
		const err = new MismatchError({
			expectedFileHash: "0000",
			actualFileHash: "FFFF",
			fileLines: long,
			anchorLines: [2, 18],
		});
		expect(err.message).toContain("*2:L2");
		expect(err.message).toContain("*18:L18");
		expect(err.message).toContain("...");
	});
});
