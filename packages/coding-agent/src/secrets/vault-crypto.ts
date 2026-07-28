/**
 * Encryption at rest for the secret vault, and the one place the key lives.
 *
 * THREAT MODEL, stated plainly because encryption claims are worthless without one.
 *
 * This protects a vault file that LEAVES the machine. That is the real exposure: a project
 * directory gets committed, rsynced, exported over NFS, backed up to a remote, or copied
 * off a stolen disk, and a plaintext credential file goes with it. The key never lives in a
 * project tree, so a project-scoped vault can sit inside a committed, backed-up directory
 * and be worthless on its own.
 *
 * It does NOT protect against someone already running as you. The key is readable by your
 * own account by design, because the alternative is a passphrase prompt on every session,
 * and a credential store nobody turns on protects nothing. If you need protection against
 * a compromised account, this is the wrong layer: use a hardware token or an external
 * secret manager.
 *
 * ONE KEY, IN THE CROSS-PROFILE ROOT. Not one key per profile, because a project-scoped
 * vault has to be readable from whichever profile you open that project with, and not one
 * key per vault, because then the key count grows with the vault count and every one of
 * them is another thing to lose. `~/.veyyon/vault.key`, mode 0600.
 *
 * NO SILENT FALLBACK ANYWHERE IN THIS FILE. A missing key with no vault is fine (nothing
 * has been stored yet). A vault that exists with no readable key is a hard error, never an
 * empty vault, because "empty" would mean those secrets stop being obfuscated and start
 * flowing to the model provider in plain text. Decryption failure is a hard error for the
 * same reason: a truncated or tampered vault must not read as "you have no secrets".
 */
import * as crypto from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage, isMissingPath, withFileLock } from "@veyyon/utils";

/** Name of the key file inside the cross-profile config root. */
export const VAULT_KEY_FILENAME = "vault.key";

/** AES-256 needs exactly 32 bytes. */
const KEY_BYTES = 32;

/** GCM's standard nonce width. Twelve bytes is the size the mode is defined for. */
const IV_BYTES = 12;

/** GCM authentication tags are never accepted at a reduced strength. */
const TAG_BYTES = 16;

/** Owner read and write only. The whole at-rest story rests on this. */
const KEY_FILE_MODE = 0o600;

/** Opening the checked descriptor closes the lstat/read race and never follows the final link. */
const KEY_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

/** Exclusive creation prevents a link or existing file from being overwritten. */
const KEY_CREATE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;

/**
 * A sealed vault payload as it sits on disk.
 *
 * Versioned from the first release so a later format change can be detected rather than
 * guessed at. Version 2 authenticates the vault-location binding as associated data so
 * ciphertext cannot be moved between scopes. Legacy version 1 envelopes are recognised only
 * to reject them explicitly: they contain no authenticated provenance and cannot be migrated
 * into a scope safely.
 */
export interface SealedVault {
	/** Envelope version. Writers and readers require 2. */
	v: number;
	/** Base64 nonce, fresh for every seal. */
	iv: string;
	/** Base64 GCM authentication tag. */
	tag: string;
	/** Base64 ciphertext. */
	ct: string;
}

/** The only envelope version with authenticated scope provenance. */
const ENVELOPE_VERSION = 2;

/** A live PID is never reaped; dead owners are still detected immediately by the shared lock. */
const KEY_LOCK_OPTIONS = { staleMs: Number.POSITIVE_INFINITY } as const;

/** Absolute path of the key file, given the cross-profile config root. */
export function vaultKeyPath(globalConfigRoot: string): string {
	return path.join(globalConfigRoot, VAULT_KEY_FILENAME);
}

/** Reject a config root that redirects the key path before checking the final file. */
async function keyRootExistsSafely(globalConfigRoot: string): Promise<boolean> {
	let stat: Stats;
	try {
		stat = await fs.lstat(globalConfigRoot);
	} catch (error) {
		if (isMissingPath(error)) return false;
		throw error;
	}
	if (stat.isSymbolicLink()) {
		throw new Error(`The vault key directory at ${globalConfigRoot} is a symlink. Refusing to follow it.`);
	}
	if (!stat.isDirectory()) {
		throw new Error(`The vault key directory at ${globalConfigRoot} is not a directory. Refusing to use it.`);
	}
	return true;
}

/**
 * Read the vault key, creating it on first use.
 *
 * Creation is serialised across processes, exclusive at the filesystem seam, and synced
 * before it is returned. A vault must never become durable while the only key that can open
 * it is still sitting in the page cache.
 */
export async function loadOrCreateVaultKey(globalConfigRoot: string): Promise<Buffer> {
	const keyPath = vaultKeyPath(globalConfigRoot);
	if (!(await keyRootExistsSafely(globalConfigRoot))) {
		await fs.mkdir(globalConfigRoot, { recursive: true });
	}
	if (!(await keyRootExistsSafely(globalConfigRoot))) {
		throw new Error(`The vault key directory at ${globalConfigRoot} disappeared while it was being created.`);
	}
	return await withFileLock(
		keyPath,
		async () => {
			const raced = await readVaultKey(globalConfigRoot);
			if (raced !== null) return raced;

			const key = crypto.randomBytes(KEY_BYTES);
			let handle;
			try {
				handle = await fs.open(keyPath, KEY_CREATE_FLAGS, KEY_FILE_MODE);
			} catch (error) {
				const winner = await readVaultKey(globalConfigRoot);
				if (winner !== null) return winner;
				throw new Error(
					`Could not create the vault key at ${keyPath} (${String(error)}). ` +
						`Secrets cannot be stored without it.`,
				);
			}
			let createdStat: Stats | null = null;
			let complete = false;
			try {
				createdStat = await handle.stat();
				await handle.writeFile(key);
				await handle.sync();
				complete = true;
			} finally {
				try {
					await handle.close();
				} finally {
					if (!complete && createdStat !== null) {
						await removeCreatedKeyIfUnchanged(keyPath, createdStat).catch(() => {});
					}
				}
			}
			await syncDirectory(globalConfigRoot);
			return key;
		},
		KEY_LOCK_OPTIONS,
	);
}

/**
 * Read the vault key, or `null` when it does not exist.
 *
 * `null` means ABSENT and nothing else. An unreadable key, a key of the wrong length, or a
 * key with permissions that expose it are all errors, because each one means a vault that
 * cannot be opened, and answering "no key" there would be read by callers as "no secrets".
 */
export async function readVaultKey(globalConfigRoot: string): Promise<Buffer | null> {
	if (!(await keyRootExistsSafely(globalConfigRoot))) return null;
	const keyPath = vaultKeyPath(globalConfigRoot);
	let pathStat: Stats;
	try {
		pathStat = await fs.lstat(keyPath);
	} catch (error) {
		if (isMissingPath(error)) return null;
		throw keyReadError(keyPath, error);
	}
	assertKeyPathSafe(keyPath, pathStat, true);

	let handle;
	try {
		handle = await fs.open(keyPath, KEY_READ_FLAGS);
	} catch (error) {
		throw keyReadError(keyPath, error);
	}

	let key: Buffer;
	try {
		const openStat = await handle.stat();
		assertKeyPathSafe(keyPath, openStat, false);
		if (openStat.dev !== pathStat.dev || openStat.ino !== pathStat.ino) {
			throw new Error(`The vault key at ${keyPath} changed while it was being opened. Refusing to read it.`);
		}
		assertKeyNotExposed(keyPath, openStat);
		key = await handle.readFile();
	} finally {
		await handle.close();
	}

	if (key.length !== KEY_BYTES) {
		throw new Error(
			`The vault key at ${keyPath} is ${key.length} bytes, expected ${KEY_BYTES}. ` +
				`The file is corrupt or is not a veyyon vault key. Restore it from a backup, or delete it ` +
				`and re-add your secrets: an unreadable key means the vault cannot be opened.`,
		);
	}
	return key;
}

function keyReadError(keyPath: string, error: unknown): Error {
	return new Error(
		`The vault key at ${keyPath} exists but could not be read (${String(error)}). ` +
			`Fix its permissions. Your stored secrets cannot be decrypted without it.`,
	);
}

/** Reject aliases and special files before any bytes are consumed. */
function assertKeyPathSafe(keyPath: string, stat: Stats, fromPath: boolean): void {
	if (fromPath && stat.isSymbolicLink()) {
		throw new Error(`The vault key at ${keyPath} is a symlink. Refusing to follow it across the vault boundary.`);
	}
	if (!stat.isFile()) {
		throw new Error(`The vault key at ${keyPath} is not a regular file. Refusing to read it.`);
	}
	if (stat.nlink !== 1) {
		throw new Error(
			`The vault key at ${keyPath} has ${stat.nlink} hard links. Refusing a key that is reachable through another path.`,
		);
	}
}

/** Refuse a key file that other users on the machine can read, using the opened inode's stat. */
function assertKeyNotExposed(keyPath: string, stat: Stats): void {
	if (process.platform === "win32") return;
	const exposed = stat.mode & 0o077;
	if (exposed === 0) return;
	throw new Error(
		`The vault key at ${keyPath} is readable by other users (mode ${(stat.mode & 0o777).toString(8)}). ` +
			`Anyone who can read it can decrypt every secret you have stored. ` +
			`Run: chmod 600 ${keyPath}`,
	);
}

/** Remove a failed exclusive creation only when the path still names our inode. */
async function removeCreatedKeyIfUnchanged(keyPath: string, createdStat: Stats): Promise<void> {
	const stat = await fs.lstat(keyPath);
	if (stat.isFile() && stat.dev === createdStat.dev && stat.ino === createdStat.ino) await fs.rm(keyPath);
}

/** Persist a newly-created directory entry after the file itself has been synced. */
async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await fs.open(directory, fsConstants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * Seal a plaintext payload under the vault key.
 *
 * `binding` identifies the intended vault scope and path. It is authenticated, not stored:
 * moving the envelope to another scope therefore fails closed without revealing that path
 * in the file. Callers that do not represent a filesystem vault may omit it.
 */
export function sealVault(key: Buffer, plaintext: string, binding?: string): SealedVault {
	const iv = crypto.randomBytes(IV_BYTES);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
	cipher.setAAD(vaultAssociatedData(binding));
	const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return {
		v: ENVELOPE_VERSION,
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		ct: ct.toString("base64"),
	};
}

/**
 * Open a sealed payload, or throw.
 *
 * THROWS RATHER THAN RETURNING EMPTY on any failure: wrong key, truncated file, flipped
 * bit, hand-edited ciphertext. GCM authenticates, so tampering is detected rather than
 * decrypted into garbage. Returning an empty vault on failure would silently stop
 * protecting every secret it held, which is the one outcome this module exists to prevent.
 */
export function openVault(key: Buffer, sealed: SealedVault, binding?: string): string {
	if (sealed.v === 1) {
		throw new Error(
			"Legacy vault format version 1 has no authenticated scope or path. " +
				"Refusing to guess its provenance; re-add its credentials into the intended scope.",
		);
	}
	if (sealed.v !== ENVELOPE_VERSION) {
		throw new Error(
			`This vault was written in format version ${sealed.v}, and this build understands version ` +
				`${ENVELOPE_VERSION}. Upgrade veyyon rather than deleting the file.`,
		);
	}

	const iv = Buffer.from(sealed.iv, "base64");
	const tag = Buffer.from(sealed.tag, "base64");
	if (iv.length !== IV_BYTES) {
		throw new Error(`This vault's nonce is ${iv.length} bytes, expected ${IV_BYTES}. The file is corrupt.`);
	}
	if (tag.length !== TAG_BYTES) {
		throw new Error(
			`This vault's authentication tag is ${tag.length} bytes, expected ${TAG_BYTES}. The file is corrupt.`,
		);
	}

	try {
		const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
		decipher.setAAD(vaultAssociatedData(binding));
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]).toString("utf8");
	} catch (error) {
		throw new Error(
			`This vault could not be decrypted (${errorMessage(error)}). ` +
				`Either it was written with a different key or for a different vault location, or the file has been modified. ` +
				`Nothing is being read from it, and no secret in it is being protected right now.`,
		);
	}
}

/** Domain-separate the location binding from every other use of the same key. */
function vaultAssociatedData(binding: string | undefined): Buffer {
	return Buffer.from(`veyyon:vault:v2\0${binding ?? ""}`, "utf8");
}

/** Whether a value read from disk has the shape of a sealed vault. */
export function isSealedVault(value: unknown): value is SealedVault {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.v === "number" && typeof v.iv === "string" && typeof v.tag === "string" && typeof v.ct === "string";
}
