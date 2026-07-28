/**
 * Crash, concurrency, and boundary behavior for vault key publication.
 *
 * The key file is the only material that can decrypt every vault. These tests pin the exact
 * on-disk winner and prove that interrupted publication never turns a partial or exposed file
 * into an accepted key.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadOrCreateVaultKey,
	readVaultKey,
	VAULT_KEY_FILENAME,
	vaultKeyPath,
} from "@veyyon/coding-agent/secrets/vault-crypto";

const roots = new Set<string>();

async function rootFixture(label = "plain"): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `veyyon-key-transaction-${label}-`));
	roots.add(root);
	return root;
}

function stagePath(root: string): string {
	return path.join(root, `.${VAULT_KEY_FILENAME}.${process.pid}.${crypto.randomUUID()}.tmp`);
}

afterEach(async () => {
	await Promise.all([...roots].map(root => fs.rm(root, { recursive: true, force: true })));
	roots.clear();
});

describe("vault key publication", () => {
	/** Every concurrent first-use caller must receive the one inode that won publication. */
	it("returns one exact key to concurrent creators", async () => {
		const root = await rootFixture();
		const keys = await Promise.all(Array.from({ length: 16 }, () => loadOrCreateVaultKey(root)));
		const [winner] = keys;
		if (winner === undefined) throw new Error("Concurrent key creation returned no winner");

		for (const key of keys) expect(key).toEqual(winner);
		expect((await fs.readFile(vaultKeyPath(root))).equals(winner)).toBe(true);
		expect((await fs.lstat(vaultKeyPath(root))).nlink).toBe(1);
	});

	/** A crash after atomic publication leaves two links to complete bytes, which is recoverable. */
	it("recovers a synced key published before its staging link was removed", async () => {
		const root = await rootFixture();
		const bytes = crypto.randomBytes(32);
		const staged = stagePath(root);
		await fs.writeFile(staged, bytes, { mode: 0o600, flag: "wx" });
		await fs.link(staged, vaultKeyPath(root));

		expect(await readVaultKey(root)).toEqual(bytes);
		await expect(fs.lstat(staged)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await fs.lstat(vaultKeyPath(root))).nlink).toBe(1);
	});

	/** Recovery is idempotent when lockless readers observe the same two-link crash state. */
	it("lets concurrent readers converge on one recovered publication", async () => {
		const root = await rootFixture();
		const bytes = crypto.randomBytes(32);
		const staged = stagePath(root);
		await fs.writeFile(staged, bytes, { mode: 0o600, flag: "wx" });
		await fs.link(staged, vaultKeyPath(root));

		const readers = await Promise.all(Array.from({ length: 32 }, () => readVaultKey(root)));
		for (const key of readers) expect(key).toEqual(bytes);
		expect((await fs.lstat(vaultKeyPath(root))).nlink).toBe(1);
	});

	/** A crash before publication must not leave a second key-shaped residue forever. */
	it("wipes and removes an unpublished crash stage before creating the winner", async () => {
		const root = await rootFixture();
		const staged = stagePath(root);
		const abandoned = crypto.randomBytes(32);
		await fs.writeFile(staged, abandoned, { mode: 0o600, flag: "wx" });

		const winner = await loadOrCreateVaultKey(root);
		expect(winner.equals(abandoned)).toBe(false);
		await expect(fs.lstat(staged)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await fs.readFile(vaultKeyPath(root))).equals(winner)).toBe(true);
	});

	/** An intermediate symlink cannot redirect first-use key creation outside the requested tree. */
	it("rejects a symlink in an ancestor before creating any key", async () => {
		if (process.platform === "win32") return;
		const root = await rootFixture();
		const outside = path.join(root, "outside");
		const inside = path.join(root, "inside");
		await fs.mkdir(outside);
		await fs.mkdir(inside);
		await fs.symlink(outside, path.join(inside, "redirect"));
		const redirectedRoot = path.join(inside, "redirect", "config");

		await expect(loadOrCreateVaultKey(redirectedRoot)).rejects.toThrow(/crosses the symlink/);
		await expect(fs.lstat(vaultKeyPath(path.join(outside, "config")))).rejects.toMatchObject({ code: "ENOENT" });
	});

	/** First use hardens an empty writable config root before any key bytes are staged. */
	it("hardens an empty key root before creating the key", async () => {
		if (process.platform === "win32") return;
		const root = await rootFixture();
		await fs.chmod(root, 0o777);

		expect(await loadOrCreateVaultKey(root)).toHaveLength(32);
		expect((await fs.lstat(root)).mode & 0o777).toBe(0o700);
	});

	/** Hardening must not legitimize key bytes that were already exposed in a writable root. */
	it("refuses an existing key in a writable root without changing it", async () => {
		if (process.platform === "win32") return;
		const root = await rootFixture();
		const key = crypto.randomBytes(32);
		await fs.writeFile(vaultKeyPath(root), key, { mode: 0o600, flag: "wx" });
		await fs.chmod(root, 0o777);

		await expect(loadOrCreateVaultKey(root)).rejects.toThrow(/writable by other users/);
		expect(await fs.readFile(vaultKeyPath(root))).toEqual(key);
		expect((await fs.lstat(root)).mode & 0o777).toBe(0o777);
	});

	/** Recovery must not bless or remove an exposed file merely because its name looks staged. */
	it("refuses an exposed orphan publication without unlinking either path", async () => {
		if (process.platform === "win32") return;
		const root = await rootFixture();
		const staged = stagePath(root);
		await fs.writeFile(staged, crypto.randomBytes(32), { mode: 0o644, flag: "wx" });
		await fs.link(staged, vaultKeyPath(root));

		await expect(readVaultKey(root)).rejects.toThrow(/readable by other users/);
		expect((await fs.lstat(staged)).nlink).toBe(2);
		expect((await fs.lstat(vaultKeyPath(root))).nlink).toBe(2);
	});

	/** A huge sparse key is rejected from descriptor metadata before a caller-sized read allocation. */
	it("rejects an oversized sparse key at the fixed 32-byte boundary", async () => {
		const root = await rootFixture();
		const keyPath = vaultKeyPath(root);
		await fs.writeFile(keyPath, Buffer.alloc(0), { mode: 0o600 });
		await fs.truncate(keyPath, 1024 * 1024 * 1024);

		await expect(readVaultKey(root)).rejects.toThrow(/1073741824 bytes, expected 32/);
	});

	/** Terminal controls in an operator-controlled root never execute through a key error. */
	it("escapes controls from key paths in failures", async () => {
		const root = await rootFixture("bad\u001b[2Jpath");
		await fs.writeFile(vaultKeyPath(root), Buffer.alloc(16), { mode: 0o600 });

		const error = await readVaultKey(root).then(
			() => undefined,
			(reason: unknown) => reason as Error,
		);
		expect(error).toBeInstanceOf(Error);
		expect(error?.message).not.toContain("\u001b");
		expect(error?.message).toContain("\\u001B[2J");
	});
});
