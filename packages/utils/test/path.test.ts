import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { expandTilde, stripWindowsExtendedLengthPathPrefix } from "../src/path";

describe("stripWindowsExtendedLengthPathPrefix", () => {
	it("removes drive and UNC extended-length prefixes on Windows", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\C:\\Users\\Shi Xin\\veyyon.exe", "win32")).toBe(
			"C:\\Users\\Shi Xin\\veyyon.exe",
		);
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\UNC\\server\\share\\veyyon.exe", "win32")).toBe(
			"\\\\server\\share\\veyyon.exe",
		);
	});

	it("leaves non-Windows paths unchanged", () => {
		const path = "\\\\?\\C:\\Users\\Shi Xin\\veyyon.exe";
		expect(stripWindowsExtendedLengthPathPrefix(path, "linux")).toBe(path);
	});
});

describe("expandTilde", () => {
	it("expands a bare ~ to the home directory", () => {
		expect(expandTilde("~", "/home/alice")).toBe("/home/alice");
	});

	it("expands ~/ and ~\\ prefixes by splicing home in front", () => {
		expect(expandTilde("~/projects/x", "/home/alice")).toBe("/home/alice/projects/x");
		expect(expandTilde("~\\Documents\\x", "C:\\Users\\alice")).toBe("C:\\Users\\alice\\Documents\\x");
	});

	it("joins a bare ~name suffix under home", () => {
		expect(expandTilde("~scratch", "/home/alice")).toBe(path.join("/home/alice", "scratch"));
	});

	it("returns non-tilde paths unchanged", () => {
		expect(expandTilde("/etc/hosts", "/home/alice")).toBe("/etc/hosts");
		expect(expandTilde("relative/path", "/home/alice")).toBe("relative/path");
		expect(expandTilde("", "/home/alice")).toBe("");
	});

	it("defaults home to os.homedir()", () => {
		expect(expandTilde("~/x")).toBe(`${os.homedir()}/x`);
	});
});
