import { describe, expect, it } from "bun:test";
import { contentText } from "../src/content-text";
import {
	enoentError,
	hasFsCode,
	isEacces,
	isEexist,
	isEisdir,
	isEnoent,
	isEnotdir,
	isFsError,
	isMissingPath,
} from "../src/fs-error";

describe("isFsError", () => {
	it("returns true for Error with string code property", () => {
		const err = new Error("test") as Error & { code: string };
		err.code = "ENOENT";
		expect(isFsError(err)).toBe(true);
	});

	it("returns false for plain Error without code", () => {
		expect(isFsError(new Error("test"))).toBe(false);
	});

	it("returns false for non-Error values", () => {
		expect(isFsError(null)).toBe(false);
		expect(isFsError(undefined)).toBe(false);
		expect(isFsError("string")).toBe(false);
		expect(isFsError(42)).toBe(false);
		expect(isFsError({ code: "ENOENT" })).toBe(false);
	});

	it("returns false for Error with non-string code", () => {
		const err = new Error("test") as Error & { code: unknown };
		err.code = 42;
		expect(isFsError(err)).toBe(false);
	});
});

describe("isEnoent", () => {
	it("returns true for ENOENT error", () => {
		const err = new Error("not found") as Error & { code: string };
		err.code = "ENOENT";
		expect(isEnoent(err)).toBe(true);
	});

	it("returns false for non-ENOENT error", () => {
		const err = new Error("denied") as Error & { code: string };
		err.code = "EACCES";
		expect(isEnoent(err)).toBe(false);
	});

	it("returns false for non-Error", () => {
		expect(isEnoent(null)).toBe(false);
	});
});

describe("enoentError", () => {
	it("creates an Error with ENOENT code", () => {
		const err = enoentError("/path/to/file");
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe("ENOENT");
		expect(err.errno).toBe(-2);
		expect(err.syscall).toBe("open");
		expect(err.path).toBe("/path/to/file");
	});

	it("includes path in message", () => {
		const err = enoentError("/my/file");
		expect(err.message).toContain("/my/file");
		expect(err.message).toContain("ENOENT");
	});
});

describe("isEacces", () => {
	it("returns true for EACCES error", () => {
		const err = new Error("denied") as Error & { code: string };
		err.code = "EACCES";
		expect(isEacces(err)).toBe(true);
	});

	it("returns false for other codes", () => {
		const err = new Error("not found") as Error & { code: string };
		err.code = "ENOENT";
		expect(isEacces(err)).toBe(false);
	});
});

describe("isEisdir", () => {
	it("returns true for EISDIR error", () => {
		const err = new Error("is dir") as Error & { code: string };
		err.code = "EISDIR";
		expect(isEisdir(err)).toBe(true);
	});

	it("returns false for other codes", () => {
		const err = new Error("denied") as Error & { code: string };
		err.code = "EACCES";
		expect(isEisdir(err)).toBe(false);
	});
});

describe("isEnotdir", () => {
	it("returns true for ENOTDIR error", () => {
		const err = new Error("not dir") as Error & { code: string };
		err.code = "ENOTDIR";
		expect(isEnotdir(err)).toBe(true);
	});

	it("returns false for other codes", () => {
		const err = new Error("not found") as Error & { code: string };
		err.code = "ENOENT";
		expect(isEnotdir(err)).toBe(false);
	});
});

describe("isMissingPath", () => {
	it("returns true for ENOENT", () => {
		const err = new Error("not found") as Error & { code: string };
		err.code = "ENOENT";
		expect(isMissingPath(err)).toBe(true);
	});

	it("returns true for ENOTDIR", () => {
		const err = new Error("not dir") as Error & { code: string };
		err.code = "ENOTDIR";
		expect(isMissingPath(err)).toBe(true);
	});

	it("returns false for EACCES", () => {
		const err = new Error("denied") as Error & { code: string };
		err.code = "EACCES";
		expect(isMissingPath(err)).toBe(false);
	});

	it("returns false for non-Error", () => {
		expect(isMissingPath(null)).toBe(false);
	});
});

describe("isEexist", () => {
	it("returns true for EEXIST error", () => {
		const err = new Error("exists") as Error & { code: string };
		err.code = "EEXIST";
		expect(isEexist(err)).toBe(true);
	});

	it("returns false for other codes", () => {
		const err = new Error("not found") as Error & { code: string };
		err.code = "ENOENT";
		expect(isEexist(err)).toBe(false);
	});
});

describe("hasFsCode", () => {
	it("returns true when code matches", () => {
		const err = new Error("custom") as Error & { code: string };
		err.code = "CUSTOM_CODE";
		expect(hasFsCode(err, "CUSTOM_CODE")).toBe(true);
	});

	it("returns false when code does not match", () => {
		const err = new Error("custom") as Error & { code: string };
		err.code = "OTHER_CODE";
		expect(hasFsCode(err, "CUSTOM_CODE")).toBe(false);
	});

	it("returns false for non-Error", () => {
		expect(hasFsCode(null, "ENOENT")).toBe(false);
		expect(hasFsCode({ code: "ENOENT" }, "ENOENT")).toBe(false);
	});
});

describe("contentText", () => {
	it("returns string content directly", () => {
		expect(contentText("hello")).toBe("hello");
	});

	it("returns empty string for non-array non-string", () => {
		expect(contentText(42)).toBe("");
		expect(contentText(null)).toBe("");
		expect(contentText(undefined)).toBe("");
		expect(contentText({})).toBe("");
	});

	it("extracts text from array of text blocks", () => {
		const blocks = [
			{ type: "text", text: "hello" },
			{ type: "text", text: "world" },
		];
		expect(contentText(blocks)).toBe("hello\nworld");
	});

	it("ignores non-text blocks", () => {
		const blocks = [
			{ type: "image", text: "ignored" },
			{ type: "text", text: "kept" },
			{ type: "tool_use", text: "ignored" },
		];
		expect(contentText(blocks)).toBe("kept");
	});

	it("ignores blocks without text property", () => {
		const blocks = [{ type: "text" }, { type: "text", text: "found" }];
		expect(contentText(blocks)).toBe("found");
	});

	it("ignores blocks with non-string text", () => {
		const blocks = [
			{ type: "text", text: 42 },
			{ type: "text", text: "valid" },
		];
		expect(contentText(blocks)).toBe("valid");
	});

	it("ignores null/undefined blocks in array", () => {
		const blocks = [null, undefined, { type: "text", text: "survives" }];
		expect(contentText(blocks)).toBe("survives");
	});

	it("ignores primitive blocks in array", () => {
		const blocks = ["string", 42, { type: "text", text: "only object" }];
		expect(contentText(blocks)).toBe("only object");
	});

	it("uses custom separator", () => {
		const blocks = [
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		];
		expect(contentText(blocks, " ")).toBe("a b");
	});

	it("uses empty separator", () => {
		const blocks = [
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		];
		expect(contentText(blocks, "")).toBe("ab");
	});

	it("returns empty string for empty array", () => {
		expect(contentText([])).toBe("");
	});

	it("returns empty string for array with no text blocks", () => {
		expect(contentText([{ type: "image" }, { type: "tool" }])).toBe("");
	});

	it("handles empty text strings", () => {
		const blocks = [
			{ type: "text", text: "" },
			{ type: "text", text: "non-empty" },
		];
		expect(contentText(blocks)).toBe("\nnon-empty");
	});

	it("handles single text block", () => {
		expect(contentText([{ type: "text", text: "only" }])).toBe("only");
	});
});
