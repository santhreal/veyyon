/**
 * The archive boundary's containment rule, and what it tells the operator.
 *
 * `src/utils/zip.ts` is the codebase's only archive implementation: the read,
 * grep, write and fetch tools all go through it, as do the xlsx, pptx and epub
 * converters. It had no tests.
 *
 * A member path comes from inside the archive, so it is attacker-controlled
 * whenever the archive is. A `..` segment is the classic zip-slip, aimed at
 * making an extraction write outside the directory it was pointed at, and a
 * `..\\..\\` written on Windows sails through any check that only looks for
 * `../`. The rule is to reject rather than clamp, which is the fail-closed
 * choice, and these tests pin it because a containment check that quietly stops
 * working looks exactly like one that works.
 *
 * The rule was ALSO applied twice, in two near-identical functions, which is the
 * duplication that eventually drifts. It now has one implementation, and the
 * lookup and entry cases differ only in whether an empty result is meaningful.
 *
 * Separately: dropping an unsafe member is correct, but dropping it SILENTLY
 * left the operator with a listing missing files they know are in the archive
 * and nothing saying why (Law 10). The drop is now reported once per archive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { openArchive } from "@veyyon/coding-agent/utils/zip";
import { logger } from "@veyyon/utils";

/**
 * Build a real ZIP with the given member paths, stored uncompressed.
 *
 * Written by hand rather than with a library because the whole point is to
 * produce paths a well-behaved zip writer refuses to emit.
 */
function zipWithPaths(members: Array<{ path: string; body: string }>): Uint8Array {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;

	for (const member of members) {
		const name = encoder.encode(member.path);
		const body = encoder.encode(member.body);
		const crc = crc32(body);

		const local = new Uint8Array(30 + name.length + body.length);
		const localView = new DataView(local.buffer);
		localView.setUint32(0, 0x04034b50, true);
		localView.setUint16(4, 20, true);
		localView.setUint16(6, 0x800, true); // UTF-8 names
		localView.setUint16(8, 0, true); // stored
		localView.setUint32(14, crc, true);
		localView.setUint32(18, body.length, true);
		localView.setUint32(22, body.length, true);
		localView.setUint16(26, name.length, true);
		local.set(name, 30);
		local.set(body, 30 + name.length);
		locals.push(local);

		const central = new Uint8Array(46 + name.length);
		const centralView = new DataView(central.buffer);
		centralView.setUint32(0, 0x02014b50, true);
		centralView.setUint16(4, 20, true);
		centralView.setUint16(6, 20, true);
		centralView.setUint16(8, 0x800, true);
		centralView.setUint16(10, 0, true);
		centralView.setUint32(16, crc, true);
		centralView.setUint32(20, body.length, true);
		centralView.setUint32(24, body.length, true);
		centralView.setUint16(28, name.length, true);
		centralView.setUint32(42, offset, true);
		central.set(name, 46);
		centrals.push(central);

		offset += local.length;
	}

	const centralSize = centrals.reduce((total, part) => total + part.length, 0);
	const end = new Uint8Array(22);
	const endView = new DataView(end.buffer);
	endView.setUint32(0, 0x06054b50, true);
	endView.setUint16(8, members.length, true);
	endView.setUint16(10, members.length, true);
	endView.setUint32(12, centralSize, true);
	endView.setUint32(16, offset, true);

	const total = [...locals, ...centrals, end];
	const bytes = new Uint8Array(total.reduce((sum, part) => sum + part.length, 0));
	let cursor = 0;
	for (const part of total) {
		bytes.set(part, cursor);
		cursor += part.length;
	}
	return bytes;
}

function crc32(bytes: Uint8Array): number {
	let crc = ~0;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return ~crc >>> 0;
}

const SKIPPED_MESSAGE = "Skipped archive members whose paths point outside the archive";

describe("archive member paths that try to escape the archive", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(() => {
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const skips = (): Array<Record<string, unknown>> =>
		warnings.filter(w => w.message === SKIPPED_MESSAGE).map(w => w.fields);

	/** Every member path in the archive, directories included, walked depth-first. */
	const listPaths = async (members: Array<{ path: string; body: string }>): Promise<string[]> => {
		const reader = await openArchive({ bytes: zipWithPaths(members), format: "zip" });
		const found: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of reader.listDirectory(dir)) {
				found.push(entry.path);
				if (entry.isDirectory) walk(entry.path);
			}
		};
		walk("");
		return found;
	};

	describe("the containment rule itself", () => {
		it("keeps an ordinary member", () => {
			// The premise. Without this every rejection test could pass by rejecting
			// everything.
			return expect(listPaths([{ path: "docs/readme.md", body: "hello" }])).resolves.toContain("docs/readme.md");
		});

		it("drops a member that climbs out with ..", async () => {
			// The classic zip-slip. Extracting this would write a sibling of the
			// directory the operator pointed at.
			const paths = await listPaths([
				{ path: "safe.txt", body: "ok" },
				{ path: "../escaped.txt", body: "bad" },
			]);

			expect(paths).toContain("safe.txt");
			expect(paths).not.toContain("../escaped.txt");
			expect(paths.some(p => p.includes(".."))).toBe(false);
		});

		it("drops a member that climbs out with Windows backslashes", async () => {
			// ZIP entries written on Windows use backslashes. A check that only looks
			// for `../` lets this straight through, which is why separators are folded
			// before the segments are examined.
			const paths = await listPaths([{ path: "..\\..\\escaped.txt", body: "bad" }]);

			expect(paths.some(p => p.includes("escaped.txt"))).toBe(false);
		});

		it("drops a member that hides .. in the middle of the path", async () => {
			// Checking only the first segment would miss this.
			const paths = await listPaths([{ path: "docs/../../escaped.txt", body: "bad" }]);

			expect(paths.some(p => p.includes("escaped.txt"))).toBe(false);
		});

		it("keeps a member whose name merely starts with two dots", async () => {
			// `..hidden` is a legitimate filename. Rejecting on a `..` PREFIX rather
			// than a `..` SEGMENT would make real archives unreadable, which is the
			// over-strict failure worth pinning alongside the under-strict one.
			const paths = await listPaths([{ path: "docs/..hidden.txt", body: "ok" }]);

			expect(paths).toContain("docs/..hidden.txt");
			expect(skips()).toEqual([]);
		});

		it("rewrites an absolute member path as relative rather than dropping it", async () => {
			// An absolute path cannot escape once the leading slash is gone, so
			// dropping it would lose a readable file for no safety gain.
			const paths = await listPaths([{ path: "/etc/hosts", body: "ok" }]);

			expect(paths).toContain("etc/hosts");
			expect(skips()).toEqual([]);
		});

		it("collapses a redundant current-directory segment", async () => {
			const paths = await listPaths([{ path: "./docs/./readme.md", body: "ok" }]);

			expect(paths).toContain("docs/readme.md");
			expect(skips()).toEqual([]);
		});
	});

	describe("reporting the drop", () => {
		it("says members were skipped instead of leaving a gap in the listing", async () => {
			// THE regression. The listing silently omitted the entry, so an operator
			// who knew the file was in the archive had nothing to go on.
			await listPaths([{ path: "../escaped.txt", body: "bad" }]);

			expect(skips()).toHaveLength(1);
		});

		it("counts every skipped member", async () => {
			await listPaths([
				{ path: "../one.txt", body: "bad" },
				{ path: "../two.txt", body: "bad" },
				{ path: "fine.txt", body: "ok" },
			]);

			expect(skips()[0]?.skipped).toBe(2);
		});

		it("shows one example, so the reader can recognise what was dropped", async () => {
			await listPaths([{ path: "../escaped.txt", body: "bad" }]);

			expect(String(skips()[0]?.example)).toContain("escaped.txt");
		});

		it("reports once per archive rather than once per member", async () => {
			// A hostile archive can contain any number of these. One warning per entry
			// would bury the log, which is how a loud channel stops being read.
			await listPaths(Array.from({ length: 40 }, (_, i) => ({ path: `../e${i}.txt`, body: "bad" })));

			expect(skips()).toHaveLength(1);
			expect(skips()[0]?.skipped).toBe(40);
		});

		it("explains why the entries are missing and what the path would have done", async () => {
			await listPaths([{ path: "../escaped.txt", body: "bad" }]);

			expect(String(skips()[0]?.fix)).toContain("missing from the listing");
			expect(String(skips()[0]?.fix)).toContain("escape the directory");
		});

		it("says nothing for an archive with no unsafe members", async () => {
			// Anti-vacuity. A report on the clean path would make every assertion above
			// pass for the wrong reason.
			await listPaths([{ path: "docs/readme.md", body: "ok" }]);

			expect(skips()).toEqual([]);
		});

		it("reports at warn, not debug, because files are missing from what the operator sees", async () => {
			const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});

			await listPaths([{ path: "../escaped.txt", body: "bad" }]);

			expect(skips()).toHaveLength(1);
			expect(debug).not.toHaveBeenCalled();
		});
	});

	describe("reading a member back", () => {
		it("still reads a safe member from an archive that also contained an unsafe one", async () => {
			// One hostile entry must not make the rest of the archive unreadable.
			const reader = await openArchive({
				bytes: zipWithPaths([
					{ path: "../escaped.txt", body: "bad" },
					{ path: "keep.txt", body: "kept contents" },
				]),
				format: "zip",
			});

			const file = await reader.readFile("keep.txt");
			expect(new TextDecoder().decode(file.bytes)).toBe("kept contents");
		});

		it("cannot read a dropped member by its original path", async () => {
			// The entry is gone from the index, not merely hidden from listings.
			const reader = await openArchive({
				bytes: zipWithPaths([
					{ path: "../escaped.txt", body: "bad" },
					{ path: "keep.txt", body: "ok" },
				]),
				format: "zip",
			});

			await expect(reader.readFile("../escaped.txt")).rejects.toThrow();
		});
	});
});
