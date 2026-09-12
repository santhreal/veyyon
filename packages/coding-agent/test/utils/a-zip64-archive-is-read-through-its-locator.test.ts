/**
 * WHY: a ZIP whose end-of-central-directory record carries the 0xffff /
 * 0xffffffff sentinels holds its real entry count, size and offset in a ZIP64
 * record that a 20-byte locator in front of the EOCD points at. Both the
 * in-memory reader (`unzip`) and the ranged reader (`readArchiveEntries`) walk
 * that locator; a reader that ignored it would find no central directory.
 *
 * THE CLASS THIS CLOSES: the two readers parsing the ZIP64 locator and record
 * differently. Both go through one parser for each structure, and the arms drive
 * each reader with the same archive.
 *
 * WHAT IT DOES NOT CATCH: archives that need ZIP64 because they exceed 4 GiB or
 * 65535 entries; the archive here is small and only its EOCD claims ZIP64.
 */
import { describe, expect, it } from "bun:test";
import { openArchive, unzip, zip } from "@veyyon/coding-agent/utils/zip";

const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;

function writeU16(view: DataView, offset: number, value: number): void {
	view.setUint16(offset, value, true);
}

function writeU32(view: DataView, offset: number, value: number): void {
	view.setUint32(offset, value, true);
}

function writeU64(view: DataView, offset: number, value: number): void {
	view.setBigUint64(offset, BigInt(value), true);
}

/**
 * Rewrite a plain archive from `zip()` into ZIP64 form: the local headers and
 * central directory stay, then a ZIP64 EOCD record, its locator and an EOCD whose
 * count, size and offset fields are the ZIP64 sentinels.
 */
function toZip64(plain: Uint8Array, options: { totalDisks?: number } = {}): Uint8Array {
	const eocd = new DataView(plain.buffer, plain.byteOffset + plain.byteLength - 22, 22);
	const entries = eocd.getUint16(10, true);
	const centralSize = eocd.getUint32(12, true);
	const centralOffset = eocd.getUint32(16, true);
	const body = plain.subarray(0, centralOffset + centralSize);

	const out = new Uint8Array(body.byteLength + 56 + 20 + 22);
	out.set(body, 0);
	const view = new DataView(out.buffer);

	const recordOffset = body.byteLength;
	writeU32(view, recordOffset, ZIP64_EOCD_SIGNATURE);
	writeU64(view, recordOffset + 4, 44);
	writeU16(view, recordOffset + 12, 45);
	writeU16(view, recordOffset + 14, 45);
	writeU32(view, recordOffset + 16, 0);
	writeU32(view, recordOffset + 20, 0);
	writeU64(view, recordOffset + 24, entries);
	writeU64(view, recordOffset + 32, entries);
	writeU64(view, recordOffset + 40, centralSize);
	writeU64(view, recordOffset + 48, centralOffset);

	const locatorOffset = recordOffset + 56;
	writeU32(view, locatorOffset, ZIP64_EOCD_LOCATOR_SIGNATURE);
	writeU32(view, locatorOffset + 4, 0);
	writeU64(view, locatorOffset + 8, recordOffset);
	writeU32(view, locatorOffset + 16, options.totalDisks ?? 1);

	const eocdOffset = locatorOffset + 20;
	writeU32(view, eocdOffset, ZIP_EOCD_SIGNATURE);
	writeU16(view, eocdOffset + 8, 0xffff);
	writeU16(view, eocdOffset + 10, 0xffff);
	writeU32(view, eocdOffset + 12, 0xffffffff);
	writeU32(view, eocdOffset + 16, 0xffffffff);
	return out;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function sample(): Uint8Array {
	return zip({
		"a.txt": ENCODER.encode("first member"),
		"dir/b.txt": ENCODER.encode("second member, a little longer so deflate has something to do"),
	});
}

describe("a ZIP64 archive is read through its locator", () => {
	it("unzip resolves the central directory from the ZIP64 record", () => {
		const out = unzip(toZip64(sample()));
		expect(Object.keys(out).sort()).toEqual(["a.txt", "dir/b.txt"]);
		expect(DECODER.decode(out["a.txt"])).toBe("first member");
	});

	it("openArchive resolves the central directory from the ZIP64 record", async () => {
		const reader = await openArchive({ bytes: toZip64(sample()), format: "zip" });
		expect(
			reader
				.listDirectory()
				.map(entry => entry.name)
				.sort(),
		).toEqual(["a.txt", "dir"]);
		const first = await reader.readFile("a.txt");
		expect(DECODER.decode(first.bytes)).toBe("first member");
	});

	it("both readers reject a locator that spans more than one disk", async () => {
		const bytes = toZip64(sample(), { totalDisks: 2 });
		expect(() => unzip(bytes)).toThrow("Multi-disk ZIP archives are not supported");
		await expect(openArchive({ bytes, format: "zip" })).rejects.toThrow("Multi-disk ZIP archives are not supported");
	});
});
