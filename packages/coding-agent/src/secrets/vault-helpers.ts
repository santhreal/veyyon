import { createHash, randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clamp01, errorMessage, escapeTerminalText, isMissingPath, verifyOwnerOnlyWindowsAcl } from "@veyyon/utils";
import { isWellFormedUtf16 } from "@veyyon/utils/string-length";
import { moveNoReplace } from "./atomic-path";
import { noteSecretsCondition } from "./notices";
import { describeInvalidSecretName, isValidSecretName, MAX_SECRET_NAME_LENGTH } from "./placeholder";
import { canObfuscatePlainValue } from "./policy";
import { openVault, type SealedVault } from "./vault-crypto";

export type VaultScope = "profile" | "project" | "global";

export const VAULT_SCOPES: readonly VaultScope[] = ["global", "profile", "project"];

export const VAULT_SCOPES_NARROWEST_FIRST: readonly VaultScope[] = [...VAULT_SCOPES].reverse();

export const VAULT_FILENAME = "vault.json";

export const MAX_VAULT_FILE_BYTES = 8 * 1024 * 1024;

export const SEALED_VAULT_FIXED_BYTES = Buffer.byteLength(
	JSON.stringify({ v: 2, iv: "A".repeat(16), tag: "A".repeat(24), ct: "" }),
	"utf8",
);
export const MAX_VAULT_PLAINTEXT_BYTES = Math.floor((MAX_VAULT_FILE_BYTES - SEALED_VAULT_FIXED_BYTES) / 4) * 3;

export interface VaultEntry {
	name: string;
	value: string;
	createdAt: number;
	expiresAt: number | null;
}

export interface ScopedVaultEntry extends VaultEntry {
	scope: VaultScope;
}

export interface AddedVaultEntry extends ScopedVaultEntry {
	replaced: boolean;
}

export interface VaultFile {
	entries: VaultEntry[];
}

export function isVaultEntry(value: unknown): value is VaultEntry {
	if (value === null || typeof value !== "object") return false;
	if (!("name" in value) || typeof value.name !== "string" || !isValidSecretName(value.name)) return false;
	if (!("value" in value) || typeof value.value !== "string" || !canObfuscatePlainValue(value.value)) return false;
	if (!("createdAt" in value) || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt)) {
		return false;
	}
	if (!("expiresAt" in value)) return false;
	return value.expiresAt === null || (typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt));
}

export function safeParseFailure(error: unknown): string {
	if (!(error instanceof Error) || error.name.length === 0) return "unrecognised parse failure";
	return escapeTerminalText(error.name);
}

export class UnparseableVaultPayloadError extends Error {}

export function parseVaultFile(plaintext: string, scope: VaultScope, vaultPath: string): VaultFile {
	let value: unknown;
	try {
		value = JSON.parse(plaintext);
	} catch (error) {
		throw new UnparseableVaultPayloadError(
			`The decrypted ${scope} vault at ${safeText(vaultPath)} is not valid JSON (${safeParseFailure(error)}).`,
		);
	}
	if (value === null || typeof value !== "object" || !("entries" in value) || !Array.isArray(value.entries)) {
		throw new Error(
			`The decrypted ${scope} vault at ${safeText(vaultPath)} has an invalid structure. Refusing to read it.`,
		);
	}
	for (const entry of value.entries) {
		if (
			entry !== null &&
			typeof entry === "object" &&
			(("name" in entry && typeof entry.name === "string" && !isWellFormedUtf16(entry.name)) ||
				("value" in entry && typeof entry.value === "string" && !isWellFormedUtf16(entry.value)))
		) {
			throw new Error(
				`The decrypted ${scope} vault at ${safeText(vaultPath)} contains ill-formed UTF-16. Refusing to read it.`,
			);
		}
	}
	if (!value.entries.every(isVaultEntry)) {
		throw new Error(
			`The decrypted ${scope} vault at ${safeText(vaultPath)} contains an invalid entry. Refusing to read it.`,
		);
	}
	return {
		entries: value.entries.map(entry => ({
			name: entry.name,
			value: entry.value,
			createdAt: entry.createdAt,
			expiresAt: entry.expiresAt,
		})),
	};
}

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export const NEVER_TTL = "never";

export const WARN_AT_FRACTIONS: readonly number[] = [0.5, 0.9];

export const TTL_UNITS: Record<string, number> = {
	m: 60 * 1000,
	h: 60 * 60 * 1000,
	d: 24 * 60 * 60 * 1000,
	w: 7 * 24 * 60 * 60 * 1000,
};

export const TTL_WORD = /^([0-9]+)([mhdw])$/;

export function isTtlWord(spec: string): boolean {
	const text = spec.trim().toLowerCase();
	return text === NEVER_TTL || TTL_WORD.test(text);
}

export function assertValidNumericTtl(ttl: number): void {
	if (!Number.isSafeInteger(ttl) || ttl <= 0) {
		throw new Error("A lifetime must be a finite, positive, safely representable number of milliseconds.");
	}
}

export function expiryFrom(now: number, ttl: number | null): number | null {
	if (ttl === null) return null;
	assertValidNumericTtl(ttl);
	const expiresAt = now + ttl;
	if (!Number.isSafeInteger(expiresAt)) {
		throw new Error("This lifetime is too large to store as a safe expiry timestamp.");
	}
	return expiresAt;
}

export function parseTtl(spec: string): number | null {
	if (spec.length > 64) {
		throw new Error(
			"This lifetime is too large to represent safely. Use a short amount such as 30m, 12h, 7d, or 2w.",
		);
	}
	const text = spec.trim().toLowerCase();
	if (text === NEVER_TTL) return null;

	const match = TTL_WORD.exec(text);
	if (match === null) {
		throw new Error(
			`That is not a lifetime. Write a number followed by m, h, d or w ` +
				`(for example 30m, 12h, 7d, 2w), or "${NEVER_TTL}" for a secret that does not expire. ` +
				`What you wrote is not repeated here, in case it is the credential.`,
		);
	}
	const amount = Number(match[1]);
	if (amount === 0) {
		throw new Error(`A lifetime of zero would expire immediately. Use a positive amount, or "${NEVER_TTL}".`);
	}
	const ttl = amount * TTL_UNITS[match[2]];
	if (!Number.isSafeInteger(ttl)) {
		throw new Error("This lifetime is too large to represent safely. Choose a smaller positive amount.");
	}
	return ttl;
}

export function formatTtl(ms: number | null): string {
	if (ms === null) return NEVER_TTL;
	assertValidNumericTtl(ms);
	for (const [unit, size] of [
		["d", TTL_UNITS.d],
		["h", TTL_UNITS.h],
		["m", TTL_UNITS.m],
	] as const) {
		if (ms % size === 0) return `${ms / size}${unit}`;
	}
	return `${Math.round(ms / TTL_UNITS.m)}m`;
}

export function isExpired(entry: VaultEntry, now: number): boolean {
	return entry.expiresAt !== null && entry.expiresAt <= now;
}

export function lifeFraction(entry: VaultEntry, now: number): number | null {
	if (entry.expiresAt === null) return null;
	const span = entry.expiresAt - entry.createdAt;
	if (span <= 0) return 1;
	return clamp01((now - entry.createdAt) / span);
}

export function warningThresholdCrossed(entry: VaultEntry, now: number): number | null {
	const fraction = lifeFraction(entry, now);
	if (fraction === null) return null;
	let crossed: number | null = null;
	for (const threshold of WARN_AT_FRACTIONS) {
		if (fraction >= threshold) crossed = threshold;
	}
	return crossed;
}

export function describeMsLeft(left: number): string {
	if (left <= 0) return "expired";
	if (left < TTL_UNITS.h) return `${Math.max(1, Math.round(left / TTL_UNITS.m))}m left`;
	if (left < TTL_UNITS.d) return `${Math.round(left / TTL_UNITS.h)}h left`;
	return `${Math.round(left / TTL_UNITS.d)}d left`;
}

export function describeTimeLeft(entry: VaultEntry, now: number): string {
	if (entry.expiresAt === null) return "never expires";
	return describeMsLeft(entry.expiresAt - now);
}

export const GENERATED_NAME_PREFIX = "SECRET_";

export function normaliseSecretName(raw: string): string {
	if (raw.length > MAX_SECRET_NAME_LENGTH + 64) {
		throw new Error(
			`This secret name input is too long. Use ${MAX_SECRET_NAME_LENGTH} characters or fewer after trimming.`,
		);
	}
	if (!/^[A-Za-z0-9 _-]+$/.test(raw)) {
		throw new Error(describeInvalidSecretName(safeText(raw)));
	}
	const candidate = raw.trim().toUpperCase().replace(/[ -]+/g, "_");
	if (!isValidSecretName(candidate)) throw new Error(describeInvalidSecretName(safeText(raw)));
	return candidate;
}

export function generateSecretName(taken: ReadonlySet<string>): string {
	for (let n = 1; n < 10_000; n++) {
		const candidate = `${GENERATED_NAME_PREFIX}${n}`;
		if (candidate.length <= MAX_SECRET_NAME_LENGTH && !taken.has(candidate)) return candidate;
	}
	throw new Error("Could not invent an unused secret name. Remove some entries with /secret rm NAME.");
}

export interface VaultLocations {
	globalConfigRoot: string;
	profileDir: string;
	projectDir: string;
}

export function resolveVaultLocations(options: {
	globalConfigRoot: string;
	agentDir: string;
	cwd: string;
}): VaultLocations {
	return {
		globalConfigRoot: options.globalConfigRoot,
		profileDir: options.agentDir,
		projectDir: path.join(options.cwd, ".veyyon"),
	};
}

export function vaultPathFor(locations: VaultLocations, scope: VaultScope): string {
	switch (scope) {
		case "global":
			return path.join(locations.globalConfigRoot, VAULT_FILENAME);
		case "profile":
			return path.join(locations.profileDir, VAULT_FILENAME);
		case "project":
			return path.join(locations.projectDir, VAULT_FILENAME);
	}
}

export const PROJECT_VAULT_GITIGNORE = `# Written by veyyon, and safe to keep.
#
# A vault is an encrypted credential store. Its key never leaves this machine, so committing one
# publishes a credential store that nobody who clones the repo can open, including you on another
# machine. Only the vault is ignored: everything else in this directory is yours to track.
${VAULT_FILENAME}
${VAULT_FILENAME}.unreadable-*
`;

export async function ensureProjectVaultIgnored(scope: VaultScope, directory: string): Promise<void> {
	if (scope !== "project") return;
	const ignorePath = path.join(directory, ".gitignore");
	try {
		await fs.writeFile(ignorePath, PROJECT_VAULT_GITIGNORE, { flag: "wx", mode: 0o644 });
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			noteSecretsCondition(
				`Could not write ${safeText(ignorePath)} (${safeError(error)}), so the project vault about to be ` +
					`written is NOT protected from being committed. Add "${VAULT_FILENAME}" to that directory's ` +
					`.gitignore yourself, or store this secret in the profile vault instead.`,
			);
			return;
		}
	}
	try {
		const existing = await Bun.file(ignorePath).text();

		if (existing.split("\n").some(line => line.trim() === VAULT_FILENAME || line.trim() === `/${VAULT_FILENAME}`)) {
			return;
		}
		const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
		await fs.appendFile(ignorePath, `${separator}\n${PROJECT_VAULT_GITIGNORE}`);
	} catch (error) {
		noteSecretsCondition(
			`Could not check or extend ${safeText(ignorePath)} (${safeError(error)}), so the project vault may not ` +
				`be protected from being committed. Add "${VAULT_FILENAME}" to that file yourself, or store this ` +
				`secret in the profile vault instead.`,
		);
	}
}
export const VAULT_LOCK_OPTIONS = { staleMs: Number.POSITIVE_INFINITY } as const;

export const VAULT_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

export const VAULT_TEMP_FLAGS =
	fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;

export interface VaultScopePin {
	readonly directory: string;
	readonly ioDirectory: string;
	readonly directoryHandle: fs.FileHandle;
	readonly canonicalVaultPath: string;
	readonly directoryDev: number;
	readonly directoryIno: number;
}

export interface VaultFileSnapshot {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly nlink: number;
	readonly mode: number;
	readonly uid: number;
	readonly contentHash: string;
}

export function safeText(value: string): string {
	return escapeTerminalText(value);
}

export function safeError(error: unknown): string {
	return escapeTerminalText(errorMessage(error));
}

export function comparableVaultPath(vaultPath: string): string {
	const resolved = path.resolve(vaultPath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function canonicalVaultPath(vaultPath: string): Promise<string> {
	let current = path.dirname(path.resolve(vaultPath));
	const suffix = [path.basename(vaultPath)];
	for (;;) {
		try {
			return comparableVaultPath(path.join(await fs.realpath(current), ...suffix));
		} catch (error) {
			if (!isMissingPath(error)) throw error;
			const parent = path.dirname(current);
			if (parent === current) return comparableVaultPath(path.join(current, ...suffix));
			suffix.unshift(path.basename(current));
			current = parent;
		}
	}
}

export function canonicalVaultPathSync(vaultPath: string): string {
	let current = path.dirname(path.resolve(vaultPath));
	const suffix = [path.basename(vaultPath)];
	for (;;) {
		try {
			return comparableVaultPath(path.join(fsSync.realpathSync(current), ...suffix));
		} catch (error) {
			if (!isMissingPath(error)) throw error;
			const parent = path.dirname(current);
			if (parent === current) return comparableVaultPath(path.join(current, ...suffix));
			suffix.unshift(path.basename(current));
			current = parent;
		}
	}
}

export function sameInode(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

export function snapshotOf(stat: Stats, contentHash = ""): VaultFileSnapshot {
	return {
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		nlink: stat.nlink,
		mode: stat.mode,
		uid: stat.uid,
		contentHash,
	};
}

export function sameSnapshot(left: VaultFileSnapshot, right: Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.nlink === right.nlink &&
		left.mode === right.mode &&
		left.uid === right.uid
	);
}

export async function sameDisplacedSnapshot(
	expected: VaultFileSnapshot,
	displacedPath: string,
	stat: Stats,
): Promise<boolean> {
	if (
		expected.contentHash.length === 0 ||
		expected.dev !== stat.dev ||
		expected.ino !== stat.ino ||
		expected.size !== stat.size ||
		expected.mtimeMs !== stat.mtimeMs ||
		expected.nlink !== stat.nlink ||
		expected.mode !== stat.mode ||
		expected.uid !== stat.uid ||
		stat.size > MAX_VAULT_FILE_BYTES
	) {
		return false;
	}
	const bytes = await fs.readFile(displacedPath);
	return (
		bytes.byteLength === expected.size && createHash("sha256").update(bytes).digest("hex") === expected.contentHash
	);
}

export function vaultBinding(scope: VaultScope, pin: VaultScopePin): string {
	return `${scope}\0${pin.canonicalVaultPath}`;
}

export function physicalVaultBinding(scope: VaultScope, pin: VaultScopePin): string {
	return `${scope}\0${pin.canonicalVaultPath}\0${pin.directoryDev}\0${pin.directoryIno}`;
}

export function noteSupersededVaultBinding(scope: VaultScope, vaultPath: string): void {
	noteSecretsCondition(
		`Your ${scope} vault at ${safeText(vaultPath)} was sealed by a build that bound it to the directory's ` +
			`inode. That binding has been withdrawn because it did not survive a backup restore or a move. ` +
			`The vault opened normally and is being re-sealed the next time it changes. Nothing is required of you.`,
	);
}

export function openSealedVaultAcrossBindings(
	key: Buffer,
	parsed: SealedVault,
	scope: VaultScope,
	vaultPath: string,
	pin: VaultScopePin,
): string {
	try {
		return openVault(key, parsed, vaultBinding(scope, pin));
	} catch (error) {
		let migrated: string;
		try {
			migrated = openVault(key, parsed, physicalVaultBinding(scope, pin));
		} catch {
			throw error;
		}
		noteSupersededVaultBinding(scope, vaultPath);
		return migrated;
	}
}

export function scopeIdentity(pin: VaultScopePin): string {
	return `${pin.directoryDev}\0${pin.directoryIno}\0${path.basename(pin.canonicalVaultPath)}`;
}

export async function pinVaultScope(scope: VaultScope, vaultPath: string): Promise<VaultScopePin | null> {
	const directory = path.dirname(vaultPath);
	let before: Stats;
	try {
		before = await fs.lstat(directory);
	} catch (error) {
		if (isMissingPath(error)) return null;
		throw new Error(
			`The ${scope} vault directory at ${safeText(directory)} could not be inspected safely (${safeError(error)}).`,
		);
	}
	if (before.isSymbolicLink()) {
		throw new Error(
			`The ${scope} vault directory at ${safeText(directory)} is a symlink. Refusing to cross scope boundaries.`,
		);
	}
	if (!before.isDirectory()) {
		throw new Error(`The ${scope} vault directory at ${safeText(directory)} is not a directory. Refusing to use it.`);
	}

	let directoryHandle: fs.FileHandle | undefined;
	try {
		try {
			directoryHandle = await fs.open(
				directory,
				fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | fsConstants.O_NOFOLLOW,
			);
		} catch (error) {
			throw new Error(
				`The ${scope} vault directory at ${safeText(directory)} could not be opened safely (${safeError(error)}).`,
			);
		}
		const opened = await directoryHandle.stat();
		if (!opened.isDirectory() || !sameInode(before, opened)) {
			throw new Error(`The ${scope} vault directory changed while its descriptor was being pinned.`);
		}
		let canonical: string;
		try {
			canonical = comparableVaultPath(path.join(await fs.realpath(directory), path.basename(vaultPath)));
		} catch (error) {
			throw new Error(
				`The ${scope} vault directory at ${safeText(directory)} could not be resolved safely (${safeError(error)}).`,
			);
		}
		const after = await fs.lstat(directory);
		if (!after.isDirectory() || after.isSymbolicLink() || !sameInode(opened, after)) {
			throw new Error(`The ${scope} vault directory changed while its physical identity was being pinned.`);
		}
		const ioDirectory =
			process.platform === "linux"
				? `/proc/self/fd/${directoryHandle.fd}`
				: process.platform === "darwin"
					? `/dev/fd/${directoryHandle.fd}`
					: directory;
		return {
			directory,
			ioDirectory,
			directoryHandle,
			canonicalVaultPath: canonical,
			directoryDev: after.dev,
			directoryIno: after.ino,
		};
	} catch (error) {
		await directoryHandle?.close().catch(() => {});
		throw error;
	}
}

export async function verifyVaultScopePin(scope: VaultScope, pin: VaultScopePin): Promise<void> {
	let lexical: Stats;
	let opened: Stats;
	try {
		[lexical, opened] = await Promise.all([fs.lstat(pin.directory), pin.directoryHandle.stat()]);
	} catch (error) {
		throw new Error(
			`The ${scope} vault directory changed during the transaction (${safeError(error)}). Refusing to continue.`,
		);
	}
	if (
		!lexical.isDirectory() ||
		lexical.isSymbolicLink() ||
		!opened.isDirectory() ||
		lexical.dev !== pin.directoryDev ||
		lexical.ino !== pin.directoryIno ||
		opened.dev !== pin.directoryDev ||
		opened.ino !== pin.directoryIno
	) {
		throw new Error(`The ${scope} vault directory changed during the transaction. Refusing to continue.`);
	}
}

export async function closeVaultScopePin(pin: VaultScopePin): Promise<void> {
	await pin.directoryHandle.close();
}

export function pinnedVaultPath(pin: VaultScopePin, lexicalVaultPath: string): string {
	return path.join(pin.ioDirectory, path.basename(lexicalVaultPath));
}

export function assertVaultPathSafe(scope: VaultScope, vaultPath: string, stat: Stats, fromPath: boolean): void {
	if (fromPath && stat.isSymbolicLink()) {
		throw new Error(
			`The ${scope} vault at ${safeText(vaultPath)} is a symlink. Refusing to follow it across scope boundaries.`,
		);
	}
	if (!stat.isFile()) {
		throw new Error(`The ${scope} vault at ${safeText(vaultPath)} is not a regular file. Refusing to use it.`);
	}
	if (stat.nlink > 1) {
		throw new Error(
			`The ${scope} vault at ${safeText(vaultPath)} has ${stat.nlink} hard links. ` +
				`Refusing a vault that is reachable through another scope or path.`,
		);
	}
}

export function assertVaultNotExposed(scope: VaultScope, vaultPath: string, stat: Stats): void {
	if (process.platform === "win32") return;
	const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
	if (effectiveUid !== undefined && stat.uid !== effectiveUid) {
		throw new Error(
			`The ${scope} vault at ${safeText(vaultPath)} is owned by user ${stat.uid}, not the current user. Refusing it.`,
		);
	}
	if ((stat.mode & 0o077) === 0) return;
	throw new Error(
		`The ${scope} vault at ${safeText(vaultPath)} is accessible by other users ` +
			`(mode ${(stat.mode & 0o777).toString(8)}). Run: chmod 600 ${safeText(vaultPath)}`,
	);
}

export async function vaultPathStat(scope: VaultScope, vaultPath: string, pin: VaultScopePin): Promise<Stats | null> {
	await verifyVaultScopePin(scope, pin);
	const ioPath = pinnedVaultPath(pin, vaultPath);
	try {
		const stat = await fs.lstat(ioPath);
		assertVaultPathSafe(scope, vaultPath, stat, true);
		assertVaultNotExposed(scope, vaultPath, stat);
		await verifyOwnerOnlyWindowsAcl(ioPath);
		const afterAcl = await fs.lstat(ioPath);
		if (!sameSnapshot(snapshotOf(stat), afterAcl)) {
			throw new Error(`The ${scope} vault changed during its permission check.`);
		}
		await verifyVaultScopePin(scope, pin);
		return afterAcl;
	} catch (error) {
		if (isMissingPath(error)) {
			await verifyVaultScopePin(scope, pin);
			return null;
		}
		throw error;
	}
}

export async function assertExpectedVaultPath(
	scope: VaultScope,
	vaultPath: string,
	pin: VaultScopePin,
	expected: VaultFileSnapshot | null,
): Promise<void> {
	const current = await vaultPathStat(scope, vaultPath, pin);
	if (expected === null ? current !== null : current === null || !sameSnapshot(expected, current)) {
		throw new Error(`The ${scope} vault changed during the transaction. Refusing to replace another inode.`);
	}
	if (expected === null || current === null || expected.contentHash.length === 0) return;
	if (current.size > MAX_VAULT_FILE_BYTES) {
		throw new Error(`The ${scope} vault grew past its safety limit during the transaction. Refusing to replace it.`);
	}
	const bytes = await fs.readFile(pinnedVaultPath(pin, vaultPath));
	if (
		bytes.byteLength !== expected.size ||
		createHash("sha256").update(bytes).digest("hex") !== expected.contentHash
	) {
		throw new Error(
			`The ${scope} vault's contents changed during the transaction, though its path and metadata did not. ` +
				`Refusing to replace it and lose the change.`,
		);
	}
}

export async function removePathIfSameInode(target: string, identity: Pick<Stats, "dev" | "ino">): Promise<void> {
	let current: Stats;
	try {
		current = await fs.lstat(target);
	} catch (error) {
		if (isMissingPath(error)) return;
		throw error;
	}
	if (!current.isFile() || !sameInode(current, identity)) return;

	const quarantinePath = `${target}.${randomUUID()}.removing`;
	let moved: boolean;
	try {
		moved = moveNoReplace(target, quarantinePath);
	} catch (error) {
		try {
			await fs.lstat(target);
		} catch (pathError) {
			if (isMissingPath(pathError)) return;
		}
		throw error;
	}
	if (!moved) {
		throw new Error("A vault cleanup quarantine path already exists. Refusing to remove either entry.");
	}

	const quarantined = await fs.lstat(quarantinePath);
	if (!quarantined.isFile() || !sameInode(quarantined, identity)) {
		let restored: boolean;
		try {
			restored = moveNoReplace(quarantinePath, target);
		} catch (error) {
			throw new Error(
				`A racing vault cleanup entry could not be restored safely (${safeError(error)}). Refusing to continue.`,
			);
		}
		if (!restored) {
			throw new Error("A racing vault cleanup entry was isolated but its original path is occupied.");
		}
		throw new Error("A vault cleanup entry changed before removal. It was restored without deleting its bytes.");
	}

	await fs.rm(quarantinePath);
}

export async function retireDisplacedVault(
	scope: VaultScope,
	displacedPath: string,
	expected: VaultFileSnapshot,
): Promise<void> {
	const handle = await fs.open(displacedPath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
	let identity: Stats;
	try {
		identity = await handle.stat();
		assertVaultPathSafe(scope, displacedPath, identity, false);
		assertVaultNotExposed(scope, displacedPath, identity);
		if (
			identity.dev !== expected.dev ||
			identity.ino !== expected.ino ||
			identity.size !== expected.size ||
			identity.nlink !== expected.nlink
		) {
			throw new Error(`The displaced ${scope} vault changed before retirement.`);
		}
		await handle.truncate(0);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await removePathIfSameInode(displacedPath, identity);
}

export async function syncDirectory(scope: VaultScope, pin: VaultScopePin): Promise<void> {
	await verifyVaultScopePin(scope, pin);
	if (process.platform !== "win32") {
		const openStat = await pin.directoryHandle.stat();
		if (!openStat.isDirectory() || openStat.dev !== pin.directoryDev || openStat.ino !== pin.directoryIno) {
			throw new Error(`The ${scope} vault directory changed before it could be synced.`);
		}
		await pin.directoryHandle.sync();
	}
	await verifyVaultScopePin(scope, pin);
}
