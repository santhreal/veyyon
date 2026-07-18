import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries, TempDir } from "../src/temp";

describe("TempDir", () => {
	it("creates a real directory under the OS temp dir with the default prefix", async () => {
		const dir = await TempDir.create();
		try {
			expect(fs.statSync(dir.path()).isDirectory()).toBe(true);
			expect(dir.path().startsWith(os.tmpdir())).toBe(true);
			expect(path.basename(dir.path()).startsWith("pi-temp-")).toBe(true);
		} finally {
			await dir.remove();
		}
		expect(fs.existsSync(dir.path())).toBe(false);
	});

	it("treats an @-prefix as relative to the OS temp dir", () => {
		const dir = TempDir.createSync("@veyyon-test-");
		try {
			expect(path.dirname(dir.path())).toBe(os.tmpdir());
			expect(path.basename(dir.path()).startsWith("veyyon-test-")).toBe(true);
		} finally {
			dir.removeSync();
		}
	});

	it("removes recursively and join builds paths inside the dir", async () => {
		const dir = TempDir.createSync("@veyyon-test-");
		const nested = dir.join("a", "b");
		expect(nested).toBe(path.join(dir.path(), "a", "b"));
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(dir.join("a", "b", "f.txt"), "x");
		await dir.remove();
		expect(fs.existsSync(dir.path())).toBe(false);
	});

	it("memoizes remove() so repeat calls share one promise", async () => {
		const dir = TempDir.createSync("@veyyon-test-");
		const first = dir.remove();
		expect(dir.remove()).toBe(first);
		await first;
	});

	it("cleans up via using-declaration dispose", () => {
		let captured: string;
		{
			using dir = TempDir.createSync("@veyyon-test-");
			captured = dir.path();
			expect(fs.existsSync(captured)).toBe(true);
		}
		expect(fs.existsSync(captured)).toBe(false);
	});
});

describe("removeWithRetries", () => {
	it("succeeds on a missing target (force semantics)", async () => {
		await removeWithRetries(path.join(os.tmpdir(), "veyyon-not-there-19406"));
	});
});
