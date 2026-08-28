import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { applyOwnerOnlyWindowsAcl, isMissingPath, verifyOwnerOnlyWindowsAcl, withFileLock } from "@veyyon/utils";
import { isWellFormedUtf16 } from "@veyyon/utils/string-length";
import { moveNoReplace, replaceWithRollback } from "./atomic-path";
import { noteSecretsCondition } from "./notices";
import { buildNamePlaceholder } from "./placeholder";
import { canObfuscatePlainValue, MIN_OBFUSCATABLE_LENGTH, secretCharacterLength } from "./policy";
import { isSealedVault, loadOrCreateVaultKey, readVaultKey, sealVault } from "./vault-crypto";

import {
	type AddedVaultEntry,
	assertExpectedVaultPath,
	assertValidNumericTtl,
	assertVaultNotExposed,
	assertVaultPathSafe,
	canonicalVaultPath,
	canonicalVaultPathSync,
	closeVaultScopePin,
	comparableVaultPath,
	DEFAULT_TTL_MS,
	ensureProjectVaultIgnored,
	expiryFrom,
	generateSecretName,
	isExpired,
	MAX_VAULT_FILE_BYTES,
	MAX_VAULT_PLAINTEXT_BYTES,
	normaliseSecretName,
	openSealedVaultAcrossBindings,
	parseVaultFile,
	pinnedVaultPath,
	pinVaultScope,
	removePathIfSameInode,
	retireDisplacedVault,
	type ScopedVaultEntry,
	SEALED_VAULT_FIXED_BYTES,
	safeError,
	safeParseFailure,
	safeText,
	sameDisplacedSnapshot,
	sameInode,
	sameSnapshot,
	scopeIdentity,
	snapshotOf,
	syncDirectory,
	UnparseableVaultPayloadError,
	VAULT_LOCK_OPTIONS,
	VAULT_READ_FLAGS,
	VAULT_SCOPES,
	VAULT_SCOPES_NARROWEST_FIRST,
	VAULT_TEMP_FLAGS,
	type VaultEntry,
	type VaultFile,
	type VaultFileSnapshot,
	type VaultLocations,
	type VaultScope,
	type VaultScopePin,
	vaultBinding,
	vaultPathFor,
	vaultPathStat,
	verifyVaultScopePin,
} from "./vault-helpers";

export {
	type AddedVaultEntry,
	DEFAULT_TTL_MS,
	describeMsLeft,
	describeTimeLeft,
	formatTtl,
	generateSecretName,
	isExpired,
	isTtlWord,
	lifeFraction,
	MAX_VAULT_FILE_BYTES,
	MAX_VAULT_PLAINTEXT_BYTES,
	NEVER_TTL,
	normaliseSecretName,
	parseTtl,
	resolveVaultLocations,
	type ScopedVaultEntry,
	VAULT_FILENAME,
	VAULT_SCOPES,
	VAULT_SCOPES_NARROWEST_FIRST,
	type VaultEntry,
	type VaultLocations,
	type VaultScope,
	vaultPathFor,
	WARN_AT_FRACTIONS,
	warningThresholdCrossed,
} from "./vault-helpers";

async function writeVaultAtomically(
	scope: VaultScope,
	vaultPath: string,
	pin: VaultScopePin,
	expected: VaultFileSnapshot | null,
	text: string,
): Promise<void> {
	await assertExpectedVaultPath(scope, vaultPath, pin, expected);
	const installedPath = pinnedVaultPath(pin, vaultPath);
	const temporaryPath = path.join(pin.ioDirectory, `.${path.basename(vaultPath)}.${process.pid}.${randomUUID()}.tmp`);
	const windowsBackupPath = `${temporaryPath}.previous`;
	let stagedStat: Stats | null = null;
	let installed = false;
	try {
		const handle = await fs.open(temporaryPath, VAULT_TEMP_FLAGS, 0o600);
		try {
			stagedStat = await handle.stat();
			assertVaultPathSafe(scope, temporaryPath, stagedStat, false);
			assertVaultNotExposed(scope, temporaryPath, stagedStat);
			await applyOwnerOnlyWindowsAcl(temporaryPath);
			await verifyOwnerOnlyWindowsAcl(temporaryPath);
			const stagedPathStat = await fs.lstat(temporaryPath);
			assertVaultPathSafe(scope, temporaryPath, stagedPathStat, true);
			assertVaultNotExposed(scope, temporaryPath, stagedPathStat);
			if (!sameInode(stagedStat, stagedPathStat)) {
				throw new Error(`The staged ${scope} vault changed before it could be written.`);
			}
			await handle.writeFile(text, { encoding: "utf8" });
			await handle.sync();
			const syncedStat = await handle.stat();
			if (!sameInode(stagedStat, syncedStat) || syncedStat.size !== Buffer.byteLength(text, "utf8")) {
				throw new Error(`The staged ${scope} vault changed while it was being synced.`);
			}
		} finally {
			await handle.close();
		}

		await verifyVaultScopePin(scope, pin);
		await assertExpectedVaultPath(scope, vaultPath, pin, expected);
		const stagedPathStat = await fs.lstat(temporaryPath);
		assertVaultPathSafe(scope, temporaryPath, stagedPathStat, true);
		assertVaultNotExposed(scope, temporaryPath, stagedPathStat);
		if (stagedStat === null || !sameInode(stagedStat, stagedPathStat)) {
			throw new Error(`The staged ${scope} vault was replaced before installation. Refusing to install it.`);
		}
		await verifyOwnerOnlyWindowsAcl(temporaryPath);

		let displacedPath: string | null = null;
		if (expected === null) {
			if (!moveNoReplace(temporaryPath, installedPath)) {
				throw new Error(`The ${scope} vault changed during the transaction. Refusing to replace another inode.`);
			}
		} else {
			const replacement = replaceWithRollback(temporaryPath, installedPath, windowsBackupPath);
			displacedPath = replacement.displacedPath;
			const displacedStat = await fs.lstat(displacedPath);
			if (!(await sameDisplacedSnapshot(expected, displacedPath, displacedStat))) {
				replacement.rollback();
				throw new Error(`The ${scope} vault changed during the transaction. The racing inode was restored.`);
			}
		}

		const installedStat = await fs.lstat(installedPath);
		assertVaultPathSafe(scope, vaultPath, installedStat, true);
		assertVaultNotExposed(scope, vaultPath, installedStat);
		await verifyOwnerOnlyWindowsAcl(installedPath);
		if (!sameInode(stagedStat, installedStat)) {
			throw new Error(`The installed ${scope} vault is not the staged synced inode. Refusing it.`);
		}
		installed = true;
		await syncDirectory(scope, pin);
		if (displacedPath !== null && expected !== null) {
			await retireDisplacedVault(scope, displacedPath, expected);
			await syncDirectory(scope, pin);
		}
	} finally {
		if (!installed && stagedStat !== null) {
			await removePathIfSameInode(temporaryPath, stagedStat).catch(() => {});
			await removePathIfSameInode(windowsBackupPath, stagedStat).catch(() => {});
		}
	}
}

function jsonStringByteLength(value: string): number {
	let bytes = 2;
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (
			codeUnit === 0x22 ||
			codeUnit === 0x5c ||
			codeUnit === 0x08 ||
			codeUnit === 0x09 ||
			codeUnit === 0x0a ||
			codeUnit === 0x0c ||
			codeUnit === 0x0d
		) {
			bytes += 2;
		} else if (codeUnit < 0x20 || (codeUnit >= 0xd800 && codeUnit <= 0xdfff)) {
			if (codeUnit <= 0xdbff && index + 1 < value.length) {
				const next = value.charCodeAt(index + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					bytes += 4;
					index++;
					continue;
				}
			}
			bytes += 6;
		} else if (codeUnit <= 0x7f) {
			bytes++;
		} else if (codeUnit <= 0x7ff) {
			bytes += 2;
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

function vaultPlaintextByteLength(entries: readonly VaultEntry[]): number {
	let bytes = Buffer.byteLength('{"entries":[]}', "utf8");
	for (const entry of entries) {
		bytes +=
			Buffer.byteLength('{"name":,"value":,"createdAt":,"expiresAt":}', "utf8") +
			jsonStringByteLength(entry.name) +
			jsonStringByteLength(entry.value) +
			String(entry.createdAt).length +
			(entry.expiresAt === null ? 4 : String(entry.expiresAt).length);
	}
	if (entries.length > 0) bytes += entries.length - 1;
	return bytes;
}

function sameVaultEntries(left: readonly VaultEntry[], right: readonly VaultEntry[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(entry, index) =>
				entry.name === right[index].name &&
				entry.value === right[index].value &&
				entry.createdAt === right[index].createdAt &&
				entry.expiresAt === right[index].expiresAt,
		)
	);
}

function assertStorableValue(value: string): void {
	if (!isWellFormedUtf16(value)) {
		throw new Error("This secret contains ill-formed UTF-16. Refusing to store it.");
	}
	if (value.length === 0) throw new Error("A secret cannot be empty.");
	if (value.length > MAX_VAULT_PLAINTEXT_BYTES) {
		throw new Error(
			`This secret value is over the ${MAX_VAULT_PLAINTEXT_BYTES}-byte plaintext safety limit. ` +
				"Refusing it before encoded-size scanning or serialization.",
		);
	}
	const encodedValueBytes = jsonStringByteLength(value);
	if (encodedValueBytes > MAX_VAULT_PLAINTEXT_BYTES) {
		throw new Error(
			`This secret value needs ${encodedValueBytes} bytes in the vault, over the ` +
				`${MAX_VAULT_PLAINTEXT_BYTES}-byte plaintext safety limit. Refusing it before serialization.`,
		);
	}
	if (!canObfuscatePlainValue(value)) {
		throw new Error(
			`This secret is ${secretCharacterLength(value)} characters, under the ${MIN_OBFUSCATABLE_LENGTH}-character ` +
				`minimum. Values that short cannot be replaced in text without cutting into ordinary words, ` +
				`so storing it would not protect it.`,
		);
	}
}

function replaceVaultEntry(entries: readonly VaultEntry[], replacement: VaultEntry): VaultEntry[] {
	const next: VaultEntry[] = [];
	let replaced = false;
	for (const entry of entries) {
		if (entry.name !== replacement.name) {
			next.push(entry);
		} else if (!replaced) {
			next.push(replacement);
			replaced = true;
		}
	}
	if (!replaced) next.push(replacement);
	return next;
}

function sealedVaultByteLength(plaintextBytes: number): number {
	return SEALED_VAULT_FIXED_BYTES + 4 * Math.ceil(plaintextBytes / 3);
}

function revisionStat(pathname: string): string {
	try {
		const stat = fsSync.lstatSync(pathname, { bigint: true });
		const type = stat.isDirectory() ? "d" : stat.isFile() ? "f" : stat.isSymbolicLink() ? "l" : "o";
		return `${type}:${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}:${stat.nlink}:${stat.mode}:${stat.uid}`;
	} catch (error) {
		if (isMissingPath(error)) return "absent";
		const code =
			typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
				? error.code
				: "unknown";
		return `error:${code}`;
	}
}

const MAX_TRACKED_VAULT_PATHS = 64;

interface VaultIdentityRecord {
	observed: string;
	identity: string;
}

const vaultIdentities = new Map<string, VaultIdentityRecord>();

let vaultIdentityCounter = 0;

function rememberVaultIdentity(key: string, record: VaultIdentityRecord): void {
	vaultIdentities.delete(key);
	vaultIdentities.set(key, record);
	while (vaultIdentities.size > MAX_TRACKED_VAULT_PATHS) {
		const oldest = vaultIdentities.keys().next();
		if (oldest.done === true) break;
		vaultIdentities.delete(oldest.value);
	}
}

function externalVaultIdentity(pathname: string): string {
	const key = comparableVaultPath(pathname);
	const current = revisionStat(pathname);
	const record = vaultIdentities.get(key);
	if (record !== undefined && record.observed === current) return record.identity;
	vaultIdentityCounter += 1;
	const identity = `ext:${vaultIdentityCounter}:${current}`;
	rememberVaultIdentity(key, { observed: current, identity });
	return identity;
}

function recordSelfWrittenVault(pathname: string): void {
	const written = revisionStat(pathname);
	const keys = [comparableVaultPath(pathname)];
	try {
		const canonical = canonicalVaultPathSync(pathname);
		if (canonical !== keys[0]) keys.push(canonical);
	} catch {}
	for (const key of keys) {
		const record = vaultIdentities.get(key);
		if (record === undefined) continue;
		rememberVaultIdentity(key, { observed: written, identity: record.identity });
	}
}

const reportedUnreadableVaults = new Map<string, string>();

function noteUnreadableVault(scope: VaultScope, vaultPath: string, error: unknown): void {
	const key = comparableVaultPath(vaultPath);
	const state = revisionStat(vaultPath);
	if (reportedUnreadableVaults.get(key) === state) return;
	reportedUnreadableVaults.set(key, state);
	noteSecretsCondition(
		`Your ${scope} vault at ${safeText(vaultPath)} exists but could not be read, so it was skipped ` +
			`and the secrets stored in it are unavailable for the rest of this session: their placeholders ` +
			`will NOT expand. Every OTHER scope loaded normally, and masking of known secret values is ` +
			`unaffected. The vault is encrypted, so a hand edit cannot repair it: run /secret discard ` +
			`${scope} to move the unreadable file aside. Then store the secrets it held again. The reason it ` +
			`could not be read was ` +
			`${safeError(error)}`,
	);
}

function noteFailedVaultLoad(locations: VaultLocations, unreadable: readonly VaultScope[], error: unknown): void {
	const repair =
		unreadable.length === 0
			? `No vault file was found to move aside, so this is a fault in the key or the vault directory rather than in a stored file.`
			: `Run ${unreadable.map(scope => `/secret discard ${scope}`).join(" and ")} to move the ` +
				`unreadable ${unreadable.length === 1 ? "file" : "files"} aside. Then store the secrets it held again.`;
	const where = unreadable.map(scope => `${scope} (${safeText(vaultPathFor(locations, scope))})`).join(", ");
	noteSecretsCondition(
		`Your vault could not be read, so this session started WITHOUT it: nothing you have stored is ` +
			`available, and every #NAME# placeholder it held will be refused rather than sent as literal ` +
			`text. Masking of secrets from your environment and secrets.yml is unaffected and still ` +
			`running.${unreadable.length === 0 ? "" : ` Affected: ${where}.`} ${repair} The reason it could ` +
			`not be read was ${safeError(error)}`,
	);
}

function forgetUnreadableVault(vaultPath: string): void {
	reportedUnreadableVaults.delete(comparableVaultPath(vaultPath));
}

function vaultRevision(locations: VaultLocations): string {
	const hash = createHash("sha256");
	for (const scope of VAULT_SCOPES) {
		const lexical = vaultPathFor(locations, scope);
		hash.update(
			`${scope}\0lexical:${comparableVaultPath(lexical)}\0lexical-vault:${externalVaultIdentity(lexical)}\0`,
		);
		let canonical: string;
		try {
			canonical = canonicalVaultPathSync(lexical);
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
					? error.code
					: "unknown";
			hash.update(`canonical-error:${code}\0`);
			continue;
		}
		hash.update(`canonical:${canonical}\0canonical-vault:${externalVaultIdentity(canonical)}\0`);
	}
	return hash.digest("hex");
}

interface VaultReadResult {
	readonly entries: VaultEntry[];
	readonly snapshot: VaultFileSnapshot;
	readonly sealedText: string;
}

export class SecretVault {
	readonly #locations: VaultLocations;
	readonly #now: () => number;
	#unreadableScopes: ReadonlySet<VaultScope> = new Set();

	constructor(locations: VaultLocations, now: () => number = () => Date.now()) {
		this.#locations = locations;
		this.#now = now;
	}

	revision(): string {
		return vaultRevision(this.#locations);
	}

	async #scopePathOwner(scope: VaultScope, wantedPin: VaultScopePin): Promise<VaultScope> {
		const wanted = scopeIdentity(wantedPin);
		for (const candidate of VAULT_SCOPES) {
			if (candidate === scope) return candidate;
			const candidatePath = vaultPathFor(this.#locations, candidate);
			const candidatePin = await pinVaultScope(candidate, candidatePath);
			if (candidatePin !== null) {
				try {
					if (scopeIdentity(candidatePin) === wanted) return candidate;
				} finally {
					await closeVaultScopePin(candidatePin);
				}
			} else if ((await canonicalVaultPath(candidatePath)) === wantedPin.canonicalVaultPath) {
				return candidate;
			}
		}
		return scope;
	}

	async load(): Promise<ScopedVaultEntry[]> {
		const byName = new Map<string, ScopedVaultEntry>();
		for (const entry of await this.#loadEveryScope()) {
			byName.delete(entry.name);
			byName.set(entry.name, entry);
		}
		return Array.from(byName.values());
	}

	async loadEverywhere(): Promise<ScopedVaultEntry[]> {
		return await this.#loadEveryScope();
	}

	async #loadEveryScope(): Promise<ScopedVaultEntry[]> {
		const now = this.#now();
		const all: ScopedVaultEntry[] = [];
		const unreadable = new Set<VaultScope>();
		for (const scope of VAULT_SCOPES) {
			const vaultPath = vaultPathFor(this.#locations, scope);
			const pin = await pinVaultScope(scope, vaultPath);
			if (pin === null) {
				forgetUnreadableVault(vaultPath);
				continue;
			}
			try {
				if ((await this.#scopePathOwner(scope, pin)) !== scope) continue;
				for (const entry of await this.#loadScope(scope, pin, now)) all.push({ ...entry, scope });

				forgetUnreadableVault(vaultPath);
			} catch (error) {
				if (!(error instanceof UnparseableVaultPayloadError)) throw error;
				unreadable.add(scope);
				noteUnreadableVault(scope, vaultPath, error);
			} finally {
				await closeVaultScopePin(pin);
			}
		}
		this.#unreadableScopes = unreadable;
		return all;
	}

	unreadableScopes(): readonly VaultScope[] {
		return Array.from(this.#unreadableScopes);
	}

	async noteFailedLoad(error: unknown): Promise<readonly VaultScope[]> {
		const unreadable = new Set<VaultScope>();
		for (const scope of VAULT_SCOPES) {
			try {
				await fs.lstat(vaultPathFor(this.#locations, scope));
				unreadable.add(scope);
			} catch {}
		}
		this.#unreadableScopes = unreadable;
		noteFailedVaultLoad(this.#locations, Array.from(unreadable), error);
		return Array.from(unreadable);
	}

	async discardUnreadableScope(scope: VaultScope): Promise<{ readonly movedTo: string }> {
		const vaultPath = vaultPathFor(this.#locations, scope);
		const absent = new Error(`There is no ${scope} vault at ${safeText(vaultPath)}, so there is nothing to discard.`);
		const pin = await pinVaultScope(scope, vaultPath);
		if (pin === null) throw absent;
		try {
			const owner = await this.#scopePathOwner(scope, pin);
			if (owner !== scope) {
				throw new Error(
					`The ${scope} vault path ${safeText(vaultPath)} is also the ${owner} vault path, so discarding ` +
						`it would discard the ${owner} vault too. Name the ${owner} scope instead if that is what ` +
						`you mean.`,
				);
			}
			return await withFileLock(
				vaultPath,
				async () => {
					await verifyVaultScopePin(scope, pin);
					let readable: boolean;
					try {
						readable = (await this.#readScopeRaw(scope, pin)) !== null;
					} catch {
						readable = false;
						const ioPath = pinnedVaultPath(pin, vaultPath);
						for (let attempt = 0; attempt < 8; attempt++) {
							const suffix = `.unreadable-${this.#now()}-${randomUUID().slice(0, 8)}`;
							if (!moveNoReplace(ioPath, `${ioPath}${suffix}`)) continue;
							await verifyVaultScopePin(scope, pin);
							recordSelfWrittenVault(vaultPath);
							forgetUnreadableVault(vaultPath);
							return { movedTo: `${vaultPath}${suffix}` };
						}
						throw new Error(
							`Could not find an unused name to move the ${scope} vault at ${safeText(vaultPath)} ` +
								`aside. Move or delete that file yourself.`,
						);
					}
					if (readable) {
						throw new Error(
							`The ${scope} vault at ${safeText(vaultPath)} reads normally, so nothing needs ` +
								`discarding. Use /secret rm <name> to remove one secret; unlike this, it can tell ` +
								`you what it removed.`,
						);
					}
					throw absent;
				},
				VAULT_LOCK_OPTIONS,
			);
		} finally {
			await closeVaultScopePin(pin);
		}
	}

	async #loadScope(scope: VaultScope, pin: VaultScopePin, now: number): Promise<VaultEntry[]> {
		const read = await this.#readScopeRaw(scope, pin);
		if (read === null) return [];
		const all = read.entries;
		const live = all.filter(entry => !isExpired(entry, now));
		if (live.length === all.length) return live;

		return await this.#withScopeLocked(scope, entries => {
			const stillLive = entries.filter(entry => !isExpired(entry, now));
			return { entries: stillLive, result: stillLive };
		});
	}

	async #readScopeRaw(scope: VaultScope, pin: VaultScopePin): Promise<VaultReadResult | null> {
		const vaultPath = vaultPathFor(this.#locations, scope);
		const pathStat = await vaultPathStat(scope, vaultPath, pin);
		if (pathStat === null) return null;
		const snapshot = snapshotOf(pathStat);

		const ioPath = pinnedVaultPath(pin, vaultPath);
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(ioPath, VAULT_READ_FLAGS);
		} catch (error) {
			throw new Error(
				`The ${scope} vault at ${safeText(vaultPath)} could not be opened safely (${safeError(error)}).`,
			);
		}

		let text: string;
		try {
			const openStat = await handle.stat();
			assertVaultPathSafe(scope, vaultPath, openStat, false);
			assertVaultNotExposed(scope, vaultPath, openStat);
			if (!sameSnapshot(snapshot, openStat)) {
				throw new Error(`The ${scope} vault changed while it was being opened. Refusing to read another inode.`);
			}
			if (openStat.size > MAX_VAULT_FILE_BYTES) {
				throw new Error(
					`The ${scope} vault at ${safeText(vaultPath)} is ${openStat.size} bytes, over the ` +
						`${MAX_VAULT_FILE_BYTES}-byte safety limit. Refusing to read or parse it.`,
				);
			}

			const bytes = Buffer.allocUnsafe(Math.min(openStat.size + 1, MAX_VAULT_FILE_BYTES + 1));
			let offset = 0;
			while (offset < bytes.length) {
				const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			if (offset > MAX_VAULT_FILE_BYTES) {
				throw new Error(
					`The ${scope} vault at ${safeText(vaultPath)} grew over the ` +
						`${MAX_VAULT_FILE_BYTES}-byte safety limit while it was being read. Refusing to parse it.`,
				);
			}
			if (offset !== openStat.size) {
				throw new Error(`The ${scope} vault at ${safeText(vaultPath)} changed size while it was being read.`);
			}
			const afterReadStat = await handle.stat();
			if (!sameSnapshot(snapshot, afterReadStat)) {
				throw new Error(`The ${scope} vault changed while it was being read. Refusing an unstable snapshot.`);
			}
			text = bytes.subarray(0, offset).toString("utf8");
		} finally {
			await handle.close();
		}
		await assertExpectedVaultPath(scope, vaultPath, pin, snapshot);

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new Error(
				`The ${scope} vault at ${safeText(vaultPath)} is not valid JSON (${safeParseFailure(error)}). ` +
					`It is encrypted, so it is not meant to be edited by hand.`,
			);
		}
		if (!isSealedVault(parsed)) {
			throw new Error(
				`The ${scope} vault at ${safeText(vaultPath)} is not a sealed vault file. ` +
					`Restore it from a backup rather than editing it.`,
			);
		}
		if (parsed.v === 1) {
			throw new Error(
				`The ${scope} vault at ${safeText(vaultPath)} uses legacy format version 1, which has no authenticated ` +
					`scope or path. Refusing to guess its origin. Re-add its credentials into the intended scope.`,
			);
		}

		const key = await readVaultKey(this.#locations.globalConfigRoot);
		if (key === null) {
			throw new Error(
				`The ${scope} vault at ${safeText(vaultPath)} exists, but its key does not. ` +
					`Without the key nothing in it can be decrypted, and none of the secrets it holds are being ` +
					`protected. Restore the key file from a backup: this vault's ciphertext is intact, so its ` +
					`secrets come back the moment the key does. If the key is genuinely unrecoverable, run ` +
					`\`/secret discard\`, which moves the unreadable vault aside instead of destroying it.`,
			);
		}
		await assertExpectedVaultPath(scope, vaultPath, pin, snapshot);
		const plaintext = openSealedVaultAcrossBindings(key, parsed, scope, vaultPath, pin);
		const entries = parseVaultFile(plaintext, scope, vaultPath).entries;
		await assertExpectedVaultPath(scope, vaultPath, pin, snapshot);
		return {
			entries,
			snapshot,
			sealedText: text,
		};
	}

	async #withScopeLocked<R>(
		scope: VaultScope,
		transform: (entries: VaultEntry[], exists: boolean) => { entries: VaultEntry[]; result: R; write?: boolean },
		createIfMissing = false,
	): Promise<R> {
		const vaultPath = vaultPathFor(this.#locations, scope);
		const directory = path.dirname(vaultPath);
		let pin = await pinVaultScope(scope, vaultPath);
		if (pin === null && !createIfMissing) return transform([], false).result;
		if (pin === null) {
			await fs.mkdir(directory, { recursive: true });
			pin = await pinVaultScope(scope, vaultPath);
			if (pin === null) {
				throw new Error(`The ${scope} vault directory disappeared while it was being created.`);
			}
		}
		await ensureProjectVaultIgnored(scope, directory);
		try {
			const owner = await this.#scopePathOwner(scope, pin);
			if (owner !== scope) {
				if (createIfMissing) {
					throw new Error(
						`The ${scope} vault path ${safeText(vaultPath)} is also the ${owner} vault path. ` +
							`One file cannot safely represent two authenticated scopes; choose a different working directory.`,
					);
				}
				return transform([], false).result;
			}
			const existingStat = await vaultPathStat(scope, vaultPath, pin);
			if (existingStat === null && !createIfMissing) return transform([], false).result;

			const result = await withFileLock(
				vaultPath,
				async () => {
					await verifyVaultScopePin(scope, pin);
					const read = await this.#readScopeRaw(scope, pin);
					const { entries, result: transformed, write = true } = transform(read?.entries ?? [], read !== null);
					if (write && (read === null || !sameVaultEntries(entries, read.entries))) {
						const expected =
							read === null
								? null
								: {
										...read.snapshot,
										contentHash: createHash("sha256").update(read.sealedText).digest("hex"),
									};
						await this.#writeScope(scope, entries, pin, expected);
					}
					await verifyVaultScopePin(scope, pin);
					return transformed;
				},
				VAULT_LOCK_OPTIONS,
			);
			await verifyVaultScopePin(scope, pin);
			return result;
		} finally {
			await closeVaultScopePin(pin);
		}
	}

	async #writeScope(
		scope: VaultScope,
		entries: VaultEntry[],
		pin: VaultScopePin,
		expected: VaultFileSnapshot | null,
	): Promise<void> {
		if (entries.some(entry => !isWellFormedUtf16(entry.name) || !isWellFormedUtf16(entry.value))) {
			throw new Error(`The ${scope} vault contains ill-formed UTF-16. Refusing to seal or replace it.`);
		}
		await verifyVaultScopePin(scope, pin);
		const vaultPath = vaultPathFor(this.#locations, scope);
		const plaintextBytes = vaultPlaintextByteLength(entries);
		const prospectiveSize = sealedVaultByteLength(plaintextBytes);
		if (plaintextBytes > MAX_VAULT_PLAINTEXT_BYTES || prospectiveSize > MAX_VAULT_FILE_BYTES) {
			throw new Error(
				`The ${scope} vault at ${safeText(vaultPath)} would be ${prospectiveSize} bytes, over the ` +
					`${MAX_VAULT_FILE_BYTES}-byte safety limit. Refusing to replace the existing vault.`,
			);
		}

		const key = await loadOrCreateVaultKey(this.#locations.globalConfigRoot);
		await verifyVaultScopePin(scope, pin);
		const plaintext = JSON.stringify({ entries } satisfies VaultFile);
		if (Buffer.byteLength(plaintext, "utf8") !== plaintextBytes) {
			throw new Error(`The ${scope} vault changed shape during serialization. Refusing to seal it.`);
		}
		const sealed = sealVault(key, plaintext, vaultBinding(scope, pin));
		const text = JSON.stringify(sealed);
		if (Buffer.byteLength(text, "utf8") > MAX_VAULT_FILE_BYTES) {
			throw new Error(`The ${scope} vault exceeded its safety limit during sealing. Refusing to replace it.`);
		}

		externalVaultIdentity(vaultPath);
		await writeVaultAtomically(scope, vaultPath, pin, expected, text);
		recordSelfWrittenVault(vaultPath);
	}

	async add(options: {
		name?: string;
		value: string;
		scope?: VaultScope;
		ttl?: number | null;
	}): Promise<AddedVaultEntry> {
		const scope = options.scope ?? "profile";
		assertStorableValue(options.value);

		const requestedName = options.name === undefined ? undefined : normaliseSecretName(options.name);
		const ttl = options.ttl === undefined ? DEFAULT_TTL_MS : options.ttl;
		if (ttl !== null) assertValidNumericTtl(ttl);

		const entry = await this.#withScopeLocked(
			scope,
			existing => {
				const name = requestedName ?? generateSecretName(new Set(existing.map(e => e.name)));
				const now = this.#now();
				const created: VaultEntry = {
					name,
					value: options.value,
					createdAt: now,
					expiresAt: expiryFrom(now, ttl),
				};
				const replaced = existing.some(entry => entry.name === name);
				return { entries: replaceVaultEntry(existing, created), result: { ...created, replaced } };
			},
			true,
		);
		return { ...entry, scope };
	}

	async remove(name: string, scope?: VaultScope): Promise<VaultScope | null> {
		const wanted = normaliseSecretName(name);
		const now = this.#now();
		for (const candidate of scope === undefined ? VAULT_SCOPES_NARROWEST_FIRST : [scope]) {
			const removed = await this.#withScopeLocked(candidate, (current, exists) => {
				const live = current.filter(entry => !isExpired(entry, now));
				const found = live.some(entry => entry.name === wanted);
				const next = found ? live.filter(entry => entry.name !== wanted) : live;
				return {
					entries: next,
					result: found,
					write: exists && next.length !== current.length,
				};
			});
			if (removed) return candidate;
		}
		return null;
	}

	async clear(scope: VaultScope): Promise<readonly string[]> {
		const now = this.#now();
		return await this.#withScopeLocked(scope, (current, exists) => {
			const live = current.filter(entry => !isExpired(entry, now));
			return {
				entries: [],
				result: live.map(entry => entry.name),
				write: exists && current.length > 0,
			};
		});
	}

	async extend(name: string, ttl: number | null): Promise<ScopedVaultEntry | null> {
		const wanted = normaliseSecretName(name);
		if (ttl !== null) assertValidNumericTtl(ttl);
		const now = this.#now();
		for (const scope of VAULT_SCOPES_NARROWEST_FIRST) {
			const updated = await this.#withScopeLocked<VaultEntry | null>(scope, (current, exists) => {
				const live = current.filter(entry => !isExpired(entry, now));
				const target = live.find(entry => entry.name === wanted);
				if (target === undefined) {
					return {
						entries: live,
						result: null,
						write: exists && live.length !== current.length,
					};
				}
				if (target.expiresAt === null && ttl === null) {
					return { entries: live, result: target };
				}
				const next: VaultEntry = { ...target, createdAt: now, expiresAt: expiryFrom(now, ttl) };
				return {
					entries: replaceVaultEntry(live, next),
					result: next,
				};
			});
			if (updated !== null) return { ...updated, scope };
		}
		return null;
	}

	async replaceValue(name: string, value: string): Promise<ScopedVaultEntry | null> {
		const wanted = normaliseSecretName(name);
		assertStorableValue(value);
		const now = this.#now();
		for (const scope of VAULT_SCOPES_NARROWEST_FIRST) {
			const updated = await this.#withScopeLocked<VaultEntry | null>(scope, (current, exists) => {
				const live = current.filter(entry => !isExpired(entry, now));
				const target = live.find(entry => entry.name === wanted);
				if (target === undefined) {
					return {
						entries: live,
						result: null,
						write: exists && live.length !== current.length,
					};
				}

				const next: VaultEntry = { ...target, value };
				return { entries: replaceVaultEntry(live, next), result: next };
			});
			if (updated !== null) return { ...updated, scope };
		}
		return null;
	}

	async rename(from: string, to: string): Promise<{ scope: VaultScope; name: string } | null> {
		const wanted = normaliseSecretName(from);
		const renamed = normaliseSecretName(to);
		const now = this.#now();
		for (const scope of VAULT_SCOPES_NARROWEST_FIRST) {
			const found = await this.#withScopeLocked<boolean>(scope, (current, exists) => {
				const live = current.filter(entry => !isExpired(entry, now));
				const target = live.find(entry => entry.name === wanted);
				const pruneOnly = {
					entries: live,
					result: false,
					write: exists && live.length !== current.length,
				};
				if (target === undefined) return pruneOnly;
				if (renamed === wanted) return { ...pruneOnly, result: true };
				if (live.some(entry => entry.name === renamed)) {
					throw new Error(
						`The ${scope} vault already has a secret named ${renamed}. Renaming ${wanted} onto it would ` +
							`destroy that credential. Remove ${renamed} first if that is what you want.`,
					);
				}
				const next: VaultEntry = { ...target, name: renamed };
				return {
					entries: replaceVaultEntry(
						live.map(entry => (entry.name === wanted ? next : entry)),
						next,
					),
					result: true,
				};
			});
			if (found) return { scope, name: renamed };
		}
		return null;
	}

	async namedSecrets(): Promise<
		Array<{ name: string; value: string; placeholder: string; expiresAt: number | null }>
	> {
		return (await this.load()).map(entry => ({
			name: entry.name,
			value: entry.value,
			placeholder: buildNamePlaceholder(entry.name),

			expiresAt: entry.expiresAt,
		}));
	}
}
