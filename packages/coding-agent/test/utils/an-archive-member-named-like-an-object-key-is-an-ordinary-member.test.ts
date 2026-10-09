/**
 * WHY: the archive layer held a ZIP's members in a plain object keyed by member name. A member named
 * `__proto__` replaced that object's prototype instead of becoming a key, so enumerating the members
 * listed the replaced prototype's byte indices (`0`, `1`, ...) in place of the member, and a write into
 * such an archive rewrote it without the member or failed. A lookup of an absent member named after an
 * `Object.prototype` property (`toString`, `constructor`) found the inherited function and threw instead
 * of reporting the member absent, which failed a document conversion whose relationship named one.
 *
 * The class is a member name that collides with a property every plain object inherits. The sweep reads
 * those names from `Object.prototype` at run time, so a name a runtime adds there is covered with no list
 * to update, and drives each through every path that builds a member map from names: `unzip`,
 * `unzipText`, `readArchiveEntries`, `writeArchive` in each format, and `extractArchive`.
 *
 * Not caught: a collision with a property of a prototype other than `Object.prototype`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ArchiveFormat,
	type ArchiveMemberContent,
	extractArchive,
	readArchiveEntries,
	type Unzipped,
	unzip,
	unzipText,
	writeArchive,
	zip,
} from "@veyyon/coding-agent/utils/zip";
import { TempDir } from "@veyyon/utils";

const INHERITED_NAMES = Object.getOwnPropertyNames(Object.prototype).sort();
const PLAIN = "plain.txt";
const MEMBER_NAMES = [...INHERITED_NAMES, PLAIN].sort();

const dirs: TempDir[] = [];
afterEach(() => {
	while (dirs.length > 0) dirs.pop()?.removeSync();
});

function scratch(): string {
	const dir = TempDir.createSync("archive-proto-");
	dirs.push(dir);
	return dir.path();
}

/** Every member's bytes are its own name, so a value read back under the wrong name is visible. */
function sampleArchive(): Uint8Array {
	const members: Unzipped = Object.create(null);
	for (const name of MEMBER_NAMES) members[name] = new TextEncoder().encode(name);
	return zip(members);
}

async function contentText(content: ArchiveMemberContent): Promise<string> {
	if (typeof content === "string") return content;
	if (content instanceof Uint8Array) return new TextDecoder().decode(content);
	return content.text();
}

async function namesAndTexts(entries: Iterable<readonly [string, ArchiveMemberContent]>): Promise<string[][]> {
	const rows: string[][] = [];
	for (const [name, content] of entries) rows.push([name, await contentText(content)]);
	return rows.sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0));
}

const EXPECTED_ROWS = MEMBER_NAMES.map(name => [name, name]);

describe("an archive member named like an Object.prototype property", () => {
	it("sweeps the names every plain object inherits, __proto__ among them", () => {
		expect(INHERITED_NAMES).toContain("__proto__");
		expect(INHERITED_NAMES).toContain("toString");
	});

	it("is an own member of the unzipped map and reads back as its own bytes", () => {
		const entries = unzip(sampleArchive());
		expect(Object.keys(entries).sort()).toEqual(MEMBER_NAMES);
		for (const name of MEMBER_NAMES) expect(unzipText(entries, name)).toBe(name);
	});

	it("reads as absent from an archive that does not hold it", () => {
		const entries = unzip(zip({ [PLAIN]: new TextEncoder().encode(PLAIN) }));
		for (const name of INHERITED_NAMES) expect(unzipText(entries, name)).toBeUndefined();
	});

	it("is listed once, under its own name, when every member is read", async () => {
		const entries = await readArchiveEntries({ bytes: sampleArchive(), format: "zip" });
		expect(await namesAndTexts(entries)).toEqual(EXPECTED_ROWS);
	});

	for (const format of ["zip", "tar", "tar.gz"] satisfies ArchiveFormat[]) {
		it(`survives a ${format} rewrite of the archive that holds it`, async () => {
			const members = await readArchiveEntries({ bytes: sampleArchive(), format: "zip" });
			const dest = path.join(scratch(), `out.${format}`);
			await writeArchive(dest, format, members);
			const reread = await readArchiveEntries(dest);
			expect(await namesAndTexts(reread)).toEqual(EXPECTED_ROWS);
		});
	}

	it("is extracted to a file of its own name", async () => {
		const dest = scratch();
		const written = await extractArchive({ bytes: sampleArchive(), format: "zip" }, dest);
		expect(written).toBe(MEMBER_NAMES.length);
		expect(fs.readdirSync(dest).sort()).toEqual(MEMBER_NAMES);
		for (const name of MEMBER_NAMES) expect(fs.readFileSync(path.join(dest, name), "utf8")).toBe(name);
	});
});
