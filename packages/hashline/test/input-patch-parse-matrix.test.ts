/**
 * Patch / PatchSection top-level input: headers, multi-section, fallback path, rejects.
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash, containsRecognizableHashlineOperations, Patch } from "@veyyon/hashline";
import { HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "../src/format";

function header(path: string, hash?: string): string {
	return hash
		? `${HL_FILE_PREFIX}${path}${HL_FILE_HASH_SEP}${hash}${HL_FILE_SUFFIX}`
		: `${HL_FILE_PREFIX}${path}${HL_FILE_SUFFIX}`;
}

describe("containsRecognizableHashlineOperations", () => {
	it("true when a line is a recognizable op", () => {
		expect(containsRecognizableHashlineOperations("SWAP 1.=1:\n+x")).toBe(true);
		expect(containsRecognizableHashlineOperations("DEL 3")).toBe(true);
		expect(containsRecognizableHashlineOperations("INS.HEAD:\n+a")).toBe(true);
		expect(containsRecognizableHashlineOperations("REM")).toBe(true);
	});

	it("false for plain prose and empty", () => {
		expect(containsRecognizableHashlineOperations("")).toBe(false);
		expect(containsRecognizableHashlineOperations("hello world")).toBe(false);
		expect(containsRecognizableHashlineOperations("[path#ABCD]")).toBe(false);
	});
});

describe("Patch.parse headers and sections", () => {
	it("parses single section with hash and edits", () => {
		const h = computeFileHash("line1\nline2");
		const input = `${header("a.ts", h)}\nSWAP 1.=1:\n+Z`;
		const patch = Patch.parse(input);
		expect(patch.sections).toHaveLength(1);
		expect(patch.sections[0]?.path).toBe("a.ts");
		expect(patch.sections[0]?.fileHash).toBe(h);
		const edits = patch.sections[0]!.edits;
		expect(edits.length).toBeGreaterThan(0);
	});

	it("parses multi-section patch preserving order", () => {
		const input = [header("first.ts", "AAAA"), "DEL 1", header("second.ts", "BBBB"), "INS.TAIL:", "+x"].join("\n");
		const patch = Patch.parse(input);
		expect(patch.sections.map(s => s.path)).toEqual(["first.ts", "second.ts"]);
		expect(patch.sections[0]?.fileHash).toBe("AAAA");
		expect(patch.sections[1]?.fileHash).toBe("BBBB");
	});

	it("skips header-only sections with no ops", () => {
		const input = [header("empty.ts", "1111"), header("real.ts", "2222"), "DEL 1"].join("\n");
		const patch = Patch.parse(input);
		expect(patch.sections.map(s => s.path)).toEqual(["real.ts"]);
	});

	it("strips leading blank lines and BOM before requiring header", () => {
		const input = `\uFEFF\n\n${header("b.ts", "CAFE")}\nDEL 2`;
		const patch = Patch.parse(input);
		expect(patch.sections).toHaveLength(1);
		expect(patch.sections[0]?.path).toBe("b.ts");
	});

	it("rejects input that does not start with a header", () => {
		expect(() => Patch.parse("DEL 1")).toThrow(/must begin with/);
	});

	it("rejects unified-diff hunk header contamination", () => {
		expect(() => Patch.parse("@@ -1,2 +1,2 @@\n")).toThrow(/unified-diff hunk header/);
	});

	it("malformed bracket header throws Input header must be", () => {
		expect(() => Patch.parse("[bad#ZZ]\nDEL 1")).toThrow(/Input header must be/);
	});

	it("stops at End Patch envelope", () => {
		const input = [header("a.ts", "ABCD"), "DEL 1", "*** End Patch", header("b.ts", "EF01"), "DEL 2"].join("\n");
		const patch = Patch.parse(input);
		expect(patch.sections.map(s => s.path)).toEqual(["a.ts"]);
	});

	it("stops at Abort marker", () => {
		const input = [header("a.ts", "ABCD"), "DEL 1", "*** Abort", "DEL 9"].join("\n");
		const patch = Patch.parse(input);
		expect(patch.sections).toHaveLength(1);
		// only DEL 1 before abort
		const edits = patch.sections[0]!.edits;
		expect(edits.every(e => e.kind !== "delete" || e.anchor.line === 1)).toBe(true);
	});

	it("optional path fallback injects header when ops present without header", () => {
		const patch = Patch.parse("SWAP 1.=1:\n+X", { path: "fallback.ts" });
		expect(patch.sections).toHaveLength(1);
		expect(patch.sections[0]?.path).toBe("fallback.ts");
	});

	it("quoted paths unquote", () => {
		const patch = Patch.parse(`${header('"src/q.ts"', "1234")}\nDEL 1`);
		expect(patch.sections[0]?.path).toBe("src/q.ts");
	});

	it("section.edits is cached (same reference on second access)", () => {
		const patch = Patch.parse(`${header("c.ts", "9999")}\nINS.HEAD:\n+z`);
		const a = patch.sections[0]!.edits;
		const b = patch.sections[0]!.edits;
		expect(a).toBe(b);
	});
});
