import { afterAll, describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { quarantinePathFor, quarantineUnparseableFile, quarantineUnparseableFileSync } from "../src/quarantine-file";

const ROOTS: string[] = [];

async function mkFile(content: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "quarantine-test-"));
	ROOTS.push(root);
	const filePath = path.join(root, "config.yml");
	await Bun.write(filePath, content);
	return filePath;
}

afterAll(async () => {
	for (const root of ROOTS) {
		await fs.rm(root, { recursive: true, force: true }).catch(() => {});
	}
});

const BROKEN = ["startup:", "  quiet: true", "model: gpt: 4"].join("\n");

describe("quarantinePathFor", () => {
	test("names the copy next to the original", () => {
		expect(quarantinePathFor("/home/u/.veyyon/config.yml")).toBe("/home/u/.veyyon/config.yml.corrupt");
	});
});

describe("quarantineUnparseableFile", () => {
	test("copies the exact bytes, so the user can paste them back", async () => {
		// The rescued file is the only remaining copy of the user's config, so it
		// has to be byte-identical rather than a re-serialization of a partial
		// parse.
		const filePath = await mkFile(BROKEN);

		const quarantinePath = await quarantineUnparseableFile(filePath, BROKEN, new Error("bad yaml"));

		expect(quarantinePath).toBe(`${filePath}.corrupt`);
		expect(await Bun.file(`${filePath}.corrupt`).text()).toBe(BROKEN);
	});

	test("leaves the original in place, so the user can fix it where it lives", async () => {
		const filePath = await mkFile(BROKEN);

		await quarantineUnparseableFile(filePath, BROKEN, new Error("bad yaml"));

		expect(await Bun.file(filePath).text()).toBe(BROKEN);
	});

	test("does not overwrite an existing copy on a second call", async () => {
		// The live file gets rewritten once the caller saves. Re-quarantining then
		// would replace the user's rescued config with the new near-empty one,
		// destroying the very thing this exists to protect.
		const filePath = await mkFile(BROKEN);
		await quarantineUnparseableFile(filePath, BROKEN, new Error("first"));

		const quarantinePath = await quarantineUnparseableFile(filePath, "startup: {}", new Error("second"));

		// Still reports where the bytes are, because the user still needs to be told.
		expect(quarantinePath).toBe(`${filePath}.corrupt`);
		expect(await Bun.file(`${filePath}.corrupt`).text()).toBe(BROKEN);
	});

	test("returns undefined when nothing could be preserved", async () => {
		// An unwritable directory must not crash a launch, but it also must not
		// claim a copy exists: the caller uses the return value to tell the user
		// where their config went.
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "quarantine-ro-"));
		ROOTS.push(root);
		const filePath = path.join(root, "config.yml");
		await Bun.write(filePath, BROKEN);
		await fs.chmod(root, 0o500);
		try {
			expect(await quarantineUnparseableFile(filePath, BROKEN, new Error("bad"))).toBeUndefined();
		} finally {
			await fs.chmod(root, 0o700);
		}
	});
});

describe("quarantineUnparseableFileSync", () => {
	test("preserves the bytes the same way as the async form", async () => {
		const filePath = await mkFile(BROKEN);

		const quarantinePath = quarantineUnparseableFileSync(filePath, BROKEN, new Error("bad yaml"));

		expect(quarantinePath).toBe(`${filePath}.corrupt`);
		expect(fsSync.readFileSync(`${filePath}.corrupt`, "utf-8")).toBe(BROKEN);
	});

	test("does not overwrite a copy the async form already made", async () => {
		// The two forms have to contend on the same path: settings loads async and
		// keybindings loads sync, and both can hit the same directory.
		const filePath = await mkFile(BROKEN);
		await quarantineUnparseableFile(filePath, BROKEN, new Error("async first"));

		quarantineUnparseableFileSync(filePath, "replaced", new Error("sync second"));

		expect(fsSync.readFileSync(`${filePath}.corrupt`, "utf-8")).toBe(BROKEN);
	});
});
