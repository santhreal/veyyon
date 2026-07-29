/**
 * Encryption at rest for the vault: the key, the seal, and every way opening it must fail.
 *
 * WHY THIS SUITE EXISTS. The vault's whole claim is that a file which leaves the machine is
 * worthless without a key that never leaves it. That claim is only as good as the failure
 * behaviour, so most of these tests are about failing rather than succeeding:
 *
 *   - A vault that cannot be decrypted must THROW, never return an empty vault. Empty would
 *     mean every secret it held quietly stops being obfuscated and starts reaching the model
 *     provider in plain text. That is the one outcome the feature exists to prevent, and it
 *     is what a `catch` returning `[]` would produce.
 *   - Tampering must be DETECTED rather than decrypted into garbage, which is why the mode is
 *     AES-256-GCM and the tag is checked.
 *   - A key readable by other users is refused, because the at-rest story rests entirely on
 *     that file's mode.
 *
 * The round-trip test is almost the least interesting one here.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { moveNoReplace } from "@veyyon/coding-agent/secrets/atomic-path";
import {
	isSealedVault,
	loadOrCreateVaultKey,
	openVault,
	readVaultKey,
	sealVault,
	VAULT_KEY_FILENAME,
	vaultKeyPath,
} from "@veyyon/coding-agent/secrets/vault-crypto";
import { useSpyTeardown } from "../helpers/spy-teardown";

/** A throwaway config root. */
async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-vault-crypto-"));
	try {
		await body(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

const teardown = useSpyTeardown();

describe("the vault key", () => {
	/** First use creates the key, so the feature needs no setup step. */
	it("is created on first use with 32 bytes", async () => {
		await withRoot(async root => {
			const key = await loadOrCreateVaultKey(root);

			expect(key).toHaveLength(32);
			// Compared as hex rather than as Buffers: a readable diff when it fails, and it
			// sidesteps the Buffer type variance between the runtime and the typechecker.
			expect((await fs.readFile(vaultKeyPath(root))).toString("hex")).toBe(key.toString("hex"));
		});
	});

	it("recovers an ownerless key lock left before owner metadata was published", async () => {
		await withRoot(async root => {
			const lockPath = `${vaultKeyPath(root)}.lock`;
			await fs.mkdir(lockPath);
			await fs.utimes(lockPath, 0, 0);

			expect(await loadOrCreateVaultKey(root)).toHaveLength(32);
			await expect(fs.stat(lockPath)).rejects.toThrow();
		});
	});

	/**
	 * A crash can stop the first key write before all 32 bytes reach its staging inode.
	 *
	 * Ignoring that malformed stage leaves key material and an ever-growing residue in the config
	 * root. The next transaction must remove it while still publishing one exact complete key.
	 */
	it("removes a partially written crash stage", async () => {
		await withRoot(async root => {
			const stagePath = path.join(
				root,
				`.${VAULT_KEY_FILENAME}.${process.pid}.00000000-0000-4000-8000-000000000001.tmp`,
			);
			await fs.writeFile(stagePath, Buffer.alloc(11, 0x5a), { mode: 0o600 });

			const key = await loadOrCreateVaultKey(root);

			expect(key).toHaveLength(32);
			expect(Uint8Array.from(await fs.readFile(vaultKeyPath(root)))).toEqual(Uint8Array.from(key));
			await expect(fs.lstat(stagePath)).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	/**
	 * Atomic no-replace reports `false` only for a real destination collision.
	 *
	 * Treating every kernel failure as a collision makes a missing source look like another writer
	 * won, which sends key recovery down the wrong branch and hides the primitive's actual failure.
	 */
	it("distinguishes a no-replace collision from an operating-system failure", async () => {
		await withRoot(async root => {
			const stagedPath = path.join(root, "staged");
			const destinationPath = path.join(root, "destination");
			await fs.writeFile(stagedPath, "staged");
			await fs.writeFile(destinationPath, "winner");

			expect(moveNoReplace(stagedPath, destinationPath)).toBe(false);
			expect(await fs.readFile(stagedPath, "utf8")).toBe("staged");
			expect(await fs.readFile(destinationPath, "utf8")).toBe("winner");

			const missingPath = path.join(root, "missing");
			const unusedPath = path.join(root, "unused");
			expect(() => moveNoReplace(missingPath, unusedPath)).toThrow(/operating-system error \d+/);
			await expect(fs.lstat(missingPath)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.lstat(unusedPath)).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	/**
	 * Hardening an empty directory must not authorize a replacement directory under the same name.
	 *
	 * Without carrying the pre-chmod inode into pinning, a rename during hardening makes first use
	 * silently publish the machine-wide key into an unreviewed replacement directory.
	 */
	it("refuses a key directory replaced while it is being hardened", async () => {
		if (process.platform === "win32") return;
		await withRoot(async root => {
			const displacedRoot = `${root}.displaced`;
			const realChmod = fs.chmod;
			let replaced = false;
			const chmodSpy = teardown.spy(fs, "chmod").mockImplementation(async (...args) => {
				if (!replaced && String(args[0]) === root) {
					replaced = true;
					await fs.rename(root, displacedRoot);
					await fs.mkdir(root, { mode: 0o700 });
				}
				return await Reflect.apply(realChmod, fs, args);
			});
			try {
				const failure = await loadOrCreateVaultKey(root).then(
					() => undefined,
					(error: unknown) => error,
				);

				expect(failure).toBeInstanceOf(Error);
				expect((failure as Error).message).toMatch(/directory changed while it was being hardened/i);
				expect(replaced).toBe(true);
				await expect(fs.lstat(vaultKeyPath(root))).rejects.toMatchObject({ code: "ENOENT" });
				await expect(fs.lstat(vaultKeyPath(displacedRoot))).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				chmodSpy.mockRestore();
				await fs.rm(displacedRoot, { recursive: true, force: true });
			}
		});
	});

	/**
	 * The key file is owner-only, written that way in ONE step.
	 *
	 * `writeFile` takes the mode rather than the code chmodding afterwards, because the gap
	 * between create and chmod is a window in which the key is world readable. Asserting the
	 * mode is asserting that window does not exist.
	 */
	it("is written mode 0600", async () => {
		if (process.platform === "win32") return;
		await withRoot(async root => {
			await loadOrCreateVaultKey(root);

			const stat = await fs.stat(vaultKeyPath(root));
			expect(stat.mode & 0o777).toBe(0o600);
		});
	});

	/** Reading twice returns the same key, so previously sealed vaults stay readable. */
	it("is stable across calls", async () => {
		await withRoot(async root => {
			const first = await loadOrCreateVaultKey(root);
			const second = await loadOrCreateVaultKey(root);

			expect(second).toEqual(first);
		});
	});

	/** Absent means absent, and only absent. This is the one case that answers `null`. */
	it("reads as null when there is no key", async () => {
		await withRoot(async root => {
			expect(await readVaultKey(root)).toBeNull();
		});
	});

	/**
	 * A key of the wrong length is corruption, not absence.
	 *
	 * If this returned `null`, the caller would create a NEW key beside the broken one, and
	 * every existing vault would become permanently unreadable while looking like a fresh
	 * install. Failing loudly is what preserves the chance of restoring a backup.
	 */
	it("refuses a key of the wrong length", async () => {
		await withRoot(async root => {
			await fs.writeFile(vaultKeyPath(root), Buffer.alloc(16), { mode: 0o600 });

			await expect(readVaultKey(root)).rejects.toThrow(/16 bytes, expected 32/);
		});
	});

	/**
	 * A key other users can read is refused, with the chmod that fixes it.
	 *
	 * The entire at-rest guarantee is this file's mode. A group-readable key on a shared box
	 * means every account there can decrypt the vault, so continuing would be pretending.
	 */
	it("refuses a key that other users can read", async () => {
		if (process.platform === "win32") return;
		await withRoot(async root => {
			await loadOrCreateVaultKey(root);
			await fs.chmod(vaultKeyPath(root), 0o644);

			const failure = await readVaultKey(root).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect((failure as Error).message).toContain("readable by other users");
			expect((failure as Error).message).toContain("chmod 600");
		});
	});

	/**
	 * A key alias is a scope escape, not a convenient way to share credentials.
	 *
	 * Reading through the link would make a key chosen outside this config root authoritative
	 * for every vault beneath it. The refusal must happen before any key bytes are consumed.
	 */
	it("refuses a symlinked key path", async () => {
		if (process.platform === "win32") return;
		await withRoot(async root => {
			const outside = path.join(root, "outside.key");
			await fs.writeFile(outside, Buffer.alloc(32, 7), { mode: 0o600 });
			await fs.symlink(outside, vaultKeyPath(root));

			await expect(readVaultKey(root)).rejects.toThrow(/key .* is a symlink/i);
		});
	});

	/** A symlinked config root is the same escape one path component earlier. */
	it("refuses a symlinked key directory", async () => {
		if (process.platform === "win32") return;
		await withRoot(async root => {
			const actualRoot = path.join(root, "actual");
			const linkedRoot = path.join(root, "linked");
			await fs.mkdir(actualRoot);
			await fs.writeFile(vaultKeyPath(actualRoot), Buffer.alloc(32, 7), { mode: 0o600 });
			await fs.symlink(actualRoot, linkedRoot);

			await expect(readVaultKey(linkedRoot)).rejects.toThrow(/key (directory|path).*symlink/i);
		});
	});

	/** A directory or device at the key path must never be treated as key material. */
	it("refuses a non-regular key path", async () => {
		await withRoot(async root => {
			await fs.mkdir(vaultKeyPath(root));

			await expect(readVaultKey(root)).rejects.toThrow(/not a regular file/);
		});
	});

	/** A hard link is an alias too: the same key inode must not be reachable elsewhere. */
	it("refuses a hard-linked key", async () => {
		if (process.platform === "win32") return;
		await withRoot(async root => {
			await loadOrCreateVaultKey(root);
			await fs.link(vaultKeyPath(root), path.join(root, "key-alias"));

			await expect(readVaultKey(root)).rejects.toThrow(/has 2 hard links/);
		});
	});

	/** Replacing the key between lstat and open is detected by comparing the opened inode. */
	it("refuses a key swapped during open", async () => {
		await withRoot(async root => {
			const keyPath = vaultKeyPath(root);
			const replacement = path.join(root, "replacement.key");
			await loadOrCreateVaultKey(root);
			await fs.writeFile(replacement, Buffer.alloc(32, 9), { mode: 0o600 });

			const realOpen = fs.open;
			let swapped = false;
			const openSpy = teardown.spy(fs, "open").mockImplementation(async (...args) => {
				if (!swapped && path.basename(String(args[0])) === VAULT_KEY_FILENAME) {
					swapped = true;
					await fs.rename(replacement, keyPath);
				}
				return await Reflect.apply(realOpen, fs, args);
			});
			try {
				await expect(readVaultKey(root)).rejects.toThrow(/changed while it was being opened/);
			} finally {
				openSpy.mockRestore();
			}
		});
	});

	/** The filename is fixed, since an operator has to be able to find and back it up. */
	it("lives at a documented path", async () => {
		await withRoot(async root => {
			expect(vaultKeyPath(root)).toBe(path.join(root, VAULT_KEY_FILENAME));
			expect(VAULT_KEY_FILENAME).toBe("vault.key");
		});
	});
});

describe("sealing and opening", () => {
	/** The ordinary case: what goes in comes back out. */
	it("round-trips a payload", async () => {
		await withRoot(async root => {
			const key = await loadOrCreateVaultKey(root);
			const payload = JSON.stringify({ entries: [{ name: "GITHUB_TOKEN", value: "ghp_example_value" }] });

			expect(openVault(key, sealVault(key, payload))).toBe(payload);
		});
	});

	/**
	 * The ciphertext does not contain the plaintext.
	 *
	 * The point of the whole file. Asserted against the serialised envelope, which is exactly
	 * what lands on disk and therefore exactly what leaks when the directory is copied.
	 */
	it("leaves no plaintext in the sealed envelope", async () => {
		await withRoot(async root => {
			const key = await loadOrCreateVaultKey(root);
			const secret = "ghp_a_very_recognisable_token_value";

			const onDisk = JSON.stringify(sealVault(key, JSON.stringify({ entries: [{ value: secret }] })));

			expect(onDisk).not.toContain(secret);
			expect(onDisk).not.toContain("entries");
		});
	});

	/**
	 * A fresh nonce per seal, so identical payloads do not produce identical files.
	 *
	 * Reusing a nonce under one key breaks GCM badly. This catches a refactor that hoists the
	 * IV out of the function for "efficiency".
	 */
	it("uses a different nonce every time", async () => {
		await withRoot(async root => {
			const key = await loadOrCreateVaultKey(root);
			const payload = "the same payload twice";

			const a = sealVault(key, payload);
			const b = sealVault(key, payload);

			expect(a.iv).not.toBe(b.iv);
			expect(a.ct).not.toBe(b.ct);
			expect(openVault(key, a)).toBe(payload);
			expect(openVault(key, b)).toBe(payload);
		});
	});

	/**
	 * The location binding is authenticated with the ciphertext.
	 *
	 * A copied envelope must not decrypt in another profile or scope even though both use the
	 * same machine key. Correct binding remains the ordinary positive path.
	 */
	it("binds a sealed payload to its intended location", async () => {
		await withRoot(async root => {
			const key = await loadOrCreateVaultKey(root);
			const sealed = sealVault(key, "payload", "profile:/profiles/work/vault.json");

			expect(openVault(key, sealed, "profile:/profiles/work/vault.json")).toBe("payload");
			expect(() => openVault(key, sealed, "project:/repo/.veyyon/vault.json")).toThrow(/different vault location/);
		});
	});

	it("rejects legacy v1 even when its ciphertext would otherwise be readable", async () => {
		await withRoot(async root => {
			const key = await loadOrCreateVaultKey(root);
			const sealed = { ...sealVault(key, "payload", "profile:/work/vault.json"), v: 1 };

			expect(() => openVault(key, sealed, "profile:/work/vault.json")).toThrow(
				/legacy vault format version 1.*no authenticated scope.*re-add.*intended scope/i,
			);
		});
	});

	/**
	 * The wrong key throws and says nothing is protected.
	 *
	 * This is the case a user hits after restoring a project directory without its key. The
	 * message has to say that no secret in the file is currently protected, because the
	 * tempting reaction is to shrug and carry on.
	 */
	it("throws on the wrong key", async () => {
		await withRoot(async root => {
			const key = await loadOrCreateVaultKey(root);
			const sealed = sealVault(key, "payload");
			const otherKey = Buffer.alloc(32, 7);

			const failure = (() => {
				try {
					openVault(otherKey, sealed);
					return undefined;
				} catch (error) {
					return error;
				}
			})();

			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toContain("different key");
			expect((failure as Error).message).toContain("no secret in it is being protected");
		});
	});

	/**
	 * A flipped ciphertext byte is detected, not decrypted.
	 *
	 * GCM authenticates, so this is the difference between "the file was modified" and
	 * silently handing the caller corrupted entries. Without the tag check, a bit flip could
	 * turn into a mangled credential that fails in some confusing downstream way instead.
	 */
	it("detects a modified ciphertext", async () => {
		await withRoot(async root => {
			const key = await loadOrCreateVaultKey(root);
			const sealed = sealVault(key, "payload that matters");

			const bytes = Buffer.from(sealed.ct, "base64");
			bytes[0] ^= 0xff;
			const tampered = { ...sealed, ct: bytes.toString("base64") };

			expect(() => openVault(key, tampered)).toThrow(/could not be decrypted/);
		});
	});

	/** A modified authentication tag is rejected too, not just modified ciphertext. */
	it("detects a modified tag", async () => {
		await withRoot(async root => {
			const key = await loadOrCreateVaultKey(root);
			const sealed = sealVault(key, "payload");

			const tag = Buffer.from(sealed.tag, "base64");
			tag[0] ^= 0xff;

			expect(() => openVault(key, { ...sealed, tag: tag.toString("base64") })).toThrow(/could not be decrypted/);
		});
	});

	/**
	 * Invalid base64 must not be normalized into authenticated bytes.
	 *
	 * Permissive decoders discard characters such as `!`; for an empty ciphertext that used to
	 * preserve the authenticated byte sequence and let a textually modified envelope decrypt.
	 */
	it("rejects a non-base64 ciphertext even when it decodes to authenticated empty bytes", () => {
		const key = Buffer.alloc(32, 0x42);
		const sealed = sealVault(key, "");

		expect(sealed.ct).toBe("");
		expect(() => openVault(key, { ...sealed, ct: "!!!!" })).toThrow(/ciphertext is not canonical base64/i);
	});

	/**
	 * Node and Bun can accept shortened GCM tags unless the application pins the width.
	 *
	 * A four-byte prefix is therefore adversarial rather than merely corrupt input: accepting
	 * it cuts authentication strength from 128 to 32 bits.
	 */
	it("refuses a truncated authentication tag even when its prefix is valid", async () => {
		await withRoot(async root => {
			const key = await loadOrCreateVaultKey(root);
			const sealed = sealVault(key, "payload");
			const shortTag = Buffer.from(sealed.tag, "base64").subarray(0, 4).toString("base64");

			expect(() => openVault(key, { ...sealed, tag: shortTag })).toThrow(
				/authentication tag is 4 bytes, expected 16/,
			);
		});
	});

	/** A truncated nonce is refused before the cipher is even constructed. */
	it("refuses a nonce of the wrong width", async () => {
		await withRoot(async root => {
			const key = await loadOrCreateVaultKey(root);
			const sealed = sealVault(key, "payload");

			const shortIv = Buffer.from(sealed.iv, "base64").subarray(0, 8).toString("base64");

			expect(() => openVault(key, { ...sealed, iv: shortIv })).toThrow(/nonce is 8 bytes, expected 12/);
		});
	});

	/**
	 * An unknown envelope version is an error, and the message says to upgrade.
	 *
	 * Versioned from the first release so a future format change is detected rather than
	 * attempted. The advice matters: telling a user to delete the file would destroy
	 * credentials that a newer build could have read.
	 */
	it("refuses an envelope from a newer format", async () => {
		await withRoot(async root => {
			const key = await loadOrCreateVaultKey(root);
			const sealed = sealVault(key, "payload");

			const failure = (() => {
				try {
					openVault(key, { ...sealed, v: 99 });
					return undefined;
				} catch (error) {
					return error;
				}
			})();

			expect((failure as Error).message).toContain("version 99");
			expect((failure as Error).message).toContain("Upgrade veyyon rather than deleting");
		});
	});
});

describe("recognising a sealed vault", () => {
	/** A real envelope is recognised, so a valid file is never mistaken for junk. */
	it("accepts a sealed envelope", async () => {
		await withRoot(async root => {
			const key = await loadOrCreateVaultKey(root);

			expect(isSealedVault(sealVault(key, "payload"))).toBe(true);
		});
	});

	/**
	 * Anything else is refused, including near-misses.
	 *
	 * The guard runs on whatever `JSON.parse` produced from a file on disk, so it has to cope
	 * with a hand-written file, an old plaintext format, or a truncated write.
	 */
	it("refuses values that are not sealed envelopes", () => {
		expect(isSealedVault(null)).toBe(false);
		expect(isSealedVault(undefined)).toBe(false);
		expect(isSealedVault("string")).toBe(false);
		expect(isSealedVault(42)).toBe(false);
		expect(isSealedVault([])).toBe(false);
		expect(isSealedVault({})).toBe(false);
		// A plaintext entries file, which is what an older format would look like.
		expect(isSealedVault({ entries: [] })).toBe(false);
		// Missing the tag, which is what a truncated write could produce.
		expect(isSealedVault({ v: 1, iv: "aa", ct: "bb" })).toBe(false);
		// Right keys, wrong types.
		expect(isSealedVault({ v: "1", iv: "aa", tag: "cc", ct: "bb" })).toBe(false);
	});
});
