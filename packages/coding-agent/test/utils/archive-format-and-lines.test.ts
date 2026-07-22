import { describe, expect, it } from "bun:test";
import {
	archiveFormatFromPath,
	formatArchiveEntryLines,
	parseArchivePathCandidates,
	sniffArchiveFormat,
	unzip,
	unzipText,
	zip,
} from "@veyyon/coding-agent/utils/zip";

/**
 * Two pure helpers behind the archive reader had no test.
 *   - archiveFormatFromPath infers the archive format from a path extension,
 *     case-insensitively, checking the compound `.tar.gz`/`.tgz` before the bare
 *     `.tar` so a gzipped tarball is not mis-read as an uncompressed tar. It
 *     returns undefined for a plain `.gz`, a name that merely contains "tar.gz"
 *     without the dot, and an extensionless path, and honors only the FINAL
 *     extension (`a.tar.zip` is a zip).
 *   - formatArchiveEntryLines renders a directory listing: directories get a
 *     trailing slash, files get a ` (size)` suffix only when their size is > 0.
 * A regression would open a `.tar.gz` as raw tar (decompression skipped), or drop
 * the size annotation / directory marker in the listing.
 */

describe("archiveFormatFromPath", () => {
	it("detects gzipped tarballs from .tar.gz and .tgz before the bare .tar", () => {
		expect(archiveFormatFromPath("a.tar.gz")).toBe("tar.gz");
		expect(archiveFormatFromPath("a.TGZ")).toBe("tar.gz");
	});

	it("detects plain tar and zip, honoring only the final extension", () => {
		expect(archiveFormatFromPath("x/y.tar")).toBe("tar");
		expect(archiveFormatFromPath("Z.ZIP")).toBe("zip");
		// The last extension wins: this is a zip, not a tar.
		expect(archiveFormatFromPath("a.tar.zip")).toBe("zip");
	});

	it("returns undefined for a plain gzip, a false 'tar.gz' substring, and no extension", () => {
		expect(archiveFormatFromPath("plain.gz")).toBeUndefined();
		// `mytar.gz` ends with "tar.gz" but not ".tar.gz" (no dot before tar).
		expect(archiveFormatFromPath("mytar.gz")).toBeUndefined();
		expect(archiveFormatFromPath("noext")).toBeUndefined();
	});
});

describe("formatArchiveEntryLines", () => {
	it("marks directories with a trailing slash and annotates non-empty file sizes", () => {
		expect(
			formatArchiveEntryLines([
				{ name: "dir", path: "dir", isDirectory: true, size: 0 },
				{ name: "file.txt", path: "file.txt", isDirectory: false, size: 2048 },
				{ name: "empty", path: "empty", isDirectory: false, size: 0 },
			]),
		).toEqual(["dir/", "file.txt (2.0KB)", "empty"]);
	});

	it("returns an empty list for no entries", () => {
		expect(formatArchiveEntryLines([])).toEqual([]);
	});
});

/**
 * sniffArchiveFormat is the CONTENT-based counterpart to archiveFormatFromPath: it identifies an
 * archive from its leading magic bytes, used when a path extension is missing or lies. It had no
 * test. A regression would misread a zip or gzipped tarball as "not an archive" (the reader then
 * treats the bytes as raw text) or as the wrong format (decompression skipped). Both zip local-file
 * and end-of-central-directory signatures must map to "zip"; the gzip magic to "tar.gz"; the ustar
 * magic at offset 257 to "tar"; anything too short or unrecognized to undefined.
 */
describe("sniffArchiveFormat", () => {
	it("recognizes a zip from either its local-file or end-of-central-directory signature", () => {
		expect(sniffArchiveFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).toBe("zip");
		expect(sniffArchiveFormat(new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]))).toBe("zip");
	});

	it("recognizes a gzipped tarball from the gzip magic bytes", () => {
		expect(sniffArchiveFormat(new Uint8Array([0x1f, 0x8b, 0, 0]))).toBe("tar.gz");
	});

	it("recognizes a plain tar from the ustar magic at offset 257", () => {
		const tar = new Uint8Array(300);
		for (let i = 0; i < 5; i++) tar[257 + i] = "ustar".charCodeAt(i);
		expect(sniffArchiveFormat(tar)).toBe("tar");
	});

	it("returns undefined for empty or unrecognized bytes", () => {
		expect(sniffArchiveFormat(new Uint8Array([]))).toBeUndefined();
		expect(sniffArchiveFormat(new Uint8Array([1, 2, 3, 4, 5]))).toBeUndefined();
	});
});

/**
 * parseArchivePathCandidates splits a possibly-nested archive reference like
 * `outer.zip:nested.tar:file.txt` into every (archivePath, subPath) split point an archive
 * extension allows, so the reader can try opening the outermost archive first. It had no test. The
 * ordering matters: candidates come back sorted by archivePath length DESCENDING (deepest split
 * first) so the reader prefers the most specific archive boundary. A path with no archive extension
 * yields no candidates; a bare archive path yields one with an empty subPath. Matching is done on a
 * forward-slash-normalized copy, but each returned archivePath preserves the original separators.
 */
describe("parseArchivePathCandidates", () => {
	it("returns a single empty-subPath candidate for a bare archive path", () => {
		expect(parseArchivePathCandidates("/a/b.zip")).toEqual([{ archivePath: "/a/b.zip", subPath: "" }]);
	});

	it("splits an archive-plus-member reference and strips the leading colon from the member", () => {
		expect(parseArchivePathCandidates("/a/b.tar.gz:inner/file.txt")).toEqual([
			{ archivePath: "/a/b.tar.gz", subPath: "inner/file.txt" },
		]);
	});

	it("returns every nested split, deepest archive boundary first", () => {
		expect(parseArchivePathCandidates("/a/outer.zip:nested.tar:file.txt")).toEqual([
			{ archivePath: "/a/outer.zip:nested.tar", subPath: "file.txt" },
			{ archivePath: "/a/outer.zip", subPath: "nested.tar:file.txt" },
		]);
	});

	it("returns no candidates for a path without an archive extension", () => {
		expect(parseArchivePathCandidates("/a/plain.txt")).toEqual([]);
	});

	it("preserves the original separators in archivePath while matching on a normalized copy", () => {
		expect(parseArchivePathCandidates("C:\\a\\b.zip")).toEqual([{ archivePath: "C:\\a\\b.zip", subPath: "" }]);
	});
});

/**
 * unzipText reads a single member out of an already-unzipped archive and decodes it as UTF-8, or
 * returns undefined when the member is absent. It had no direct test. Round-tripping it through the real
 * zip/unzip primitives pins the contract the read tool relies on when it pulls one file out of an
 * archive:
 *   - a member packed with zip and recovered with unzip decodes back to its exact original text,
 *     including multibyte content (the decoder must be UTF-8, not latin-1);
 *   - a path that is not a member returns undefined (distinguishable from an empty-but-present member),
 *     so a missing selector is a clean "not found" rather than a crash or an empty string;
 *   - an empty member is present and decodes to "" (not undefined), preserving the present/absent split.
 */
describe("unzipText", () => {
	it("round-trips a member's exact UTF-8 text through zip/unzip", () => {
		const entries = unzip(
			zip({
				"greeting.txt": new TextEncoder().encode("hello world"),
				"unicode.txt": new TextEncoder().encode("café — 😀"),
			}),
		);
		expect(unzipText(entries, "greeting.txt")).toBe("hello world");
		expect(unzipText(entries, "unicode.txt")).toBe("café — 😀");
	});

	it("returns undefined for a member that is not present", () => {
		const entries = unzip(zip({ "only.txt": new TextEncoder().encode("x") }));
		expect(unzipText(entries, "missing.txt")).toBeUndefined();
	});

	it("returns an empty string (not undefined) for a present-but-empty member", () => {
		const entries = unzip(zip({ "empty.txt": new Uint8Array(0) }));
		expect(unzipText(entries, "empty.txt")).toBe("");
	});
});
