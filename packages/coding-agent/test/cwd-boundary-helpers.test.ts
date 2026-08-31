import { describe, expect, it } from "bun:test";
import {
	type CwdBoundedTool,
	cwdEscapingTargets,
	formatCwdBoundaryReason,
	hasFilesystemTargets,
	searchPathFilesystemTargets,
} from "../src/tools/cwd-boundary";

describe("hasFilesystemTargets", () => {
	it("returns true for object with filesystemTargets method", () => {
		const tool = { filesystemTargets: () => [] };
		expect(hasFilesystemTargets(tool)).toBe(true);
	});

	it("returns false for object without filesystemTargets", () => {
		expect(hasFilesystemTargets({})).toBe(false);
	});

	it("returns false for null", () => {
		expect(hasFilesystemTargets(null)).toBe(false);
	});

	it("returns false for non-object", () => {
		expect(hasFilesystemTargets("string")).toBe(false);
	});

	it("returns false when filesystemTargets is not a function", () => {
		expect(hasFilesystemTargets({ filesystemTargets: "not a function" })).toBe(false);
	});
});

describe("searchPathFilesystemTargets", () => {
	it("returns empty array for null args", () => {
		expect(searchPathFilesystemTargets(null)).toEqual([]);
	});

	it("returns empty array for non-object args", () => {
		expect(searchPathFilesystemTargets("string")).toEqual([]);
	});

	it("returns empty array for args without path or paths", () => {
		expect(searchPathFilesystemTargets({})).toEqual([]);
	});

	it("extracts path string", () => {
		const result = searchPathFilesystemTargets({ path: "src/foo.ts" });
		expect(result).toContain("src/foo.ts");
	});

	it("extracts paths array", () => {
		const result = searchPathFilesystemTargets({ paths: ["src/foo.ts", "src/bar.ts"] });
		expect(result).toContain("src/foo.ts");
		expect(result).toContain("src/bar.ts");
	});

	it("splits semicolon-delimited paths", () => {
		const result = searchPathFilesystemTargets({ path: "src/foo.ts;src/bar.ts" });
		expect(result).toContain("src/foo.ts");
		expect(result).toContain("src/bar.ts");
	});

	it("handles legacy paths field when path is missing", () => {
		const result = searchPathFilesystemTargets({ paths: "src/foo.ts" });
		expect(result.length).toBeGreaterThan(0);
	});

	it("prefers path over paths", () => {
		const result = searchPathFilesystemTargets({ path: "src/main.ts", paths: ["src/other.ts"] });
		expect(result).toContain("src/main.ts");
	});

	it("filters empty entries", () => {
		const result = searchPathFilesystemTargets({ path: "  ;  " });
		expect(result).toEqual([]);
	});

	it("handles empty string path", () => {
		expect(searchPathFilesystemTargets({ path: "" })).toEqual([]);
	});

	it("handles empty array paths", () => {
		expect(searchPathFilesystemTargets({ paths: [] })).toEqual([]);
	});
});

describe("cwdEscapingTargets", () => {
	it("returns empty array when cwd is empty", () => {
		const tool: CwdBoundedTool = { filesystemTargets: () => ["../escape"] };
		expect(cwdEscapingTargets(tool, {}, "")).toEqual([]);
	});

	it("returns empty array when tool has no filesystemTargets", () => {
		expect(cwdEscapingTargets({}, {}, "/home/user")).toEqual([]);
	});

	it("returns empty array when all targets are within cwd", () => {
		const tool: CwdBoundedTool = { filesystemTargets: () => ["src/foo.ts"] };
		expect(cwdEscapingTargets(tool, {}, "/home/user/project")).toEqual([]);
	});

	it("detects targets escaping cwd", () => {
		const tool: CwdBoundedTool = { filesystemTargets: () => ["../escape.ts"] };
		const escaping = cwdEscapingTargets(tool, {}, "/home/user/project");
		expect(escaping.length).toBeGreaterThan(0);
	});
});

describe("formatCwdBoundaryReason", () => {
	it("formats reason with cwd and targets", () => {
		const reason = formatCwdBoundaryReason("/home/user/project", ["../escape.ts"]);
		expect(reason).toContain("/home/user/project");
		expect(reason).toContain("../escape.ts");
	});

	it("includes guidance about approval", () => {
		const reason = formatCwdBoundaryReason("/cwd", ["target.ts"]);
		expect(reason).toContain("Approve");
	});

	it("includes guidance about set_cwd", () => {
		const reason = formatCwdBoundaryReason("/cwd", ["target.ts"]);
		expect(reason).toContain("set_cwd");
	});

	it("includes guidance about yolo mode", () => {
		const reason = formatCwdBoundaryReason("/cwd", ["target.ts"]);
		expect(reason).toContain("yolo");
	});

	it("joins multiple targets with comma", () => {
		const reason = formatCwdBoundaryReason("/cwd", ["target1.ts", "target2.ts"]);
		expect(reason).toContain("target1.ts, target2.ts");
	});

	it("handles empty targets list", () => {
		const reason = formatCwdBoundaryReason("/cwd", []);
		expect(reason).toContain("/cwd");
	});
});
