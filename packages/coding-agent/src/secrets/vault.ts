/**
 * The secret vault: named credentials, encrypted at rest, that expire.
 *
 * A vault entry is a credential you hand veyyon once. The model never sees its value, only
 * its placeholder (`#GITHUB_TOKEN#`), and veyyon substitutes the real value into a command
 * just before it runs. See `vault-crypto.ts` for the at-rest story and its threat model,
 * and `placeholder.ts` for the token format both halves share.
 *
 * WHAT EXPIRY MEANS, because the wrong reading is dangerous. An expired secret is DELETED
 * and any surviving reference to it FAILS. It does not simply stop being obfuscated: that
 * would send the value to the model provider in plain text at the moment its protection
 * lapsed, making the feature's failure mode the exact harm it exists to prevent. Expiry is
 * evaluated when a secret is USED, not only when a timer fires, so a session that sits idle
 * past an expiry cannot spend a dead credential on the next command.
 *
 * SCOPE IS A SECURITY BOUNDARY, not a convenience. A vault entry belongs to one scope and
 * is invisible from the others. `profile` is the default because that is the boundary people
 * actually want: credentials for one line of work should not be reachable from a session
 * opened in another profile. `project` covers a repository, and `global` is the deliberate
 * "everywhere" choice.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	applyOwnerOnlyWindowsAcl,
	clamp01,
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

/** Where an entry lives, and therefore who can see it. */
export type VaultScope = "profile" | "project" | "global";

/**
 * Every scope, widest first. Read in this order so the narrowest wins a name clash.
 *
 * Precedence lives here and nowhere else, so `load` cannot disagree with `remove` about
 * which entry a name refers to.
 */
export const VAULT_SCOPES: readonly VaultScope[] = ["global", "profile", "project"];

/**
 * Every scope, narrowest first. The order for acting on a single named entry.
 *
 * WHY BOTH ORDERS EXIST, because having two is exactly what caused the bug they now prevent.
 * `load` reads widest first so a later scope overwrites an earlier one and the NARROWEST
 * entry is the one in effect. `remove` and `extend` therefore have to walk the other way, or
 * they act on an entry the user cannot see: with the same name in `project` and `profile`,
 * removing widest first deleted the `profile` copy and left the `project` one still
 * shadowing it, so `/secret rm` appeared to do nothing at all. Acting on the effective entry
 * is the only behaviour that matches what `list` shows.
 */
export const VAULT_SCOPES_NARROWEST_FIRST: readonly VaultScope[] = [...VAULT_SCOPES].reverse();

/** Filename used for the vault in every scope. */
export const VAULT_FILENAME = "vault.json";

/** Maximum sealed vault envelope accepted from disk, before any bytes are parsed or decoded. */
export const MAX_VAULT_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Largest plaintext that can possibly fit in the outer envelope.
 *
 * The GCM ciphertext is the same byte length as the plaintext and base64 expands it to
 * `4 * ceil(n / 3)`. Checking this bound before JSON construction or encryption prevents a
 * caller-controlled value from causing several large transient allocations only to be rejected
 * after sealing.
 */
const SEALED_VAULT_FIXED_BYTES = Buffer.byteLength(
	JSON.stringify({ v: 2, iv: "A".repeat(16), tag: "A".repeat(24), ct: "" }),
	"utf8",
);
export const MAX_VAULT_PLAINTEXT_BYTES = Math.floor((MAX_VAULT_FILE_BYTES - SEALED_VAULT_FIXED_BYTES) / 4) * 3;

/** A stored credential. */
export interface VaultEntry {
	/** Placeholder name, uppercase. Unique within a scope. */
	name: string;
	/** The credential. Never logged, never sent to a provider, never shown by `list`. */
	value: string;
	/** Epoch milliseconds when this was added. */
	createdAt: number;
	/**
	 * Epoch milliseconds when this stops being usable, or `null` for a secret that never
	 * expires.
	 *
	 * `null` rather than a sentinel far-future number, so "never" cannot be mistaken for
	 * "expires in the year 10000" by arithmetic that forgets to check.
	 */
	expiresAt: number | null;
}

/** An entry plus the scope it was read from. */
export interface ScopedVaultEntry extends VaultEntry {
	scope: VaultScope;
}

/** The plaintext shape inside a sealed vault file. */
interface VaultFile {
	entries: VaultEntry[];
}

/** Validate decrypted state before any value can reach expansion or redaction machinery. */
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

/** Parse a decrypted payload without treating malformed state as an empty vault. */
function parseVaultFile(plaintext: string, scope: VaultScope, vaultPath: string): VaultFile {
	let value: unknown;
	try {
		value = JSON.parse(plaintext);
	} catch (error) {
		throw new Error(
			`The decrypted ${scope} vault at ${safeText(vaultPath)} is not valid JSON ` + `(${safeError(error)}).`,
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
	// Return a closed shape. Otherwise authenticated but unrecognised properties could make the
	// preflight size calculation underestimate what JSON.stringify would later allocate.
	return {
		entries: value.entries.map(entry => ({
			name: entry.name,
			value: entry.value,
			createdAt: entry.createdAt,
			expiresAt: entry.expiresAt,
		})),
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Expiry
// ═══════════════════════════════════════════════════════════════════════════

/** Default lifetime when none is given: one day. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** The literal a user writes for a secret that never expires. */
export const NEVER_TTL = "never";

/** Fractions of a lifetime at which the operator is warned. */
export const WARN_AT_FRACTIONS: readonly number[] = [0.5, 0.9];

const TTL_UNITS: Record<string, number> = {
	m: 60 * 1000,
	h: 60 * 60 * 1000,
	d: 24 * 60 * 60 * 1000,
	w: 7 * 24 * 60 * 60 * 1000,
};

/** A numeric TTL must survive both arithmetic and JSON without changing meaning. */
function assertValidNumericTtl(ttl: number): void {
	if (!Number.isSafeInteger(ttl) || ttl <= 0) {
		throw new Error("A lifetime must be a finite, positive, safely representable number of milliseconds.");
	}
}

/** Add a TTL without allowing an unsafe timestamp to become `null` when JSON is written. */
function expiryFrom(now: number, ttl: number | null): number | null {
	if (ttl === null) return null;
	assertValidNumericTtl(ttl);
	const expiresAt = now + ttl;
	if (!Number.isSafeInteger(expiresAt)) {
		throw new Error("This lifetime is too large to store as a safe expiry timestamp.");
	}
	return expiresAt;
}

/**
 * Parse a lifetime such as `30m`, `12h`, `7d`, `2w`, or `never`.
 *
 * Returns milliseconds, or `null` for `never`. Throws on anything else rather than falling
 * back to the default, because a typo like `7dd` silently becoming one day is how a
 * credential outlives the window its owner thought they had chosen.
 */
export function parseTtl(spec: string): number | null {
	if (spec.length > 64) {
		throw new Error(
			"This lifetime is too large to represent safely. Use a short amount such as 30m, 12h, 7d, or 2w.",
		);
	}
	const text = spec.trim().toLowerCase();
	if (text === NEVER_TTL) return null;

	const match = /^([0-9]+)([mhdw])$/.exec(text);
	if (match === null) {
		throw new Error(
			`"${safeText(spec)}" is not a lifetime. Write a number followed by m, h, d or w ` +
				`(for example 30m, 12h, 7d, 2w), or "${NEVER_TTL}" for a secret that does not expire.`,
		);
	}
	const amount = Number(match[1]);
	if (amount === 0) {
		throw new Error(
			`A lifetime of "${safeText(spec)}" would expire immediately. Use a positive amount, or "${NEVER_TTL}".`,
		);
	}
	const ttl = amount * TTL_UNITS[match[2]];
	if (!Number.isSafeInteger(ttl)) {
		throw new Error("This lifetime is too large to represent safely. Choose a smaller positive amount.");
	}
	return ttl;
}

/** Render a lifetime the way {@link parseTtl} would read it back. */
export function formatTtl(ms: number | null): string {
	if (ms === null) return NEVER_TTL;
	assertValidNumericTtl(ms);
	// Days, hours, minutes only. `w` is accepted as INPUT sugar and never shown, because
	// flipping to weeks at every multiple of seven displayed "1w" for a lifetime the user
	// typed as "7d". Credential lifetimes read naturally in days.
	for (const [unit, size] of [
		["d", TTL_UNITS.d],
		["h", TTL_UNITS.h],
		["m", TTL_UNITS.m],
	] as const) {
		if (ms % size === 0) return `${ms / size}${unit}`;
	}
	return `${Math.round(ms / TTL_UNITS.m)}m`;
}

/** Whether an entry has expired at `now`. */
export function isExpired(entry: VaultEntry, now: number): boolean {
	return entry.expiresAt !== null && entry.expiresAt <= now;
}

/**
 * How far through its life an entry is, from 0 to 1, or `null` when it never expires.
 *
 * Fractional rather than absolute so one rule serves every lifetime: warning at "24 hours
 * left" is useless for a one-day secret and far too late for a 90-day one.
 */
export function lifeFraction(entry: VaultEntry, now: number): number | null {
	if (entry.expiresAt === null) return null;
	const span = entry.expiresAt - entry.createdAt;
	if (span <= 0) return 1;
	return clamp01((now - entry.createdAt) / span);
}

/**
 * The highest warning threshold this entry has crossed, or `null` for nothing to say.
 *
 * Returns the fraction rather than a boolean so the caller can warn once per threshold
 * instead of once per check, which would put a line in front of the operator every turn.
 */
export function warningThresholdCrossed(entry: VaultEntry, now: number): number | null {
	const fraction = lifeFraction(entry, now);
	if (fraction === null) return null;
	let crossed: number | null = null;
	for (const threshold of WARN_AT_FRACTIONS) {
		if (fraction >= threshold) crossed = threshold;
	}
	return crossed;
}

/** Human phrase for how long an entry has left. */
export function describeTimeLeft(entry: VaultEntry, now: number): string {
	if (entry.expiresAt === null) return "never expires";
	const left = entry.expiresAt - now;
	if (left <= 0) return "expired";
	if (left < TTL_UNITS.h) return `${Math.max(1, Math.round(left / TTL_UNITS.m))}m left`;
	if (left < TTL_UNITS.d) return `${Math.round(left / TTL_UNITS.h)}h left`;
	return `${Math.round(left / TTL_UNITS.d)}d left`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Names
// ═══════════════════════════════════════════════════════════════════════════

/** Prefix for names veyyon invents when the user does not supply one. */
const GENERATED_NAME_PREFIX = "SECRET_";

/**
 * Turn whatever the user typed into a usable name, or throw explaining why not.
 *
 * Accepts the shapes people actually type (`github-token`, `github token`, lowercase) and
 * normalises them, rather than refusing on a technicality the user cannot see the point of.
 */
export function normaliseSecretName(raw: string): string {
	if (raw.length > MAX_SECRET_NAME_LENGTH + 64) {
		throw new Error(
			`This secret name input is too long. Use ${MAX_SECRET_NAME_LENGTH} characters or fewer after trimming.`,
		);
	}
	// Validate BEFORE case conversion. Unicode uppercasing is not one-to-one (`ſ` becomes `S`),
	// so normalising first can alias a rejected Unicode spelling onto an existing ASCII secret.
	// User-facing conveniences are deliberately limited to this documented raw ASCII alphabet.
	if (!/^[A-Za-z0-9 _-]+$/.test(raw)) {
		throw new Error(describeInvalidSecretName(safeText(raw)));
	}
	const candidate = raw.trim().toUpperCase().replace(/[ -]+/g, "_");
	if (!isValidSecretName(candidate)) throw new Error(describeInvalidSecretName(safeText(raw)));
	return candidate;
}

/**
 * Invent a name that is not already taken.
 *
 * Used when the user gives a value and no name. Every entry still gets a NAME rather than
 * falling back to an index placeholder, so the model always has something it can refer to
 * on purpose, and `/secret list` always has something to show.
 */
export function generateSecretName(taken: ReadonlySet<string>): string {
	for (let n = 1; n < 10_000; n++) {
		const candidate = `${GENERATED_NAME_PREFIX}${n}`;
		if (candidate.length <= MAX_SECRET_NAME_LENGTH && !taken.has(candidate)) return candidate;
	}
	throw new Error("Could not invent an unused secret name. Remove some entries with /secret rm.");
}

// ═══════════════════════════════════════════════════════════════════════════
// Store
// ═══════════════════════════════════════════════════════════════════════════

/** Directories each scope keeps its vault in. */
export interface VaultLocations {
	/** Cross-profile config root (`~/.veyyon`). Holds the key, and the global vault. */
	globalConfigRoot: string;
	/** Active profile's agent dir. */
	profileDir: string;
	/** Project-local `.veyyon` directory. */
	projectDir: string;
}

/**
 * Where the vaults live for a given working directory.
 *
 * ONE OWNER for this arithmetic, because the startup path and the `/secret` command must
 * agree byte for byte about which files they are looking at. If they disagreed, a secret
 * added by the command would be invisible to the session that added it, which is the sort of
 * bug that looks like "the vault randomly does not work".
 */
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

/** Absolute vault path for one scope. */
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
/** A live PID is never reaped; dead owners are still detected immediately by the shared lock. */
const VAULT_LOCK_OPTIONS = { staleMs: Number.POSITIVE_INFINITY } as const;

/** Read through a checked descriptor without following or blocking on a swapped special file. */
const VAULT_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

/** Stage every replacement as a new owner-only regular file in the destination directory. */
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
	readonly ctimeMs: number;
	readonly nlink: number;
	readonly mode: number;
	readonly uid: number;
	readonly contentHash: string;
}

function safeText(value: string): string {
	return escapeTerminalText(value);
}

function safeError(error: unknown): string {
	return escapeTerminalText(String(error));
}

/** Compare scope paths using Windows' case-insensitive namespace when appropriate. */
function comparableVaultPath(vaultPath: string): string {
	const resolved = path.resolve(vaultPath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Resolve existing ancestors so aliases of one physical directory share ownership and AAD.
 * Missing suffixes remain lexical, which keeps first-write paths stable.
 */
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
		ctimeMs: stat.ctimeMs,
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
		left.ctimeMs === right.ctimeMs &&
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

/**
 * What a sealed vault is bound to: its scope and the exact path it was written for.
 *
 * DELIBERATELY NOT THE DIRECTORY'S DEVICE AND INODE. Those were in this binding for two days and the
 * result was that every vault written by a shipped build became permanently undecryptable, because
 * the authenticated data changed while the envelope stayed at version 2. The deeper problem is that
 * an inode is not a property of the scope, it is a property of where the bytes physically sit today.
 * It changes on a backup restore, a `cp -a`, a profile moved to another disk, a container bind
 * mount, and any filesystem that reassigns inodes. Ciphertext bound to it does not survive any of
 * those, and a credential store that cannot be restored from a backup is worse than one that was
 * never encrypted, because the loss is silent until the day you need it.
 *
 * The protection dev/ino genuinely provides is against the directory being swapped underneath a
 * live operation, and that is a RUNTIME question. It stays where it belongs, in {@link pinVaultScope}
 * and {@link assertExpectedVaultPath}, which pin and re-check the inode across every read, lock, and
 * replace. Nothing is weakened by keeping it out of the ciphertext.
 */
function vaultBinding(scope: VaultScope, pin: VaultScopePin): string {
	return `${scope}\0${pin.canonicalVaultPath}`;
}

/**
 * The binding builds between 2026-07-27 23:52 and this change wrote, kept so those vaults still open.
 *
 * Read-only and second in line. A vault that authenticates under it is re-sealed with the binding
 * above on its next write, so the form disappears from disk on its own rather than becoming a
 * permanent second format.
 */
function physicalVaultBinding(scope: VaultScope, pin: VaultScopePin): string {
	return `${scope}\0${pin.canonicalVaultPath}\0${pin.directoryDev}\0${pin.directoryIno}`;
}

/**
 * Tell the operator their vault is still sealed under the superseded binding.
 *
 * Named rather than inlined so the sentence has one home and reads the same wherever it surfaces.
 * It carries the scope and the path and nothing from inside the vault.
 */
function noteSupersededVaultBinding(scope: VaultScope, vaultPath: string): void {
	noteSecretsCondition(
		`Your ${scope} vault at ${safeText(vaultPath)} was sealed by a build that bound it to the directory's ` +
			`inode. That binding has been withdrawn because it did not survive a backup restore or a move. ` +
			`The vault opened normally and is being re-sealed the next time it changes. Nothing is required of you.`,
	);
}

/**
 * Open a sealed vault under the current binding, falling back to the superseded one.
 *
 * NOT A SILENT FALLBACK. The second attempt is a one-way format migration with a bounded lifetime,
 * not a degraded path: it is tried only after the current binding fails, it can only succeed on a
 * vault this product itself wrote, it cannot weaken authentication (a forged or corrupt file fails
 * both), and when it succeeds the operator is told and the vault is re-sealed under the current
 * binding on its next write. The alternative is what dogfooding actually found: a hard startup
 * failure telling the operator their key was wrong, their file was modified, or their vault had
 * moved, when in truth the product had changed its own authenticated data underneath them.
 */
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
			// Report the FIRST failure. The fallback's error would describe an attempt
			// the operator never asked for and cannot act on.
			throw error;
		}
		noteSupersededVaultBinding(scope, vaultPath);
		return migrated;
	}
}

function scopeIdentity(pin: VaultScopePin): string {
	return `${pin.directoryDev}\0${pin.directoryIno}\0${path.basename(pin.canonicalVaultPath)}`;
}

/** Pin the final scope directory before a read, lock, or mutation can cross it. */
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
		directoryHandle = await fs.open(
			directory,
			fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | fsConstants.O_NOFOLLOW,
		);
		const opened = await directoryHandle.stat();
		if (!opened.isDirectory() || !sameInode(before, opened)) {
			throw new Error(`The ${scope} vault directory changed while its descriptor was being pinned.`);
		}
		const canonical = comparableVaultPath(path.join(await fs.realpath(directory), path.basename(vaultPath)));
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

/** Verify that a lexical scope path still reaches the parent inode pinned for this transaction. */
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

/** Reject path aliases and special files before opening or replacing a vault. */
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

/** Refuse foreign ownership or group/other access to an existing plaintext-bearing envelope. */
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

/** Inspect the final path without following it; `null` means the vault is genuinely absent. */
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

	// Rename first so the pathname and inode are consumed in one kernel operation. An
	// lstat-then-rm sequence can unlink a different file installed between those calls.
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

/** Persist a rename after its staged file has already been synced. */
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

/** Replace one vault crash-atomically, retaining the old inode until the final rename. */
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

/** Exact UTF-8 byte length of a JSON string without constructing the escaped string. */
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

/** Exact encoded plaintext size for the closed VaultFile shape. */
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

/** Whether a transform preserved the complete ordered plaintext state. */
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

/** Replace a named entry in place, collapsing malformed duplicates without reordering peers. */
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

function vaultRevision(locations: VaultLocations): string {
	const hash = createHash("sha256");
	for (const scope of VAULT_SCOPES) {
		const lexical = vaultPathFor(locations, scope);
		const lexicalDirectory = path.dirname(lexical);
		hash.update(
			`${scope}\0lexical:${comparableVaultPath(lexical)}\0` +
				`lexical-parent:${revisionStat(lexicalDirectory)}\0` +
				`lexical-vault:${revisionStat(lexical)}\0`,
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
		hash.update(
			`canonical:${canonical}\0canonical-parent:${revisionStat(path.dirname(canonical))}\0` +
				`canonical-vault:${revisionStat(canonical)}\0`,
		);
	}
	return hash.digest("hex");
}

/**
 * Read, write, and expire the vaults.
 *
 * Deliberately not a singleton: tests build one per temporary directory, and a session
 * builds one from its own resolved paths. `now` is injected for the same reason, so expiry
 * can be tested without waiting.
 */
interface VaultReadResult {
	readonly entries: VaultEntry[];
	readonly snapshot: VaultFileSnapshot;
	readonly sealedText: string;
}

export class SecretVault {
	readonly #locations: VaultLocations;
	readonly #now: () => number;

	constructor(locations: VaultLocations, now: () => number = () => Date.now()) {
		this.#locations = locations;
		this.#now = now;
	}

	/**
	 * Synchronous fingerprint of every configured scope boundary and vault inode.
	 *
	 * SDK runtimes capture this after loading named secrets and compare it immediately before
	 * expansion. A different process replacing a vault or its parent therefore revokes the
	 * captured expansion rights without waiting for an asynchronous watcher.
	 */
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

	/**
	 * Every live entry, nearest scope last.
	 *
	 * Project overrides profile overrides global on a name clash, matching how the rest of
	 * veyyon resolves configuration: the more specific location wins.
	 *
	 * Expired entries are REMOVED from disk here rather than merely filtered out, so reading
	 * the vault is also what prunes it and a value cannot linger on disk after its lifetime.
	 */
	async load(): Promise<ScopedVaultEntry[]> {
		const now = this.#now();
		const byName = new Map<string, ScopedVaultEntry>();
		for (const scope of VAULT_SCOPES) {
			const vaultPath = vaultPathFor(this.#locations, scope);
			const pin = await pinVaultScope(scope, vaultPath);
			if (pin === null) continue;
			try {
				// One physical file cannot carry two semantic scope bindings, so the widest
				// configured owner reads it exactly once.
				if ((await this.#scopePathOwner(scope, pin)) !== scope) continue;
				for (const entry of await this.#loadScope(scope, pin, now)) {
					// Map.set updates a value in place. Delete first so an override is ordered
					// with the narrower scope that owns the winning value.
					byName.delete(entry.name);
					byName.set(entry.name, { ...entry, scope });
				}
			} finally {
				await closeVaultScopePin(pin);
			}
		}
		return [...byName.values()];
	}

	/** Live entries in one pinned scope, pruning any that have expired. */
	async #loadScope(scope: VaultScope, pin: VaultScopePin, now: number): Promise<VaultEntry[]> {
		const read = await this.#readScopeRaw(scope, pin);
		if (read === null) return [];
		const all = read.entries;
		const live = all.filter(entry => !isExpired(entry, now));
		if (live.length === all.length) return live;

		// Re-read inside the lock so a concurrent add is not pruned with the expired entries.
		return await this.#withScopeLocked(scope, entries => {
			const stillLive = entries.filter(entry => !isExpired(entry, now));
			return { entries: stillLive, result: stillLive };
		});
	}

	/**
	 * Raw entries and the exact final inode snapshot used, or `null` when no vault exists.
	 * The supplied parent pin remains valid before and after every pathname or descriptor I/O.
	 */
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
				`The ${scope} vault at ${safeText(vaultPath)} is not valid JSON (${safeError(error)}). ` +
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
					`scope or path. Refusing to guess its provenance. Re-add its credentials into the intended scope.`,
			);
		}

		const key = await readVaultKey(this.#locations.globalConfigRoot);
		if (key === null) {
			throw new Error(
				`The ${scope} vault at ${safeText(vaultPath)} exists, but its key does not. ` +
					`Without the key nothing in it can be decrypted, and none of the secrets it holds are being ` +
					`protected. Restore the key file, or delete the vault and add the secrets again.`,
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

	/**
	 * Read, transform, and replace a scope while the shared inter-process lock is held.
	 * The parent inode pinned before lock acquisition must survive through lock cleanup.
	 */
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
		await writeVaultAtomically(scope, vaultPath, pin, expected, text);
	}

	/**
	 * Store a secret, replacing any entry of the same name in the same scope.
	 *
	 * Refuses a value the obfuscator could not protect, for the reason spelled out in
	 * `policy.ts`: accepting it here would produce an entry that looks stored and is sent to
	 * the provider verbatim.
	 */
	async add(options: {
		name?: string;
		value: string;
		scope?: VaultScope;
		ttl?: number | null;
	}): Promise<ScopedVaultEntry> {
		const scope = options.scope ?? "profile";
		if (!isWellFormedUtf16(options.value)) {
			throw new Error("This secret contains ill-formed UTF-16. Refusing to store it.");
		}
		if (options.value.length === 0) throw new Error("A secret cannot be empty.");
		if (options.value.length > MAX_VAULT_PLAINTEXT_BYTES) {
			throw new Error(
				`This secret value is over the ${MAX_VAULT_PLAINTEXT_BYTES}-byte plaintext safety limit. ` +
					"Refusing it before encoded-size scanning or serialization.",
			);
		}
		const encodedValueBytes = jsonStringByteLength(options.value);
		if (encodedValueBytes > MAX_VAULT_PLAINTEXT_BYTES) {
			throw new Error(
				`This secret value needs ${encodedValueBytes} bytes in the vault, over the ` +
					`${MAX_VAULT_PLAINTEXT_BYTES}-byte plaintext safety limit. Refusing it before serialization.`,
			);
		}
		if (!canObfuscatePlainValue(options.value)) {
			throw new Error(
				`This secret is ${secretCharacterLength(options.value)} characters, under the ${MIN_OBFUSCATABLE_LENGTH}-character ` +
					`minimum. Values that short cannot be replaced in text without cutting into ordinary words, ` +
					`so storing it would not protect it.`,
			);
		}

		// The name is validated BEFORE the lock, so a bad name fails fast without contending.
		const requestedName = options.name === undefined ? undefined : normaliseSecretName(options.name);
		const ttl = options.ttl === undefined ? DEFAULT_TTL_MS : options.ttl;
		if (ttl !== null) assertValidNumericTtl(ttl);

		const entry = await this.#withScopeLocked(
			scope,
			existing => {
				// Generated inside the lock: a name chosen against a stale read could collide with a
				// secret another session added in the meantime and overwrite it.
				const name = requestedName ?? generateSecretName(new Set(existing.map(e => e.name)));
				const now = this.#now();
				const created: VaultEntry = {
					name,
					value: options.value,
					createdAt: now,
					expiresAt: expiryFrom(now, ttl),
				};
				return { entries: replaceVaultEntry(existing, created), result: created };
			},
			true,
		);
		return { ...entry, scope };
	}

	/** Remove one entry by name. Returns the scope it was removed from, or `null`. */
	async remove(name: string): Promise<VaultScope | null> {
		const wanted = normaliseSecretName(name);
		const now = this.#now();
		for (const scope of VAULT_SCOPES_NARROWEST_FIRST) {
			const removed = await this.#withScopeLocked(scope, (current, exists) => {
				const live = current.filter(entry => !isExpired(entry, now));
				const found = live.some(entry => entry.name === wanted);
				const next = found ? live.filter(entry => entry.name !== wanted) : live;
				return {
					entries: next,
					result: found,
					write: exists && next.length !== current.length,
				};
			});
			if (removed) return scope;
		}
		return null;
	}

	/**
	 * Push an entry's expiry out from now.
	 *
	 * Measured from now rather than from the old expiry, so extending a secret that is nearly
	 * dead gives you the full window you asked for instead of a few remaining minutes.
	 */
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

	/** Live entries as the obfuscator wants them: name, value, and the placeholder. */
	async namedSecrets(): Promise<
		Array<{ name: string; value: string; placeholder: string; expiresAt: number | null }>
	> {
		return (await this.load()).map(entry => ({
			name: entry.name,
			value: entry.value,
			placeholder: buildNamePlaceholder(entry.name),
			// Carried out with the value, because the caller that installs it into the obfuscator
			// needs the deadline to enforce the lifetime at the moment of use. Returning the value
			// without it made every reconciled secret look like one that never expires.
			expiresAt: entry.expiresAt,
		}));
	}
}
