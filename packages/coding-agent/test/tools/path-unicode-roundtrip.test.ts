/**
 * Path bytes survive resolution exactly, and the normalization stance is pinned.
 *
 * WHY THIS SUITE EXISTS. A path is a byte string, not text, and every place that
 * "helpfully" normalizes one can silently address a different file. The risk is
 * concentrated in Unicode normalization: `é` has two encodings, NFC (U+00E9, one
 * code point) and NFD (U+0065 U+0301, `e` plus a combining acute). They render
 * identically and no reader can tell them apart, but on Linux they are two
 * distinct filenames that can coexist in one directory.
 *
 * THE STANCE, which these tests exist to hold:
 *
 *   1. `resolveToCwd` NEVER normalizes. What the caller passed is what gets
 *      resolved, byte for byte. A resolver that silently rewrote NFC to NFD
 *      would, on Linux, resolve to a file the caller did not name.
 *
 *   2. `resolveReadPath` MAY fall back to an NFD variant, but only after the
 *      exact path has been tried and missed. macOS stores filenames decomposed,
 *      so a user who types the composed form would otherwise be told a file they
 *      can see does not exist. Because the exact form is tried first, the
 *      fallback can never shadow a file that really is there.
 *
 * The ordering in (2) is the whole safety property, so it is asserted directly
 * with both encodings present on disk.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveReadPath, resolveToCwd } from "@veyyon/coding-agent/tools/path-utils";

/** `é` composed: one code point, two UTF-8 bytes. */
const NFC_NAME = "caf\u00E9.txt";
/** `é` decomposed: `e` plus a combining acute, three UTF-8 bytes. */
const NFD_NAME = "cafe\u0301.txt";

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "veyyon-unicode-path-"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("resolveToCwd preserves path bytes exactly", () => {
	/**
	 * The core claim, stated per script. If any of these came back altered, the
	 * tool would open a different file than the model named, and the mismatch
	 * would be invisible in any log because the two render the same.
	 */
	it.each([
		["emoji", "\u{1F600}\u{1F680}.txt"],
		["CJK", "文字化け.md"],
		["RTL Arabic", "ملف.txt"],
		["RTL Hebrew", "קובץ.txt"],
		["combining accents", NFD_NAME],
		["precomposed accents", NFC_NAME],
		["mixed direction", "report-ملف-v2.txt"],
		["zero-width joiner", "\u{1F468}‍\u{1F4BB}.txt"],
	])("round-trips a %s filename unchanged", (_label, name) => {
		expect(resolveToCwd(name, "/tmp/project")).toBe(`/tmp/project/${name}`);
	});

	/**
	 * THE normalization guarantee, stated as an inequality. NFC and NFD are
	 * different byte strings, so resolving one must never produce the other.
	 * A `.normalize()` anywhere in the resolver turns this red.
	 */
	it("does not convert between NFC and NFD", () => {
		expect(NFC_NAME).not.toBe(NFD_NAME);
		expect(resolveToCwd(NFC_NAME, "/x")).toBe(`/x/${NFC_NAME}`);
		expect(resolveToCwd(NFD_NAME, "/x")).toBe(`/x/${NFD_NAME}`);
		expect(resolveToCwd(NFC_NAME, "/x")).not.toBe(resolveToCwd(NFD_NAME, "/x"));
	});

	/** The byte lengths differ, which is what makes these genuinely distinct
	 * filenames rather than a rendering detail. */
	it("keeps the distinct byte lengths of the two encodings", () => {
		expect(Buffer.byteLength(NFC_NAME, "utf8")).toBe(9);
		expect(Buffer.byteLength(NFD_NAME, "utf8")).toBe(10);
	});
});

describe("a Unicode filename survives a real write and read", () => {
	/**
	 * The integration half. Resolution preserving bytes is only useful if the
	 * bytes still name the file after it reaches the filesystem, so this writes
	 * and reads through the resolved path rather than asserting on strings alone.
	 */
	it.each([
		["emoji", "\u{1F600}-notes.txt"],
		["CJK", "读取.txt"],
		["RTL", "ملف.txt"],
		["combining accents", NFD_NAME],
	])("writes and reads back a %s filename byte-exactly", (_label, name) => {
		const resolved = resolveToCwd(name, root);
		writeFileSync(resolved, `content of ${name}`);
		expect(readFileSync(resolved, "utf8")).toBe(`content of ${name}`);
		// And the resolved path is still the exact name, not a normalized cousin.
		expect(resolved.endsWith(name)).toBe(true);
	});
});

describe("NFC and NFD are distinct files, and the exact form wins", () => {
	/**
	 * On a byte-sensitive filesystem both encodings can exist side by side with
	 * different contents. This is the setup that makes the fallback ordering
	 * testable: if `resolveReadPath` preferred the NFD variant, it would return
	 * the wrong file's contents for a caller who asked for the NFC one.
	 */
	const bothDir = () => {
		const dir = join(root, "both");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, NFC_NAME), "composed");
		writeFileSync(join(dir, NFD_NAME), "decomposed");
		return dir;
	};

	it("stores the two encodings as separate files on this filesystem", () => {
		const dir = bothDir();
		// A case-insensitive or normalizing filesystem would collapse these, in
		// which case the ordering assertion below is not meaningful here.
		expect(readFileSync(join(dir, NFC_NAME), "utf8")).toBe("composed");
		expect(readFileSync(join(dir, NFD_NAME), "utf8")).toBe("decomposed");
	});

	/** THE safety property: the exact path is tried before any variant, so a
	 * file that really exists is never shadowed by a normalization fallback. */
	it("returns the composed file for a composed request", () => {
		const dir = bothDir();
		expect(readFileSync(resolveReadPath(NFC_NAME, dir), "utf8")).toBe("composed");
	});

	/** And the mirror, so the result is not merely "always picks the first". */
	it("returns the decomposed file for a decomposed request", () => {
		const dir = bothDir();
		expect(readFileSync(resolveReadPath(NFD_NAME, dir), "utf8")).toBe("decomposed");
	});

	/**
	 * The fallback earns its keep only when the exact path is absent, which is
	 * the macOS situation: the user types the composed name, the disk holds the
	 * decomposed one. With no NFC file present, the NFD file is the right answer.
	 */
	it("falls back to the NFD file when only that one exists", () => {
		const dir = join(root, "nfd-only");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, NFD_NAME), "decomposed");
		expect(readFileSync(resolveReadPath(NFC_NAME, dir), "utf8")).toBe("decomposed");
	});

	/** With nothing on disk, resolution stays byte-exact rather than guessing:
	 * the caller gets back the path it asked about, so the ENOENT names it. */
	it("returns the requested path unchanged when nothing matches", () => {
		const dir = join(root, "empty");
		mkdirSync(dir, { recursive: true });
		expect(resolveReadPath(NFC_NAME, dir)).toBe(join(dir, NFC_NAME));
	});
});
