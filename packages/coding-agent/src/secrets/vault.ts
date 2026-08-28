import { createHash, randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	applyOwnerOnlyWindowsAcl,
	clamp01,
	errorMessage,
	escapeTerminalText,
	isMissingPath,
	verifyOwnerOnlyWindowsAcl,
	withFileLock,
} from "@veyyon/utils";
import { isWellFormedUtf16 } from "@veyyon/utils/string-length";
import { moveNoReplace, replaceWithRollback } from "./atomic-path";
import { noteSecretsCondition } from "./notices";
import {
	buildNamePlaceholder,
	describeInvalidSecretName,
	isValidSecretName,
	MAX_SECRET_NAME_LENGTH,
} from "./placeholder";
import { canObfuscatePlainValue, MIN_OBFUSCATABLE_LENGTH, secretCharacterLength } from "./policy";
import {
	isSealedVault,
	loadOrCreateVaultKey,
	openVault,
	readVaultKey,
	type SealedVault,
	sealVault,
} from "./vault-crypto";

export type VaultScope = "profile" | "project" | "global";

export const VAULT_SCOPES: readonly VaultScope[] = ["global", "profile", "project"];

export const VAULT_SCOPES_NARROWEST_FIRST: readonly VaultScope[] = [...VAULT_SCOPES].reverse();

export const VAULT_FILENAME = "vault.json";

export const MAX_VAULT_FILE_BYTES = 8 * 1024 * 1024;

const SEALED_VAULT_FIXED_BYTES = Buffer.byteLength(
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

interface VaultFile {
	entries: VaultEntry[];
}

function isVaultEntry(value: unknown): value is VaultEntry {
	if (value === null || typeof value !== "object") return false;
	if (!("name" in value) || typeof value.name !== "string" || !isValidSecretName(value.name)) return false;
	if (!("value" in value) || typeof value.value !== "string" || !canObfuscatePlainValue(value.value)) return false;
	if (!("createdAt" in value) || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt)) {
		return false;
	}
	if (!("expiresAt" in value)) return false;
	return value.expiresAt === null || (typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt));
}

function safeParseFailure(error: unknown): string {
	if (!(error instanceof Error) || error.name.length === 0) return "unrecognised parse failure";
	return escapeTerminalText(error.name);
}

class UnparseableVaultPayloadError extends Error {}

function parseVaultFile(plaintext: string, scope: VaultScope, vaultPath: string): VaultFile {
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

const TTL_UNITS: Record<string, number> = {
	m: 60 * 1000,
	h: 60 * 60 * 1000,
	d: 24 * 60 * 60 * 1000,
	w: 7 * 24 * 60 * 60 * 1000,
};

const TTL_WORD = /^([0-9]+)([mhdw])$/;

export function isTtlWord(spec: string): boolean {
	const text = spec.trim().toLowerCase();
	return text === NEVER_TTL || TTL_WORD.test(text);
}

function assertValidNumericTtl(ttl: number): void {
	if (!Number.isSafeInteger(ttl) || ttl <= 0) {
		throw new Error("A lifetime must be a finite, positive, safely representable number of milliseconds.");
	}
}

function expiryFrom(now: number, ttl: number | null): number | null {
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

const GENERATED_NAME_PREFIX = "SECRET_";

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

const PROJECT_VAULT_GITIGNORE = `# Written by veyyon, and safe to keep.
#
# A vault is an encrypted credential store. Its key never leaves this machine, so committing one
# publishes a credential store that nobody who clones the repo can open, including you on another
# machine. Only the vault is ignored: everything else in this directory is yours to track.
${VAULT_FILENAME}
${VAULT_FILENAME}.unreadable-*
`;

async function ensureProjectVaultIgnored(scope: VaultScope, directory: string): Promise<void> {
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
const VAULT_LOCK_OPTIONS = { staleMs: Number.POSITIVE_INFINITY } as const;

const VAULT_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

const VAULT_TEMP_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;

interface VaultScopePin {
	readonly directory: string;
	readonly ioDirectory: string;
	readonly directoryHandle: fs.FileHandle;
	readonly canonicalVaultPath: string;
	readonly directoryDev: number;
	readonly directoryIno: number;
}

interface VaultFileSnapshot {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly nlink: number;
	readonly mode: number;
	readonly uid: number;
	readonly contentHash: string;
}

function safeText(value: string): string {
	return escapeTerminalText(value);
}

function safeError(error: unknown): string {
	return escapeTerminalText(errorMessage(error));
}

function comparableVaultPath(vaultPath: string): string {
	const resolved = path.resolve(vaultPath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function canonicalVaultPath(vaultPath: string): Promise<string> {
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

function canonicalVaultPathSync(vaultPath: string): string {
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

function sameInode(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function snapshotOf(stat: Stats, contentHash = ""): VaultFileSnapshot {
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

function sameSnapshot(left: VaultFileSnapshot, right: Stats): boolean {
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

async function sameDisplacedSnapshot(
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

function vaultBinding(scope: VaultScope, pin: VaultScopePin): string {
	return `${scope}\0${pin.canonicalVaultPath}`;
}

function physicalVaultBinding(scope: VaultScope, pin: VaultScopePin): string {
	return `${scope}\0${pin.canonicalVaultPath}\0${pin.directoryDev}\0${pin.directoryIno}`;
}

function noteSupersededVaultBinding(scope: VaultScope, vaultPath: string): void {
	noteSecretsCondition(
		`Your ${scope} vault at ${safeText(vaultPath)} was sealed by a build that bound it to the directory's ` +
			`inode. That binding has been withdrawn because it did not survive a backup restore or a move. ` +
			`The vault opened normally and is being re-sealed the next time it changes. Nothing is required of you.`,
	);
}

function openSealedVaultAcrossBindings(
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

function scopeIdentity(pin: VaultScopePin): string {
	return `${pin.directoryDev}\0${pin.directoryIno}\0${path.basename(pin.canonicalVaultPath)}`;
}

async function pinVaultScope(scope: VaultScope, vaultPath: string): Promise<VaultScopePin | null> {
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

async function verifyVaultScopePin(scope: VaultScope, pin: VaultScopePin): Promise<void> {
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

async function closeVaultScopePin(pin: VaultScopePin): Promise<void> {
	await pin.directoryHandle.close();
}

function pinnedVaultPath(pin: VaultScopePin, lexicalVaultPath: string): string {
	return path.join(pin.ioDirectory, path.basename(lexicalVaultPath));
}

function assertVaultPathSafe(scope: VaultScope, vaultPath: string, stat: Stats, fromPath: boolean): void {
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

function assertVaultNotExposed(scope: VaultScope, vaultPath: string, stat: Stats): void {
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

async function vaultPathStat(scope: VaultScope, vaultPath: string, pin: VaultScopePin): Promise<Stats | null> {
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

async function assertExpectedVaultPath(
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

async function removePathIfSameInode(target: string, identity: Pick<Stats, "dev" | "ino">): Promise<void> {
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

async function retireDisplacedVault(
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

async function syncDirectory(scope: VaultScope, pin: VaultScopePin): Promise<void> {
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
