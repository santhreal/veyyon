import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	atomicWriteFile,
	atomicWriteFilePreservingMode,
	atomicWriteFileSync,
	atomicWriteJson,
} from "../src/atomic-write";

describe("atomicWriteFile", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-write-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes string content to a new file", async () => {
		const target = join(dir, "output.txt");
		await atomicWriteFile(target, "hello world");
		expect(readFileSync(target, "utf8")).toBe("hello world");
	});

	it("overwrites an existing file", async () => {
		const target = join(dir, "output.txt");
		writeFileSync(target, "old content");
		await atomicWriteFile(target, "new content");
		expect(readFileSync(target, "utf8")).toBe("new content");
	});

	it("writes binary data", async () => {
		const target = join(dir, "output.bin");
		const data = new Uint8Array([0, 1, 2, 3, 255]);
		await atomicWriteFile(target, data);
		const written = readFileSync(target);
		expect(written).toEqual(Buffer.from(data));
	});

	it("creates parent directories if needed", async () => {
		const target = join(dir, "subdir", "nested", "output.txt");
		await atomicWriteFile(target, "nested content");
		expect(readFileSync(target, "utf8")).toBe("nested content");
	});

	it("writes to a path that is a symlink", async () => {
		const real = join(dir, "real.txt");
		const link = join(dir, "link.txt");
		writeFileSync(real, "original");
		symlinkSync(real, link);
		await atomicWriteFile(link, "via symlink");
		expect(readFileSync(real, "utf8")).toBe("via symlink");
	});

	it("honors mode option", async () => {
		const target = join(dir, "mode.txt");
		await atomicWriteFile(target, "data", { mode: 0o600 });
		const stat = statSync(target);
		expect(stat.mode & 0o777).toBe(0o600);
	});

	it("preserves existing file mode with atomicWriteFilePreservingMode", async () => {
		const target = join(dir, "preserve.txt");
		writeFileSync(target, "initial", { mode: 0o644 });
		await atomicWriteFilePreservingMode(target, "updated");
		const stat = statSync(target);
		expect(stat.mode & 0o777).toBe(0o644);
	});

	it("uses default mode with atomicWriteFilePreservingMode for new file", async () => {
		const target = join(dir, "new.txt");
		await atomicWriteFilePreservingMode(target, "data", { defaultMode: 0o600 });
		const stat = statSync(target);
		expect(stat.mode & 0o777).toBe(0o600);
	});

	it("handles empty string content", async () => {
		const target = join(dir, "empty.txt");
		await atomicWriteFile(target, "");
		expect(readFileSync(target, "utf8")).toBe("");
	});

	it("handles large content", async () => {
		const target = join(dir, "large.txt");
		const content = "x".repeat(100_000);
		await atomicWriteFile(target, content);
		expect(readFileSync(target, "utf8")).toBe(content);
	});
});

describe("atomicWriteFileSync", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-sync-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes string content synchronously", () => {
		const target = join(dir, "sync.txt");
		atomicWriteFileSync(target, "sync content");
		expect(readFileSync(target, "utf8")).toBe("sync content");
	});

	it("overwrites existing file synchronously", () => {
		const target = join(dir, "sync.txt");
		writeFileSync(target, "old");
		atomicWriteFileSync(target, "new");
		expect(readFileSync(target, "utf8")).toBe("new");
	});

	it("writes binary data synchronously", () => {
		const target = join(dir, "sync.bin");
		const data = new Uint8Array([10, 20, 30]);
		atomicWriteFileSync(target, data);
		expect(readFileSync(target)).toEqual(Buffer.from(data));
	});

	it("creates parent directories synchronously", () => {
		const target = join(dir, "deep", "dir", "file.txt");
		atomicWriteFileSync(target, "deep sync");
		expect(readFileSync(target, "utf8")).toBe("deep sync");
	});

	it("honors mode option synchronously", () => {
		const target = join(dir, "mode.txt");
		atomicWriteFileSync(target, "data", { mode: 0o600 });
		expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	it("handles empty string", () => {
		const target = join(dir, "empty.txt");
		atomicWriteFileSync(target, "");
		expect(readFileSync(target, "utf8")).toBe("");
	});
});

describe("atomicWriteJson", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-json-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes JSON with 2-space indentation and trailing newline", async () => {
		const target = join(dir, "data.json");
		await atomicWriteJson(target, { name: "test", value: 42 });
		const content = readFileSync(target, "utf8");
		expect(content).toBe('{\n  "name": "test",\n  "value": 42\n}\n');
	});

	it("writes empty object", async () => {
		const target = join(dir, "empty.json");
		await atomicWriteJson(target, {});
		expect(readFileSync(target, "utf8")).toBe("{}\n");
	});

	it("writes array", async () => {
		const target = join(dir, "array.json");
		await atomicWriteJson(target, [1, 2, 3]);
		expect(readFileSync(target, "utf8")).toBe("[\n  1,\n  2,\n  3\n]\n");
	});

	it("writes nested objects", async () => {
		const target = join(dir, "nested.json");
		await atomicWriteJson(target, { outer: { inner: "value" } });
		const content = readFileSync(target, "utf8");
		expect(content).toContain('"outer": {\n    "inner": "value"');
	});

	it("writes null", async () => {
		const target = join(dir, "null.json");
		await atomicWriteJson(target, null);
		expect(readFileSync(target, "utf8")).toBe("null\n");
	});

	it("writes string", async () => {
		const target = join(dir, "string.json");
		await atomicWriteJson(target, "hello");
		expect(readFileSync(target, "utf8")).toBe('"hello"\n');
	});

	it("writes number", async () => {
		const target = join(dir, "number.json");
		await atomicWriteJson(target, 42);
		expect(readFileSync(target, "utf8")).toBe("42\n");
	});

	it("overwrites existing JSON file", async () => {
		const target = join(dir, "overwrite.json");
		await atomicWriteJson(target, { old: true });
		await atomicWriteJson(target, { new: true });
		const content = readFileSync(target, "utf8");
		expect(content).toContain('"new": true');
		expect(content).not.toContain('"old"');
	});
});
