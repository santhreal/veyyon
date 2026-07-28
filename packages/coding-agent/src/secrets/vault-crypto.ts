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
import {
	applyOwnerOnlyWindowsAcl,
	errorMessage,
	escapeTerminalText,
	isMissingPath,
	verifyOwnerOnlyWindowsAcl,
	withFileLock,
} from "@veyyon/utils";
import { moveNoReplace } from "./atomic-path";

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

/** Staging is exclusive; the final key is published later with an atomic no-overwrite link. */
const KEY_CREATE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;

/** A live PID is never reaped; dead owners are still detected immediately by the shared lock. */
const KEY_LOCK_OPTIONS = { staleMs: Number.POSITIVE_INFINITY } as const;

const KEY_STAGE_RE = /^\.vault\.key\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
const MAX_KEY_STAGE_SCAN_ENTRIES = 4096;

interface KeyRootPin {
	readonly root: string;
	readonly ioRoot: string;
	readonly handle: fs.FileHandle;
	readonly dev: number;
	readonly ino: number;
}

interface KeySnapshot {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
	readonly nlink: number;
	readonly mode: number;
	readonly uid: number;
}

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

/** Absolute path of the key file, given the cross-profile config root. */
export function vaultKeyPath(globalConfigRoot: string): string {
	return path.join(globalConfigRoot, VAULT_KEY_FILENAME);
}

function safeText(value: string): string {
	return escapeTerminalText(value);
}

function safeError(error: unknown): string {
	return escapeTerminalText(String(error));
}

function sameInode(
	left: Pick<Stats, "dev" | "ino">,
	right: Pick<Stats, "dev" | "ino">,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function keySnapshot(stat: Stats): KeySnapshot {
	return {
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
		nlink: stat.nlink,
		mode: stat.mode,
		uid: stat.uid,
	};
}

function sameKeySnapshot(snapshot: KeySnapshot, stat: Stats): boolean {
	return (
		snapshot.dev === stat.dev &&
		snapshot.ino === stat.ino &&
		snapshot.size === stat.size &&
		snapshot.mtimeMs === stat.mtimeMs &&
		snapshot.ctimeMs === stat.ctimeMs &&
		snapshot.nlink === stat.nlink &&
		snapshot.mode === stat.mode &&
		snapshot.uid === stat.uid
	);
}

async function assertNoSymlinkPathComponents(target: string): Promise<void> {
	const resolved = path.resolve(target);
	const parsed = path.parse(resolved);
	let current = parsed.root;
	for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink()) {
				throw new Error(
					`The vault key path crosses the symlink at ${safeText(current)}. Refusing to leave the config boundary.`,
				);
			}
		} catch (error) {
			if (isMissingPath(error)) return;
			throw error;
		}
	}
}

function assertKeyRootNotExposed(root: string, stat: Stats): void {
	if (process.platform === "win32") return;
	const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
	if (effectiveUid !== undefined && stat.uid !== effectiveUid) {
		throw new Error(`The vault key directory at ${safeText(root)} is not owned by the current user.`);
	}
	if ((stat.mode & 0o022) !== 0) {
		throw new Error(
			`The vault key directory at ${safeText(root)} is writable by other users ` +
				`(mode ${(stat.mode & 0o777).toString(8)}). Run: chmod 700 ${safeText(root)}`,
		);
	}
}

async function hardenEmptyKeyRoot(root: string): Promise<void> {
	await assertNoSymlinkPathComponents(root);
	let rootStat: Stats;
	try {
		rootStat = await fs.lstat(root);
	} catch (error) {
		if (isMissingPath(error)) return;
		throw error;
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
	const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
	if (effectiveUid !== undefined && rootStat.uid !== effectiveUid) {
		throw new Error(`The vault key directory at ${safeText(root)} is not owned by the current user.`);
	}
	const keyPath = vaultKeyPath(root);
	try {
		await fs.lstat(keyPath);
		return;
	} catch (error) {
		if (!isMissingPath(error)) throw error;
	}
	if (process.platform !== "win32") await fs.chmod(root, 0o700);
	await applyOwnerOnlyWindowsAcl(root);
	await verifyOwnerOnlyWindowsAcl(root);
	try {
		await fs.lstat(keyPath);
		throw new Error("A vault key appeared while its empty directory was being hardened. Refusing it.");
	} catch (error) {
		if (!isMissingPath(error)) throw error;
	}
}

function pinnedKeyPath(pin: KeyRootPin): string {
	return path.join(pin.ioRoot, VAULT_KEY_FILENAME);
}

async function closeKeyRootPin(pin: KeyRootPin): Promise<void> {
	await pin.handle.close();
}

/** Pin the config root inode before any key path or lock operation. */
async function pinKeyRoot(globalConfigRoot: string): Promise<KeyRootPin | null> {
	await assertNoSymlinkPathComponents(globalConfigRoot);
	let before: Stats;
	try {
		before = await fs.lstat(globalConfigRoot);
	} catch (error) {
		if (isMissingPath(error)) return null;
		throw new Error(
			`The vault key directory at ${safeText(globalConfigRoot)} could not be inspected safely ` +
				`(${safeError(error)}).`,
		);
	}
	if (before.isSymbolicLink()) {
		throw new Error(
			`The vault key directory at ${safeText(globalConfigRoot)} is a symlink. Refusing to follow it.`,
		);
	}
	if (!before.isDirectory()) {
		throw new Error(
			`The vault key directory at ${safeText(globalConfigRoot)} is not a directory. Refusing to use it.`,
		);
	}
	assertKeyRootNotExposed(globalConfigRoot, before);

	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(
			globalConfigRoot,
			fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | fsConstants.O_NOFOLLOW,
		);
		const opened = await handle.stat();
		const after = await fs.lstat(globalConfigRoot);
		if (
			!opened.isDirectory() ||
			!after.isDirectory() ||
			after.isSymbolicLink() ||
			!sameInode(before, opened) ||
			!sameInode(opened, after)
		) {
			throw new Error("The vault key directory changed while its physical identity was being pinned.");
		}
		assertKeyRootNotExposed(globalConfigRoot, opened);
		await verifyOwnerOnlyWindowsAcl(globalConfigRoot);
		const ioRoot =
			process.platform === "linux"
				? `/proc/self/fd/${handle.fd}`
				: process.platform === "darwin"
					? `/dev/fd/${handle.fd}`
					: globalConfigRoot;
		return { root: globalConfigRoot, ioRoot, handle, dev: after.dev, ino: after.ino };
	} catch (error) {
		await handle?.close().catch(() => {});
		throw error;
	}
}

async function verifyKeyRootPin(pin: KeyRootPin): Promise<void> {
	let lexical: Stats;
	let opened: Stats;
	try {
		[lexical, opened] = await Promise.all([fs.lstat(pin.root), pin.handle.stat()]);
	} catch (error) {
		throw new Error(
			`The vault key directory changed during the transaction (${safeError(error)}). Refusing to continue.`,
		);
	}
	if (
		!lexical.isDirectory() ||
		lexical.isSymbolicLink() ||
		!opened.isDirectory() ||
		lexical.dev !== pin.dev ||
		lexical.ino !== pin.ino ||
		opened.dev !== pin.dev ||
		opened.ino !== pin.ino
	) {
		throw new Error("The vault key directory changed during the transaction. Refusing to continue.");
	}
	assertKeyRootNotExposed(pin.root, lexical);
}

/** Reject aliases and special files before any bytes are consumed. */
function assertKeyPathSafe(keyPath: string, stat: Stats, fromPath: boolean, allowPublishedStage = false): void {
	if (fromPath && stat.isSymbolicLink()) {
		throw new Error(
			`The vault key at ${safeText(keyPath)} is a symlink. Refusing to follow it across the vault boundary.`,
		);
	}
	if (!stat.isFile()) {
		throw new Error(`The vault key at ${safeText(keyPath)} is not a regular file. Refusing to read it.`);
	}
	const expectedLinks = allowPublishedStage ? 2 : 1;
	if (stat.nlink !== expectedLinks) {
		throw new Error(
			`The vault key at ${safeText(keyPath)} has ${stat.nlink} hard links. ` +
				`Refusing a key that is reachable through another path.`,
		);
	}
}

/** Refuse foreign ownership or any group/other permission bits on POSIX. */
function assertKeyNotExposed(keyPath: string, stat: Stats): void {
	if (process.platform === "win32") return;
	const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
	if (effectiveUid !== undefined && stat.uid !== effectiveUid) {
		throw new Error(
			`The vault key at ${safeText(keyPath)} is owned by user ${stat.uid}, not the current user. Refusing it.`,
		);
	}
	const exposed = stat.mode & 0o077;
	if (exposed === 0) return;
	throw new Error(
		`The vault key at ${safeText(keyPath)} is readable by other users (mode ${(stat.mode & 0o777).toString(8)}). ` +
			`Anyone who can read it can decrypt every stored secret. ` +
			`Run: chmod 600 ${safeText(keyPath)}`,
	);
}

async function removePathIfSameInode(
	target: string,
	identity: Pick<Stats, "dev" | "ino">,
): Promise<boolean> {
	try {
		const current = await fs.lstat(target);
		if (!current.isFile() || !sameInode(current, identity)) return false;
		await fs.rm(target);
		try {
			await fs.lstat(target);
			return false;
		} catch (error) {
			if (isMissingPath(error)) return true;
			throw error;
		}
	} catch (error) {
		if (isMissingPath(error)) return false;
		throw error;
	}
}

async function syncDirectory(pin: KeyRootPin): Promise<void> {
	await verifyKeyRootPin(pin);
	if (process.platform !== "win32") {
		const stat = await pin.handle.stat();
		if (!stat.isDirectory() || stat.dev !== pin.dev || stat.ino !== pin.ino) {
			throw new Error("The vault key directory changed before it could be synced.");
		}
		await pin.handle.sync();
	}
	await verifyKeyRootPin(pin);
}

/**
 * Find the single trusted stage link left by a crash after publication, unlink it, and persist
 * the now-single-link final key. No unbounded readdir allocation is permitted on this path.
 */
async function recoverPublishedKey(pin: KeyRootPin, keyPath: string, publishedStat: Stats): Promise<boolean> {
	if (!publishedStat.isFile() || publishedStat.nlink !== 2 || publishedStat.size !== KEY_BYTES) return false;
	assertKeyPathSafe(keyPath, publishedStat, true, true);
	assertKeyNotExposed(keyPath, publishedStat);
	await verifyOwnerOnlyWindowsAcl(keyPath);
	let seen = 0;
	const directory = await fs.opendir(pin.ioRoot);
	try {
		for await (const entry of directory) {
			if (!entry.isFile() || !KEY_STAGE_RE.test(entry.name)) continue;
			if (++seen > MAX_KEY_STAGE_SCAN_ENTRIES) {
				throw new Error("Too many vault key staging entries exist to recover one safely.");
			}
			const candidatePath = path.join(pin.ioRoot, entry.name);
			let candidate: Stats;
			try {
				candidate = await fs.lstat(candidatePath);
			} catch (error) {
				if (isMissingPath(error)) continue;
				throw error;
			}
			if (
				!candidate.isFile() ||
				candidate.isSymbolicLink() ||
				candidate.nlink !== 2 ||
				candidate.size !== KEY_BYTES ||
				!sameInode(candidate, publishedStat)
			) {
				continue;
			}
			assertKeyNotExposed(candidatePath, candidate);
			await verifyOwnerOnlyWindowsAcl(candidatePath);
			await verifyKeyRootPin(pin);
			const finalNow = await fs.lstat(keyPath);
			assertKeyPathSafe(keyPath, finalNow, true, true);
			assertKeyNotExposed(keyPath, finalNow);
			if (!sameInode(finalNow, publishedStat) || finalNow.nlink !== 2) {
				throw new Error("The published vault key changed during orphan recovery.");
			}
			await syncDirectory(pin);
			if (!(await removePathIfSameInode(candidatePath, candidate))) {
				const progressed = await fs.lstat(keyPath);
				if (!sameInode(progressed, publishedStat) || progressed.nlink !== 1) {
					throw new Error("The published vault key staging link changed during orphan recovery.");
				}
			}
			const recovered = await fs.lstat(keyPath);
			assertKeyPathSafe(keyPath, recovered, true);
			assertKeyNotExposed(keyPath, recovered);
			if (!sameInode(recovered, publishedStat)) {
				throw new Error("The published vault key changed after orphan recovery.");
			}
			await syncDirectory(pin);
			return true;
		}
	} finally {
		try {
			await directory.close();
		} catch {
			// `for await` closes the directory on normal completion.
		}
	}
	return false;
}

async function cleanupUnpublishedStages(pin: KeyRootPin): Promise<void> {
	let candidates = 0;
	let changed = false;
	const directory = await fs.opendir(pin.ioRoot);
	try {
		for await (const entry of directory) {
			if (!entry.isFile() || !KEY_STAGE_RE.test(entry.name)) continue;
			if (++candidates > MAX_KEY_STAGE_SCAN_ENTRIES) {
				throw new Error("Too many vault key staging entries exist to clean safely.");
			}
			const candidatePath = path.join(pin.ioRoot, entry.name);
			let stat: Stats;
			try {
				stat = await fs.lstat(candidatePath);
			} catch (error) {
				if (isMissingPath(error)) continue;
				throw error;
			}
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== KEY_BYTES) continue;
			assertKeyNotExposed(candidatePath, stat);
			await verifyOwnerOnlyWindowsAcl(candidatePath);
			const handle = await fs.open(candidatePath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
			try {
				const opened = await handle.stat();
				if (!sameKeySnapshot(keySnapshot(stat), opened)) continue;
				await handle.truncate(0);
				await handle.sync();
			} finally {
				await handle.close();
			}
			changed = (await removePathIfSameInode(candidatePath, stat)) || changed;
		}
	} finally {
		try {
			await directory.close();
		} catch {
			// `for await` closes the descriptor after normal completion.
		}
	}
	if (changed) await syncDirectory(pin);
}

function keyReadError(keyPath: string, error: unknown): Error {
	return new Error(
		`The vault key at ${safeText(keyPath)} exists but could not be read (${safeError(error)}). ` +
			`Fix its permissions. Stored secrets cannot be decrypted without it.`,
	);
}

async function readVaultKeyPinned(pin: KeyRootPin): Promise<Buffer | null> {
	const displayKeyPath = vaultKeyPath(pin.root);
	const keyPath = pinnedKeyPath(pin);
	await verifyKeyRootPin(pin);
	let pathStat: Stats;
	try {
		pathStat = await fs.lstat(keyPath);
	} catch (error) {
		if (isMissingPath(error)) {
			await verifyKeyRootPin(pin);
			return null;
		}
		throw keyReadError(displayKeyPath, error);
	}
	if (pathStat.nlink === 2) {
		await recoverPublishedKey(pin, keyPath, pathStat);
		pathStat = await fs.lstat(keyPath);
	}
	assertKeyPathSafe(displayKeyPath, pathStat, true);
	assertKeyNotExposed(displayKeyPath, pathStat);
	const snapshot = keySnapshot(pathStat);

	let handle;
	try {
		handle = await fs.open(keyPath, KEY_READ_FLAGS);
	} catch (error) {
		throw keyReadError(displayKeyPath, error);
	}

	let key: Buffer;
	try {
		const openStat = await handle.stat();
		assertKeyPathSafe(displayKeyPath, openStat, false);
		if (!sameKeySnapshot(snapshot, openStat)) {
			throw new Error(`The vault key at ${safeText(displayKeyPath)} changed while it was being opened.`);
		}
		assertKeyNotExposed(displayKeyPath, openStat);
		await verifyOwnerOnlyWindowsAcl(keyPath);
		const afterAclStat = await fs.lstat(keyPath);
		if (!sameKeySnapshot(snapshot, afterAclStat)) {
			throw new Error(`The vault key at ${safeText(displayKeyPath)} changed during its ACL check.`);
		}
		if (openStat.size !== KEY_BYTES) {
			throw new Error(
				`The vault key at ${safeText(displayKeyPath)} is ${openStat.size} bytes, expected ${KEY_BYTES}. ` +
					`The file is corrupt or is not a veyyon vault key. Restore it from a backup, or delete it ` +
					`and re-add your secrets: an unreadable key means the vault cannot be opened.`,
			);
		}
		const bytes = Buffer.allocUnsafe(KEY_BYTES + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset !== KEY_BYTES) {
			throw new Error(
				`The vault key at ${safeText(displayKeyPath)} changed size while it was being read. Expected exactly ${KEY_BYTES} bytes.`,
			);
		}
		const afterReadStat = await handle.stat();
		if (!sameKeySnapshot(snapshot, afterReadStat)) {
			throw new Error(`The vault key at ${safeText(displayKeyPath)} changed while it was being read.`);
		}
		key = Buffer.from(bytes.subarray(0, KEY_BYTES));
	} finally {
		await handle.close();
	}
	const finalStat = await fs.lstat(keyPath);
	if (!sameKeySnapshot(snapshot, finalStat)) {
		throw new Error(`The vault key at ${safeText(displayKeyPath)} was replaced before the read completed.`);
	}
	await verifyKeyRootPin(pin);
	return key;
}

/**
 * Read the vault key, creating it on first use by staging complete synced bytes and publishing
 * them with an atomic no-overwrite hard link. The returned bytes are always re-read from the
 * inode reachable at `keyPath`.
 */
function publicKeyError(error: unknown): Error {
	const message = escapeTerminalText(errorMessage(error))
		.replace(/\.vault\.key\.\d+\.[0-9a-f-]{36}\.tmp(?:\.previous)?/gi, "<vault-key-stage>")
		.replace(/vault\.key\.lock(?:\.[^\s'\"\\]+|\.candidate-[^\s'\"\\]+)?/gi, "<vault-key-lock>");
	return new Error(message);
}

export async function loadOrCreateVaultKey(globalConfigRoot: string): Promise<Buffer> {
	try {
		await hardenEmptyKeyRoot(globalConfigRoot);
		let pin = await pinKeyRoot(globalConfigRoot);
		if (pin === null) {
			await assertNoSymlinkPathComponents(globalConfigRoot);
			await fs.mkdir(globalConfigRoot, { recursive: true, mode: 0o700 });
			if (process.platform !== "win32") await fs.chmod(globalConfigRoot, 0o700);
			await applyOwnerOnlyWindowsAcl(globalConfigRoot);
			await verifyOwnerOnlyWindowsAcl(globalConfigRoot);
			pin = await pinKeyRoot(globalConfigRoot);
		}
		if (pin === null) {
			throw new Error(`The vault key directory at ${safeText(globalConfigRoot)} disappeared while being created.`);
		}

		try {
			const keyPath = vaultKeyPath(globalConfigRoot);
			const ioKeyPath = pinnedKeyPath(pin);
			const result = await withFileLock(
				keyPath,
				async () => {
					await verifyKeyRootPin(pin);
					const existing = await readVaultKeyPinned(pin);
					await cleanupUnpublishedStages(pin);
					if (existing !== null) return existing;

					const generated = crypto.randomBytes(KEY_BYTES);
					const temporaryPath = path.join(
						pin.ioRoot,
						`.${VAULT_KEY_FILENAME}.${process.pid}.${crypto.randomUUID()}.tmp`,
					);
					let stagedStat: Stats | null = null;
					let published = false;
					try {
						const handle = await fs.open(temporaryPath, KEY_CREATE_FLAGS, KEY_FILE_MODE);
						try {
							stagedStat = await handle.stat();
							assertKeyPathSafe(temporaryPath, stagedStat, false);
							assertKeyNotExposed(temporaryPath, stagedStat);
							await applyOwnerOnlyWindowsAcl(temporaryPath);
							await verifyOwnerOnlyWindowsAcl(temporaryPath);
							const stagedPathStat = await fs.lstat(temporaryPath);
							if (!sameInode(stagedStat, stagedPathStat)) {
								throw new Error("The staged vault key changed before it could be written.");
							}
							await handle.writeFile(generated);
							await handle.sync();
							const syncedStat = await handle.stat();
							if (!sameInode(stagedStat, syncedStat) || syncedStat.size !== KEY_BYTES) {
								throw new Error("The staged vault key changed while its exact bytes were being synced.");
							}
						} finally {
							await handle.close();
						}

						await syncDirectory(pin);
						const stagedPathStat = await fs.lstat(temporaryPath);
						if (stagedStat === null || !sameInode(stagedStat, stagedPathStat)) {
							throw new Error("The staged vault key was replaced before publication.");
						}
						await verifyOwnerOnlyWindowsAcl(temporaryPath);
						if (!moveNoReplace(temporaryPath, ioKeyPath)) {
							const winner = await readVaultKeyPinned(pin);
							if (winner === null) {
								throw new Error("A concurrent vault key winner disappeared before it could be read.");
							}
							return winner;
						}
						published = true;
						await syncDirectory(pin);

						const publishedStat = await fs.lstat(ioKeyPath);
						assertKeyPathSafe(keyPath, publishedStat, true);
						assertKeyNotExposed(keyPath, publishedStat);
						if (!sameInode(stagedStat, publishedStat)) {
							throw new Error("The published vault key is not the staged synced inode.");
						}
						const reachable = await readVaultKeyPinned(pin);
						if (reachable === null || !reachable.equals(generated)) {
							throw new Error("The vault key reachable after publication is not the generated winner.");
						}
						return reachable;
					} finally {
						if (!published && stagedStat !== null) {
							if (await removePathIfSameInode(temporaryPath, stagedStat).catch(() => false)) {
								await syncDirectory(pin).catch(() => {});
							}
						}
					}
				},
				KEY_LOCK_OPTIONS,
			);
			await verifyKeyRootPin(pin);
			return result;
		} finally {
			await closeKeyRootPin(pin);
		}
	} catch (error) {
		throw publicKeyError(error);
	}
}

/**
 * Read the vault key, or `null` only when the pinned root or final key is genuinely absent.
 */
export async function readVaultKey(globalConfigRoot: string): Promise<Buffer | null> {
	try {
		const pin = await pinKeyRoot(globalConfigRoot);
		if (pin === null) return null;
		try {
			return await readVaultKeyPinned(pin);
		} finally {
			await closeKeyRootPin(pin);
		}
	} catch (error) {
		throw publicKeyError(error);
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
			`This vault could not be decrypted (${escapeTerminalText(errorMessage(error))}). ` +
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
