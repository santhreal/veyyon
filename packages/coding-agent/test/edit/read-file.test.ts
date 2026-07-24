import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readEditFileText, serializeEditFileText } from "../../src/edit/read-file";

/**
 * readEditFileText is the shared read used by every edit-mode utility. Its
 * contract is small but load-bearing and had no test:
 *   - a plain file's exact bytes are returned unchanged;
 *   - a missing file (ENOENT) becomes a user-facing "File not found: <path>"
 *     error that references the DISPLAY path (the second argument), never the
 *     absolute path, so operators see the path they typed;
 *   - any OTHER read error (e.g. reading a directory) is rethrown UNMASKED, so a
 *     real failure is never disguised as "file not found".
 * serializeEditFileText returns the content unchanged for a non-notebook path
 * (the notebook branch is exercised by notebook.test.ts).
 */

// Every callback here is async, so the cleanup MUST await the work before it
// runs. A synchronous `finally { rmSync }` around `return fn(dir)` deletes the
// temp dir the instant the callback hits its first `await` — while the file
// read is still pending — so `readEditFileText` races an already-deleted file
// and fails with a spurious "File not found". `return await fn(dir)` inside the
// try keeps the finally suspended until the promise settles. This raced green
// locally and red on the CI runner (v1.0.35 native/unit bucket).
const withTempDir = async <T>(fn: (dir: string) => T | Promise<T>): Promise<T> => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-file-"));
	try {
		return await fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
};

describe("readEditFileText", () => {
	it("returns a plain file's exact contents", async () => {
		await withTempDir(async dir => {
			const abs = path.join(dir, "a.txt");
			fs.writeFileSync(abs, "hello world\nsecond line\n");
			expect(await readEditFileText(abs, "a.txt")).toBe("hello world\nsecond line\n");
		});
	});

	it("maps a missing file to 'File not found' using the DISPLAY path", async () => {
		await withTempDir(async dir => {
			const abs = path.join(dir, "missing.txt");
			// Display path differs from the absolute path so we can prove which is used.
			await expect(readEditFileText(abs, "src/shown.txt")).rejects.toThrow("File not found: src/shown.txt");
		});
	});

	it("rethrows a non-ENOENT read error unmasked (a directory is not 'File not found')", async () => {
		await withTempDir(async dir => {
			// Reading a directory throws EISDIR-style error, not ENOENT; it must not
			// be swallowed into the "File not found" path.
			const promise = readEditFileText(dir, "thedir");
			await expect(promise).rejects.not.toThrow("File not found");
			await expect(promise).rejects.toThrow(/director/i);
		});
	});
});

describe("serializeEditFileText", () => {
	it("returns the content unchanged for a non-notebook path", async () => {
		expect(await serializeEditFileText("/x/a.txt", "a.txt", "unchanged body")).toBe("unchanged body");
	});

	it("does not treat a plain source file as a notebook", async () => {
		expect(await serializeEditFileText("/x/main.ts", "main.ts", "const a = 1;")).toBe("const a = 1;");
	});
});
