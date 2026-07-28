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
import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clamp01, isMissingPath, withFileLock } from "@veyyon/utils";
import {
	buildNamePlaceholder,
	describeInvalidSecretName,
	isValidSecretName,
	MAX_SECRET_NAME_LENGTH,
} from "./placeholder";
import { canObfuscatePlainValue, MIN_OBFUSCATABLE_LENGTH } from "./policy";
import { isSealedVault, loadOrCreateVaultKey, openVault, readVaultKey, sealVault } from "./vault-crypto";

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
		throw new Error(`The decrypted ${scope} vault at ${vaultPath} is not valid JSON (${String(error)}).`);
	}
	if (value === null || typeof value !== "object" || !("entries" in value) || !Array.isArray(value.entries)) {
		throw new Error(`The decrypted ${scope} vault at ${vaultPath} has an invalid structure. Refusing to read it.`);
	}
	if (!value.entries.every(isVaultEntry)) {
		throw new Error(`The decrypted ${scope} vault at ${vaultPath} contains an invalid entry. Refusing to read it.`);
	}
	return { entries: value.entries };
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
	const text = spec.trim().toLowerCase();
	if (text === NEVER_TTL) return null;

	const match = /^([0-9]+)([mhdw])$/.exec(text);
	if (match === null) {
		throw new Error(
			`"${spec}" is not a lifetime. Write a number followed by m, h, d or w (for example 30m, 12h, 7d, 2w), ` +
				`or "${NEVER_TTL}" for a secret that does not expire.`,
		);
	}
	const amount = Number(match[1]);
	if (amount === 0) {
		throw new Error(`A lifetime of "${spec}" would expire immediately. Use a positive amount, or "${NEVER_TTL}".`);
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
	const candidate = raw
		.trim()
		.toUpperCase()
		.replace(/[\s-]+/g, "_");
	if (!isValidSecretName(candidate)) throw new Error(describeInvalidSecretName(raw));
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

/** Authenticate both the semantic scope and the exact intended path without storing either. */
function vaultBinding(scope: VaultScope, vaultPath: string): string {
	return `${scope}\0${path.resolve(vaultPath)}`;
}

/** Reject path aliases and special files before opening or replacing a vault. */
function assertVaultPathSafe(scope: VaultScope, vaultPath: string, stat: Stats, fromPath: boolean): void {
	if (fromPath && stat.isSymbolicLink()) {
		throw new Error(
			`The ${scope} vault at ${vaultPath} is a symlink. Refusing to follow it across scope boundaries.`,
		);
	}
	if (!stat.isFile()) {
		throw new Error(`The ${scope} vault at ${vaultPath} is not a regular file. Refusing to use it.`);
	}
	if (stat.nlink !== 1) {
		throw new Error(
			`The ${scope} vault at ${vaultPath} has ${stat.nlink} hard links. ` +
				`Refusing a vault that is reachable through another scope or path.`,
		);
	}
}

/** Inspect the final path without following it; `null` means the vault is genuinely absent. */
async function vaultPathStat(scope: VaultScope, vaultPath: string): Promise<Stats | null> {
	try {
		const stat = await fs.lstat(vaultPath);
		assertVaultPathSafe(scope, vaultPath, stat, true);
		return stat;
	} catch (error) {
		if (isMissingPath(error)) return null;
		throw error;
	}
}

/** Reject a scope directory that redirects its vault path before checking the final file. */
async function vaultDirectoryExistsSafely(scope: VaultScope, vaultPath: string): Promise<boolean> {
	const directory = path.dirname(vaultPath);
	let stat: Stats;
	try {
		stat = await fs.lstat(directory);
	} catch (error) {
		if (isMissingPath(error)) return false;
		throw error;
	}
	if (stat.isSymbolicLink()) {
		throw new Error(`The ${scope} vault directory at ${directory} is a symlink. Refusing to cross scope boundaries.`);
	}
	if (!stat.isDirectory()) {
		throw new Error(`The ${scope} vault directory at ${directory} is not a directory. Refusing to use it.`);
	}
	return true;
}

/** Persist a rename after its staged file has already been synced. */
async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await fs.open(directory, fsConstants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** Replace one vault crash-atomically, retaining the old inode until the final rename. */
async function writeVaultAtomically(scope: VaultScope, vaultPath: string, text: string): Promise<void> {
	if (!(await vaultDirectoryExistsSafely(scope, vaultPath))) {
		throw new Error(`The ${scope} vault directory disappeared before its vault could be written.`);
	}
	await vaultPathStat(scope, vaultPath);
	const directory = path.dirname(vaultPath);
	const temporaryPath = path.join(directory, `.${path.basename(vaultPath)}.${process.pid}.${randomUUID()}.tmp`);
	let installed = false;
	try {
		const handle = await fs.open(temporaryPath, VAULT_TEMP_FLAGS, 0o600);
		try {
			await handle.writeFile(text, { encoding: "utf8" });
			await handle.sync();
		} finally {
			await handle.close();
		}

		// A path swap during staging must not turn a rejected alias into an overwrite.
		if (!(await vaultDirectoryExistsSafely(scope, vaultPath))) {
			throw new Error(`The ${scope} vault directory changed while its vault was being written.`);
		}
		await vaultPathStat(scope, vaultPath);
		await fs.rename(temporaryPath, vaultPath);
		installed = true;
		await syncDirectory(directory);
	} finally {
		if (!installed) await fs.rm(temporaryPath, { force: true }).catch(() => {});
	}
}

/**
 * Read, write, and expire the vaults.
 *
 * Deliberately not a singleton: tests build one per temporary directory, and a session
 * builds one from its own resolved paths. `now` is injected for the same reason, so expiry
 * can be tested without waiting.
 */
export class SecretVault {
	readonly #locations: VaultLocations;
	readonly #now: () => number;

	constructor(locations: VaultLocations, now: () => number = () => Date.now()) {
		this.#locations = locations;
		this.#now = now;
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
		const byName = new Map<string, ScopedVaultEntry>();
		for (const scope of VAULT_SCOPES) {
			for (const entry of await this.#loadScope(scope)) {
				byName.set(entry.name, { ...entry, scope });
			}
		}
		return [...byName.values()];
	}

	/** Live entries in one scope, pruning any that have expired. */
	async #loadScope(scope: VaultScope): Promise<VaultEntry[]> {
		const all = await this.#readScopeRaw(scope);
		if (all === null) return [];

		const live = all.filter(entry => !isExpired(entry, this.#now()));
		if (live.length === all.length) return live;

		// Pruning on read is what makes "expired means deleted" true rather than aspirational.
		// The lock is taken only when a write is actually due, so an ordinary read stays cheap,
		// and the entries are re-read inside it so a concurrent add is not pruned away with the
		// expired ones.
		return await this.#withScopeLocked(scope, entries => {
			const stillLive = entries.filter(entry => !isExpired(entry, this.#now()));
			return { entries: stillLive, result: stillLive };
		});
	}

	/**
	 * Raw entries for a scope, or `null` when that scope has no vault.
	 *
	 * `null` means the file is absent. Every other failure throws, including a vault that
	 * exists with no readable key: answering "empty" there would stop protecting every
	 * secret the file holds while looking perfectly healthy.
	 */
	async #readScopeRaw(scope: VaultScope): Promise<VaultEntry[] | null> {
		const vaultPath = vaultPathFor(this.#locations, scope);
		if (!(await vaultDirectoryExistsSafely(scope, vaultPath))) return null;
		const pathStat = await vaultPathStat(scope, vaultPath);
		if (pathStat === null) return null;

		let handle;
		try {
			handle = await fs.open(vaultPath, VAULT_READ_FLAGS);
		} catch (error) {
			throw new Error(`The ${scope} vault at ${vaultPath} could not be opened safely (${String(error)}).`);
		}

		let text: string;
		try {
			const openStat = await handle.stat();
			assertVaultPathSafe(scope, vaultPath, openStat, false);
			if (openStat.dev !== pathStat.dev || openStat.ino !== pathStat.ino) {
				throw new Error(
					`The ${scope} vault at ${vaultPath} changed while it was being opened. Refusing to read it.`,
				);
			}
			text = await handle.readFile({ encoding: "utf8" });
		} finally {
			await handle.close();
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new Error(
				`The ${scope} vault at ${vaultPath} is not valid JSON (${String(error)}). ` +
					`It is encrypted, so it is not meant to be edited by hand.`,
			);
		}
		if (!isSealedVault(parsed)) {
			throw new Error(
				`The ${scope} vault at ${vaultPath} is not a sealed vault file. ` +
					`Restore it from a backup rather than editing it.`,
			);
		}

		const key = await readVaultKey(this.#locations.globalConfigRoot);
		if (key === null) {
			throw new Error(
				`The ${scope} vault at ${vaultPath} exists, but its key does not. ` +
					`Without the key nothing in it can be decrypted, and none of the secrets it holds are being ` +
					`protected. Restore the key file, or delete the vault and add the secrets again.`,
			);
		}

		const plaintext = openVault(key, parsed, vaultBinding(scope, vaultPath));
		return parseVaultFile(plaintext, scope, vaultPath).entries;
	}

	/**
	 * Read a scope, transform it, and write it back while holding the file lock.
	 *
	 * EVERY MUTATION GOES THROUGH HERE, because a vault change is a read-modify-write and this
	 * fleet routinely runs several agents against one profile at once. Two unlocked
	 * `/secret add` calls interleave as read-read-write-write, and the second write silently
	 * discards the first secret: the user stored a credential, saw it confirmed, and it was
	 * gone. `withFileLock` is the repository's existing owner for exactly this hazard (it is
	 * what `dirs.ts` uses), so this is a lock, not a new locking scheme.
	 *
	 * The callback receives the entries as they are INSIDE the lock, not as some earlier read
	 * saw them, which is what makes name generation and same-name replacement correct under
	 * contention.
	 */
	async #withScopeLocked<R>(
		scope: VaultScope,
		transform: (entries: VaultEntry[], exists: boolean) => { entries: VaultEntry[]; result: R; write?: boolean },
		createIfMissing = false,
	): Promise<R> {
		const vaultPath = vaultPathFor(this.#locations, scope);
		const directory = path.dirname(vaultPath);
		const directoryExists = await vaultDirectoryExistsSafely(scope, vaultPath);
		if (!directoryExists && !createIfMissing) return transform([], false).result;
		if (!directoryExists) {
			await fs.mkdir(directory, { recursive: true });
			if (!(await vaultDirectoryExistsSafely(scope, vaultPath))) {
				throw new Error(`The ${scope} vault directory disappeared while it was being created.`);
			}
		}
		const existingStat = await vaultPathStat(scope, vaultPath);
		if (existingStat === null && !createIfMissing) return transform([], false).result;
		return await withFileLock(
			vaultPath,
			async () => {
				const raw = await this.#readScopeRaw(scope);
				const { entries, result, write = true } = transform(raw ?? [], raw !== null);
				if (write) await this.#writeScope(scope, entries);
				return result;
			},
			VAULT_LOCK_OPTIONS,
		);
	}

	async #writeScope(scope: VaultScope, entries: VaultEntry[]): Promise<void> {
		const vaultPath = vaultPathFor(this.#locations, scope);
		const directory = path.dirname(vaultPath);
		if (!(await vaultDirectoryExistsSafely(scope, vaultPath))) {
			await fs.mkdir(directory, { recursive: true });
			if (!(await vaultDirectoryExistsSafely(scope, vaultPath))) {
				throw new Error(`The ${scope} vault directory disappeared while it was being created.`);
			}
		}
		const key = await loadOrCreateVaultKey(this.#locations.globalConfigRoot);
		const sealed = sealVault(key, JSON.stringify({ entries } satisfies VaultFile), vaultBinding(scope, vaultPath));
		// The staged inode is 0600, synced, and only then renamed over the old vault.
		await writeVaultAtomically(scope, vaultPath, JSON.stringify(sealed));
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
		if (options.value.length === 0) throw new Error("A secret cannot be empty.");
		if (!canObfuscatePlainValue(options.value)) {
			throw new Error(
				`This secret is ${options.value.length} characters, under the ${MIN_OBFUSCATABLE_LENGTH}-character ` +
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
				return { entries: [...existing.filter(e => e.name !== name), created], result: created };
			},
			true,
		);
		return { ...entry, scope };
	}

	/** Remove one entry by name. Returns the scope it was removed from, or `null`. */
	async remove(name: string): Promise<VaultScope | null> {
		const wanted = normaliseSecretName(name);
		for (const scope of VAULT_SCOPES_NARROWEST_FIRST) {
			const removed = await this.#withScopeLocked(scope, (current, exists) => {
				const live = current.filter(entry => !isExpired(entry, this.#now()));
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
		for (const scope of VAULT_SCOPES_NARROWEST_FIRST) {
			const updated = await this.#withScopeLocked<VaultEntry | null>(scope, (current, exists) => {
				const now = this.#now();
				const live = current.filter(entry => !isExpired(entry, now));
				const target = live.find(entry => entry.name === wanted);
				if (target === undefined) {
					return {
						entries: live,
						result: null,
						write: exists && live.length !== current.length,
					};
				}
				const next: VaultEntry = { ...target, createdAt: now, expiresAt: expiryFrom(now, ttl) };
				return {
					entries: [...live.filter(entry => entry.name !== wanted), next],
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
