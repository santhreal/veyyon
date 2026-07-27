import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { expandTilde, looksLikeFilePath, stripWindowsExtendedLengthPathPrefix } from "../src/path";

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

/**
 * "Did the user WRITE a path here?" — asked without touching the disk.
 *
 * WHY THIS EXISTS. Several options accept either a file path or the value itself:
 * `--system-prompt`, `--append-system-prompt`, the Anthropic certificate variables.
 * Deciding between them by whether the file opens conflates two different facts, and
 * the conflation is silent in the worst direction: a mistyped path resolves to the
 * literal string, so `--system-prompt ./promtps/main.md` used to hand the model a
 * system prompt whose entire content was that path. Asking about the SHAPE separates
 * "you meant a file and it is not there" from "you meant this text".
 *
 * The predicate has to be narrow in both directions, so both are pinned: a value with
 * a separator is a path, a sentence is not, and the extension list belongs to the
 * caller because a filename in one domain is prose in another.
 */
describe("looksLikeFilePath", () => {
	/** A separator is decisive: no literal value contains one by accident. */
	it("takes any value containing a separator as a path", () => {
		expect(looksLikeFilePath("./prompts/main.md")).toBe(true);
		expect(looksLikeFilePath("/etc/veyyon/system.txt")).toBe(true);
		expect(looksLikeFilePath("prompts\\main.md")).toBe(true);
		expect(looksLikeFilePath("a/b")).toBe(true);
	});

	/** With no separator and no extension list, nothing is a path. */
	it("takes a bare word as a value, not a path", () => {
		expect(looksLikeFilePath("SYSTEM.md")).toBe(false);
		expect(looksLikeFilePath("You are a pirate.")).toBe(false);
	});

	/**
	 * The extension list is the CALLER'S, because what reads as a filename is domain
	 * knowledge. `.md` names a prompt file and means nothing in a certificate option;
	 * a shared list would either miss real filenames or claim ordinary prose.
	 */
	it("takes a bare filename as a path only for the caller's extensions", () => {
		expect(looksLikeFilePath("SYSTEM.md", ["md", "txt"])).toBe(true);
		expect(looksLikeFilePath("client.pem", ["pem", "crt"])).toBe(true);
		// The same value, judged by the other domain's list.
		expect(looksLikeFilePath("SYSTEM.md", ["pem", "crt"])).toBe(false);
		expect(looksLikeFilePath("client.pem", ["md", "txt"])).toBe(false);
	});

	/** Extensions match regardless of case, since filenames on disk are written both ways. */
	it("matches an extension case-insensitively", () => {
		expect(looksLikeFilePath("SYSTEM.MD", ["md"])).toBe(true);
		expect(looksLikeFilePath("system.Md", ["MD"])).toBe(true);
	});

	/**
	 * A dot that is not an extension must not read as one. These are the shapes a
	 * one-line prompt actually takes, and treating them as paths would refuse a
	 * supported way to pass a prompt inline.
	 */
	it("does not read sentence punctuation as an extension", () => {
		expect(looksLikeFilePath("Be terse.", ["md"])).toBe(false);
		expect(looksLikeFilePath("Version 1.0 rules", ["md"])).toBe(false);
		expect(looksLikeFilePath("", ["md"])).toBe(false);
	});

	/** Only the LAST segment decides, so a dotted directory does not make prose a path. */
	it("judges the extension at the end of the value", () => {
		expect(looksLikeFilePath("notes.md and more", ["md"])).toBe(false);
	});
});
