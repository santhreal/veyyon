import { describe, expect, it } from "bun:test";
import { expandTilde, looksLikeFilePath, stripWindowsExtendedLengthPathPrefix } from "../src/path";
import { AnsiStripper, stripAnsi } from "../src/strip-ansi";

describe("stripAnsi", () => {
	it("returns string unchanged when no escape sequences", () => {
		expect(stripAnsi("hello world")).toBe("hello world");
	});
	it("returns empty string unchanged", () => {
		expect(stripAnsi("")).toBe("");
	});
	it("strips CSI color sequences", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
	});
	it("strips CSI cursor movement", () => {
		expect(stripAnsi("\x1b[2Atext")).toBe("text");
	});
	it("strips OSC sequences with BEL terminator", () => {
		expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
	});
	it("strips OSC sequences with ST terminator", () => {
		expect(stripAnsi("\x1b]0;title\x1b\\text")).toBe("text");
	});
	it("strips DCS sequences", () => {
		expect(stripAnsi("\x1bPdata\x1b\\text")).toBe("text");
	});
	it("strips SOS sequences", () => {
		expect(stripAnsi("\x1bXdata\x1b\\text")).toBe("text");
	});
	it("strips PM sequences", () => {
		expect(stripAnsi("\x1b^data\x1b\\text")).toBe("text");
	});
	it("strips APC sequences", () => {
		expect(stripAnsi("\x1b_data\x1b\\text")).toBe("text");
	});
	it("strips simple escape sequences", () => {
		expect(stripAnsi("\x1b7text\x1b8")).toBe("text");
	});
	it("strips multiple sequences in one string", () => {
		expect(stripAnsi("\x1b[31mred\x1b[32mgreen\x1b[0m")).toBe("redgreen");
	});
	it("handles lone escape char", () => {
		expect(stripAnsi("text\x1b")).toBe("text");
	});
	it("handles C1 control codes", () => {
		expect(stripAnsi("\x9b31mred\x9b0m")).toBe("red");
	});
	it("preserves regular text between sequences", () => {
		expect(stripAnsi("a\x1b[31mb\x1b[0mc")).toBe("abc");
	});
	it("handles string with only escape sequences", () => {
		expect(stripAnsi("\x1b[31m\x1b[0m")).toBe("");
	});
});

describe("AnsiStripper", () => {
	it("returns plain text unchanged", () => {
		const stripper = new AnsiStripper();
		expect(stripper.push("hello world")).toBe("hello world");
	});
	it("strips complete ANSI sequences", () => {
		const stripper = new AnsiStripper();
		expect(stripper.push("\x1b[31mred\x1b[0m")).toBe("red");
	});
	it("buffers incomplete escape sequences across pushes", () => {
		const stripper = new AnsiStripper();
		expect(stripper.push("text\x1b[31")).toBe("text");
		expect(stripper.push("mred\x1b[0m")).toBe("red");
	});
	it("reports pending content", () => {
		const stripper = new AnsiStripper();
		stripper.push("text\x1b[31");
		expect(stripper.pending).toBe("[31");
	});
	it("reports held byte count", () => {
		const stripper = new AnsiStripper();
		stripper.push("text\x1b[31");
		expect(stripper.held).toBe(4);
	});
	it("handles multiple chunks", () => {
		const stripper = new AnsiStripper();
		let result = "";
		result += stripper.push("hello ");
		result += stripper.push("\x1b[31m");
		result += stripper.push("world");
		result += stripper.push("\x1b[0m");
		expect(result).toBe("hello world");
	});
	it("handles empty push", () => {
		const stripper = new AnsiStripper();
		expect(stripper.push("")).toBe("");
	});
});

describe("stripWindowsExtendedLengthPathPrefix", () => {
	it("returns path unchanged on non-win32 platform", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\C:\\foo", "linux")).toBe("\\\\?\\C:\\foo");
	});
	it("returns path unchanged when no prefix", () => {
		expect(stripWindowsExtendedLengthPathPrefix("C:\\foo", "win32")).toBe("C:\\foo");
	});
	it("strips drive extended prefix on win32", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\C:\\foo", "win32")).toBe("C:\\foo");
	});
	it("strips UNC extended prefix on win32", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\UNC\\server\\share", "win32")).toBe("\\\\server\\share");
	});
	it("strips forward-slash drive extended prefix on win32", () => {
		expect(stripWindowsExtendedLengthPathPrefix("//?/C:/foo", "win32")).toBe("C:/foo");
	});
	it("strips forward-slash UNC extended prefix on win32", () => {
		expect(stripWindowsExtendedLengthPathPrefix("//?/UNC/server/share", "win32")).toBe("//server/share");
	});
	it("handles NT-style drive prefix", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\??\\C:\\foo", "win32")).toBe("C:\\foo");
	});
	it("handles NT-style UNC prefix", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\??\\UNC\\server\\share", "win32")).toBe("\\\\server\\share");
	});
});

describe("looksLikeFilePath", () => {
	it("returns true for path with forward slash", () => {
		expect(looksLikeFilePath("path/to/file")).toBe(true);
	});
	it("returns true for path with backslash", () => {
		expect(looksLikeFilePath("path\\to\\file")).toBe(true);
	});
	it("returns false for plain filename without extensions", () => {
		expect(looksLikeFilePath("filename")).toBe(false);
	});
	it("returns false for plain filename with no matching extension", () => {
		expect(looksLikeFilePath("file.txt", ["ts", "js"])).toBe(false);
	});
	it("returns true for filename with matching extension", () => {
		expect(looksLikeFilePath("file.ts", ["ts", "js"])).toBe(true);
	});
	it("returns true for filename with matching extension case-insensitive", () => {
		expect(looksLikeFilePath("file.TS", ["ts", "js"])).toBe(true);
	});
	it("returns true for absolute path", () => {
		expect(looksLikeFilePath("/absolute/path")).toBe(true);
	});
	it("returns false for empty string", () => {
		expect(looksLikeFilePath("")).toBe(false);
	});
	it("returns false for string with no slash and no extension match", () => {
		expect(looksLikeFilePath("hello", ["ts"])).toBe(false);
	});
});

describe("expandTilde", () => {
	it("expands ~ to home directory", () => {
		expect(expandTilde("~", "/home/user")).toBe("/home/user");
	});
	it("expands ~/path to home/path", () => {
		expect(expandTilde("~/projects", "/home/user")).toBe("/home/user/projects");
	});
	it("expands ~\\path on Windows-style", () => {
		expect(expandTilde("~\\projects", "C:\\Users\\user")).toBe("C:\\Users\\user\\projects");
	});
	it("returns path unchanged when no tilde", () => {
		expect(expandTilde("/absolute/path", "/home/user")).toBe("/absolute/path");
	});
	it("expands ~user to path.join(home, user)", () => {
		const result = expandTilde("~otheruser", "/home/user");
		expect(result).toContain("otheruser");
	});
	it("returns relative path unchanged", () => {
		expect(expandTilde("relative/path", "/home/user")).toBe("relative/path");
	});
	it("returns empty string unchanged", () => {
		expect(expandTilde("", "/home/user")).toBe("");
	});
});
