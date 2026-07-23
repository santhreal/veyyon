import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile, removeWithRetries } from "@veyyon/utils";

/**
 * atomicWriteFile must leave either the previous content or the new content —
 * never a torn partial. Drives the shipped utils export on a real temp path.
 */

describe("atomicWriteFile contracts", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("creates a new file with exact content", async () => {
		const file = path.join(tmpDir, "a.txt");
		await atomicWriteFile(file, "hello\n");
		expect(await Bun.file(file).text()).toBe("hello\n");
	});

	it("overwrites existing content completely", async () => {
		const file = path.join(tmpDir, "b.txt");
		await Bun.write(file, "OLD_CONTENT_LONG\n");
		await atomicWriteFile(file, "new\n");
		expect(await Bun.file(file).text()).toBe("new\n");
	});

	it("creates parent directories as needed", async () => {
		const file = path.join(tmpDir, "x", "y", "z.txt");
		await atomicWriteFile(file, "nested\n");
		expect(await Bun.file(file).text()).toBe("nested\n");
	});

	it("unicode content is preserved exactly", async () => {
		const file = path.join(tmpDir, "jp.txt");
		const body = "日本語\nemoji 🎉\n";
		await atomicWriteFile(file, body);
		expect(await Bun.file(file).text()).toBe(body);
	});

	it("empty content creates a zero-byte file", async () => {
		const file = path.join(tmpDir, "empty.txt");
		await atomicWriteFile(file, "");
		expect(await Bun.file(file).text()).toBe("");
		expect((await fs.stat(file)).size).toBe(0);
	});

	it("null-byte content is preserved", async () => {
		const file = path.join(tmpDir, "null.bin");
		const body = "a\0b\0c";
		await atomicWriteFile(file, body);
		expect(await Bun.file(file).text()).toBe(body);
	});

	it("sequential rewrites end at the last body", async () => {
		const file = path.join(tmpDir, "seq.txt");
		for (let i = 0; i < 10; i++) {
			await atomicWriteFile(file, `v${i}\n`);
		}
		expect(await Bun.file(file).text()).toBe("v9\n");
	});

	it("concurrent writers leave one of the full payloads, not a mix", async () => {
		const file = path.join(tmpDir, "race.txt");
		const a = `${"A".repeat(4096)}\n`;
		const b = `${"B".repeat(4096)}\n`;
		await Promise.all([atomicWriteFile(file, a), atomicWriteFile(file, b)]);
		const out = await Bun.file(file).text();
		expect(out === a || out === b).toBe(true);
		expect(out.includes("A") && out.includes("B")).toBe(false);
	});

	it("large multi-megabyte body round-trips length", async () => {
		const file = path.join(tmpDir, "large.bin");
		const body = "x".repeat(1_000_000);
		await atomicWriteFile(file, body);
		expect((await fs.stat(file)).size).toBe(1_000_000);
		const head = await Bun.file(file).text();
		expect(head.length).toBe(1_000_000);
		expect(head[0]).toBe("x");
		expect(head[head.length - 1]).toBe("x");
	});
});
