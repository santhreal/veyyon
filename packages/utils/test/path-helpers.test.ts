import { describe, expect, it } from "bun:test";
import { expandTilde, looksLikeFilePath, stripWindowsExtendedLengthPathPrefix } from "../src/path";

describe("stripWindowsExtendedLengthPathPrefix", () => {
	it("returns unchanged on non-win32 platform", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\C:\\foo", "linux")).toBe("\\\\?\\C:\\foo");
	});

	it("strips drive extended prefix on win32", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\C:\\Users\\test", "win32")).toBe("C:\\Users\\test");
	});

	it("strips UNC extended prefix on win32", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\UNC\\server\\share\\file", "win32")).toBe(
			"\\\\server\\share\\file",
		);
	});

	it("strips forward-slash drive extended prefix on win32", () => {
		expect(stripWindowsExtendedLengthPathPrefix("//?/C:/Users/test", "win32")).toBe("C:/Users/test");
	});

	it("strips forward-slash UNC extended prefix on win32", () => {
		expect(stripWindowsExtendedLengthPathPrefix("//?/UNC/server/share/file", "win32")).toBe("//server/share/file");
	});

	it("returns unchanged when no prefix matches", () => {
		expect(stripWindowsExtendedLengthPathPrefix("C:\\Users\\test", "win32")).toBe("C:\\Users\\test");
	});

	it("strips NT-style drive prefix (\\\\??\\)", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\??\\C:\\Users\\test", "win32")).toBe("C:\\Users\\test");
	});

	it("strips NT-style UNC prefix", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\??\\UNC\\server\\share", "win32")).toBe("\\\\server\\share");
	});

	it("returns unchanged for empty string", () => {
		expect(stripWindowsExtendedLengthPathPrefix("", "win32")).toBe("");
	});
});

describe("looksLikeFilePath", () => {
	it("returns true for path with forward slash", () => {
		expect(looksLikeFilePath("foo/bar")).toBe(true);
	});

	it("returns true for path with backslash", () => {
		expect(looksLikeFilePath("foo\\bar")).toBe(true);
	});

	it("returns true for absolute Unix path", () => {
		expect(looksLikeFilePath("/usr/bin/foo")).toBe(true);
	});

	it("returns false for plain filename without extension", () => {
		expect(looksLikeFilePath("filename")).toBe(false);
	});

	it("returns false for plain filename with extension but no extensions list", () => {
		expect(looksLikeFilePath("file.txt")).toBe(false);
	});

	it("returns true when extension matches provided list", () => {
		expect(looksLikeFilePath("file", ["txt", "md"])).toBe(false);
		expect(looksLikeFilePath("file.txt", ["txt", "md"])).toBe(true);
	});

	it("is case-insensitive for extension matching", () => {
		expect(looksLikeFilePath("file.TXT", ["txt"])).toBe(true);
	});

	it("returns false when extension does not match list", () => {
		expect(looksLikeFilePath("file.exe", ["txt", "md"])).toBe(false);
	});

	it("returns true for path with slash regardless of extensions", () => {
		expect(looksLikeFilePath("dir/file.xyz", ["txt"])).toBe(true);
	});

	it("handles empty string", () => {
		expect(looksLikeFilePath("")).toBe(false);
	});

	it("handles empty extensions array", () => {
		expect(looksLikeFilePath("file.txt", [])).toBe(false);
	});
});

describe("expandTilde", () => {
	it("expands ~ to home directory", () => {
		expect(expandTilde("~", "/home/user")).toBe("/home/user");
	});

	it("expands ~/ to home directory with path", () => {
		expect(expandTilde("~/projects", "/home/user")).toBe("/home/user/projects");
	});

	it("expands ~\\ on Windows-style", () => {
		expect(expandTilde("~\\projects", "C:\\Users\\user")).toBe("C:\\Users\\user\\projects");
	});

	it("expands ~user using path.join", () => {
		const result = expandTilde("~other", "/home/user");
		expect(result).toContain("other");
	});

	it("returns unchanged when no tilde", () => {
		expect(expandTilde("/absolute/path", "/home/user")).toBe("/absolute/path");
	});

	it("returns unchanged for relative path without tilde", () => {
		expect(expandTilde("relative/path", "/home/user")).toBe("relative/path");
	});

	it("handles empty string", () => {
		expect(expandTilde("", "/home/user")).toBe("");
	});

	it("uses os.homedir when home not provided", () => {
		const result = expandTilde("~");
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});
});
