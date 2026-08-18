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

/**
 * What {@link SecretVault.add} stored, and whether it took the place of an entry that was
 * already there.
 *
 * `add` replaces a same-name entry in the same scope, which is what makes rotating a credential
 * work. The caller has to be able to SAY that happened. Reporting the same "stored" sentence for
 * a new entry and for one that overwrote a working credential means a mistyped name that collides
 * with an existing secret destroys it with no operator-visible signal at all.
 */
export interface AddedVaultEntry extends ScopedVaultEntry {
	/** True when an entry of the same name in the same scope was overwritten. */
	replaced: boolean;
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

/**
 * Name a failure to parse vault bytes WITHOUT repeating any of them.
 *
 * A parser quotes the token it choked on: `JSON Parse error: Unexpected identifier "ghp_live_..."`.
 * That token is content from a credential store, and an adversarial test caught it travelling from
 * the file into an operator notice, which puts it on screen and into the transcript. There is no
 * way to tell which parts of a parser's message came from its input, so the message is dropped
 * whole and only the error's TYPE survives.
 *
 * Nothing actionable is lost. The vault is encrypted, so an operator cannot hand-repair it from a
 * byte offset anyway; the repair is to move the file aside. The distinction that does matter, "not
 * JSON at all" versus "JSON of the wrong shape", is preserved because the wrong-shape case is a
 * separate branch with its own message.
 */
function safeParseFailure(error: unknown): string {
	if (!(error instanceof Error) || error.name.length === 0) return "unrecognised parse failure";
	return escapeTerminalText(error.name);
}

/**
 * A vault that cleared every provenance and integrity check and still would not parse.
 *
 * A distinct class because {@link SecretVault.load} degrades past exactly this failure and must
 * stay fatal on all the others. That distinction is load-bearing, not stylistic. An earlier version
 * of the degrade caught every error, which quietly converted the refusals for a hardlinked vault, a
 * symlink crossing scopes, a sealed vault copied into another scope, a world-readable vault, an
 * oversized vault, unknowable legacy provenance, and a TOCTOU replacement between the pathname and
 * descriptor checks into "that scope simply has no secrets". Each of those is an attacker signal,
 * and dropping the scope also drops its values out of the obfuscator, so a credential the operator
 * later pastes is no longer redacted on its way to the provider. A boot refusal became a silent
 * disclosure path.
 *
 * NEVER widen what throws this, and never catch it where that distinction is not the whole point.
 */
class UnparseableVaultPayloadError extends Error {}

/** Parse a decrypted payload without treating malformed state as an empty vault. */
function parseVaultFile(plaintext: string, scope: VaultScope, vaultPath: string): VaultFile {
	let value: unknown;
	try {
		value = JSON.parse(plaintext);
	} catch (error) {
		// The ONE degradable failure. Reaching this line means the sealed envelope parsed, the
		// pathname and descriptor checks passed, and the AEAD authenticated the ciphertext against
		// this scope's binding, so the file is provably ours and provably not swapped: only its
		// plaintext is malformed. Every other refusal in this file is about provenance or integrity
		// and MUST stay fatal, because skipping one of those drops the scope's secrets, and a scope
		// whose secrets are absent silently stops redacting them.
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

/**
 * The SHAPE of a lifetime word, owned here because two callers now depend on it.
 *
 * `parseSecretCommand` has to decide whether a trailing word on a `/secret` line IS a lifetime
 * before it can parse one, now that a lifetime is a plain word rather than the value of a flag.
 * A second regex over there would drift from this one the moment a unit is added, and the drift is
 * silent in the worse direction: a `3y` that {@link parseTtl} learned to read would be refused as an
 * unknown extra word, and the operator would be told the grammar has no lifetime at all.
 *
 * SHAPE, NOT VALIDITY, and the distinction is load-bearing. `0d` matches this and is then REFUSED
 * by {@link parseTtl} for expiring immediately, which is the message that mistake deserves. A
 * recogniser that answered "valid lifetime" instead would drop `0d` through to the extra-word
 * refusal and explain nothing.
 */
const TTL_WORD = /^([0-9]+)([mhdw])$/;

/** Whether a word is shaped like a lifetime, so a caller can tell one from a name or a vault. */
export function isTtlWord(spec: string): boolean {
	const text = spec.trim().toLowerCase();
	return text === NEVER_TTL || TTL_WORD.test(text);
}

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

	const match = TTL_WORD.exec(text);
	// NEITHER refusal repeats the spec back. A lifetime is typed on the same line as a credential,
	// and the realistic slip puts the credential where the lifetime goes (a lifetime slot holding `sk-live-...`) or
	// where a verb expects nothing. Echoing it wrote the credential into an error that reaches the
	// scrollback and the saved transcript. The two cases stay separately worded, because "not a
	// lifetime" and "expires immediately" are different mistakes with different fixes.
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

/**
 * Human phrase for a remaining lifetime in milliseconds.
 *
 * ONE OWNER FOR THE WORDING, because two surfaces say it: the `/secret list` EXPIRES column, and the
 * composer's secrets chip, which reports the SOONEST deadline of everything spendable in this
 * directory. A chip that rounded differently from the table would have the two disagree about the
 * same credential on the same screen.
 */
export function describeMsLeft(left: number): string {
	if (left <= 0) return "expired";
	if (left < TTL_UNITS.h) return `${Math.max(1, Math.round(left / TTL_UNITS.m))}m left`;
	if (left < TTL_UNITS.d) return `${Math.round(left / TTL_UNITS.h)}h left`;
	return `${Math.round(left / TTL_UNITS.d)}d left`;
}

/** Human phrase for how long an entry has left. */
export function describeTimeLeft(entry: VaultEntry, now: number): string {
	if (entry.expiresAt === null) return "never expires";
	return describeMsLeft(entry.expiresAt - now);
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
	throw new Error("Could not invent an unused secret name. Remove some entries with /secret rm NAME.");
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

/**
 * What veyyon writes into a project's `.veyyon/` so the vault cannot be committed.
 *
 * ONLY the vault, never the directory. A project `.veyyon/` also holds things a repo is SUPPOSED to
 * track (skills, project settings), so `.veyyon/` or `*` here would quietly stop those being
 * committed and look like git losing files. The `.unreadable-*` sibling is what `/secret discard`
 * renames a broken vault to, and it still holds the sealed entries.
 */
const PROJECT_VAULT_GITIGNORE = `# Written by veyyon, and safe to keep.
#
# A vault is an encrypted credential store. Its key never leaves this machine, so committing one
# publishes a credential store that nobody who clones the repo can open, including you on another
# machine. Only the vault is ignored: everything else in this directory is yours to track.
${VAULT_FILENAME}
${VAULT_FILENAME}.unreadable-*
`;

/**
 * Keep a project vault out of the user's version control, on the way to creating one.
 *
 * WHY THIS EXISTS. `project` is the one scope whose file lands inside the repository the operator is
 * working in, and nothing stopped it being committed: a real `.veyyon/vault.json` was found untracked
 * in this repo, one `git add -A` away from being published. It is ciphertext rather than plaintext, so
 * the immediate harm is bounded, but a committed vault is a credential store in the history that no
 * clone can decrypt, which then breaks `/secret` for whoever cloned it.
 *
 * An existing file is APPENDED to, never rewritten, and only when it does not already ignore the
 * vault. That case is the upgrade path and it is the one that matters: a vault created before this
 * shipped, in a directory that has since acquired a `.gitignore` for some other reason, is left
 * committable by a create-only guard, and the operator is never told. Appending is defensible here in
 * a way that editing their root `.gitignore` would not be, because `.veyyon/` is veyyon's own
 * directory. Their existing lines are untouched. A failure is reported rather than swallowed: the
 * vault write that follows will usually fail too, and a protection that quietly did not happen is
 * worse than one that says so.
 */
async function ensureProjectVaultIgnored(scope: VaultScope, directory: string): Promise<void> {
	if (scope !== "project") return;
	const ignorePath = path.join(directory, ".gitignore");
	try {
		// `wx` creates or fails, so the common path needs no check-then-write race.
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
		// Deliberately literal. A broader pattern that already covers the vault (`*`) makes this append
		// one redundant line, once, and the line is then found on every later call. Guessing at pattern
		// semantics to avoid that would risk the opposite mistake, which is the one that costs a leak.
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
	// DELIBERATELY NOT ctimeMs. A rename bumps the inode's ctime, and this file renames the live
	// vault to a quarantine path and renames it BACK when its own identity check fails. An
	// aborted-and-restored cleanup therefore leaves the vault byte-identical with dev, ino, size,
	// mtimeMs, nlink, mode and uid all unchanged and ctimeMs moved TWICE, and comparing it reported
	// "the vault changed" for a file whose bytes never moved. Same defect, and same removal, as the
	// key snapshot in `vault-crypto.ts`.
	//
	// `nlink` STAYS, and the difference from that file is the point: there, a peer legitimately
	// reaps a recovery link mid-read, so the count moves under an innocent caller. Nothing moves
	// this file's link count under a live read, so it carries no false positive and is a defence
	// with nothing to trade away. Dropping a check needs a false positive behind it.
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
		nlink: stat.nlink,
		mode: stat.mode,
		uid: stat.uid,
		contentHash,
	};
}

/**
 * Metadata identity only: is the file at this path still the same file, unchanged.
 *
 * Callers that hold no bytes. Five of the seven reach here before the vault has been read at all,
 * so `contentHash` on the incoming snapshot is `""` and there is nothing to verify content
 * against. The AEAD envelope is the integrity witness on those paths: an attacker without the key
 * cannot produce a vault that opens, so metadata identity is asked to catch a SWAPPED INODE, not a
 * forged payload. See {@link sameDisplacedSnapshot} for the case that does hold a path.
 */
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

/**
 * Identity AND content, for the one caller that holds a path to read.
 *
 * Compares the same metadata set as {@link sameSnapshot} and then verifies sha256, which is why the
 * two must be kept in step: they answered different metadata questions once, `ctimeMs` in one and
 * not the other, and that drift is what produced the false "the vault changed" report. The only
 * legitimate difference is the content witness, permitted here because a path is in hand. The
 * `contentHash.length === 0` guard refuses rather than skipping, so a snapshot taken before any
 * read can never silently pass a content check it never had the data for.
 */
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
		try {
			directoryHandle = await fs.open(
				directory,
				fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | fsConstants.O_NOFOLLOW,
			);
		} catch (error) {
			// The `lstat` above describes its own failures; this open had no catch at all, so a
			// directory that stats and will not open escaped as the bare `EACCES: permission denied,
			// open '<dir>'`. That string is quoted verbatim into an operator notice by
			// `noteFailedVaultLoad`, where it named no scope, no vault and no secret: an operator whose
			// profile directory carried the wrong mode was handed a path and left to guess the subject.
			// It was also the one path in this file that reached a terminal without `safeText`.
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
			// Same uncaught shape as the open above, on the call that resolves the physical identity.
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

/**
 * The gate immediately before the vault is overwritten: is the file still the one we read.
 *
 * VERIFIES CONTENT WHEN IT CAN. Five of the seven callers reach here before the vault has been
 * read, so their snapshot carries `contentHash: ""` and metadata identity is all there is to check.
 * The two write-path callers build `expected` from bytes they already hold, and that hash used to be
 * DEAD DATA: `sameSnapshot` compares metadata only, so the field was carried to precisely the gate
 * that needed it and then ignored. Metadata alone cannot tell a substituted target from the original
 * here, because `mtimeMs` and `size` are settable by anyone who can write the file, so this gate was
 * WEAKER THAN INTENDED at the one moment it guards: the instant before a replace.
 *
 * NOT AN AUTHENTICATION QUESTION. An attacker cannot produce a vault that opens, because the
 * envelope is AES-GCM with the scope and canonical path as associated data. The risk this closes is
 * the write path clobbering or rolling back entries that changed underneath the transaction, which
 * is lost data rather than leaked data. The read path is a different question and the tag answers it.
 *
 * The `contentHash.length === 0` guard is the same one {@link sameDisplacedSnapshot} uses, so a
 * pre-read snapshot skips a check it never had the bytes for instead of failing one it cannot pass.
 */
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
	// Bounded before the read, not after. `sameSnapshot` already proved the sizes match, so this can
	// only trip on a snapshot taken above the cap, but the read stays guarded on its own terms rather
	// than on another check's invariant.
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

/**
 * Refuse a value the vault cannot store, or that the obfuscator could not protect.
 *
 * ONE OWNER for the rule, because more than one path writes this field: `add` stores a new
 * credential and `replaceValue` corrects one. A limit enforced on the first and not the second is a
 * value that is refused when it is stored and accepted when it is edited, and the second write is
 * the one nobody tests by hand.
 *
 * The obfuscation floor is the load-bearing one: accepting a value under it produces an entry that
 * looks stored and is sent to the provider verbatim, for the reason spelled out in `policy.ts`.
 */
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

/**
 * How many vault paths to track identities for before evicting the oldest.
 *
 * One entry per distinct vault path this process has looked at, so three per working directory.
 * Eviction can only make a state this process wrote look externally changed again, which costs
 * one refresh; it can never make an external change look self-inflicted.
 */
const MAX_TRACKED_VAULT_PATHS = 64;

interface VaultIdentityRecord {
	/** The exact {@link revisionStat} this process last observed or wrote at the path. */
	observed: string;
	/** What {@link vaultRevision} reports for that state. Advances only on external change. */
	identity: string;
}

/**
 * Per-path identity of each vault file, as seen by THIS process.
 *
 * Keyed by comparable path rather than by stat, so a file that disappears is still known to be
 * a path we had written: "created from nothing" and "externally deleted" both stat as `absent`,
 * and only the path record can tell them apart.
 */
const vaultIdentities = new Map<string, VaultIdentityRecord>();

/**
 * Source of never-reused identity tokens.
 *
 * Monotonic rather than derived from the state, because a derived identity can repeat: an
 * external actor who deletes a vault returns it to the one state that carries no distinguishing
 * metadata. A strictly increasing counter cannot collide with any identity already handed out,
 * so a deletion is always a change even when it restores an earlier-looking state.
 */
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

/**
 * The identity of a vault file, held stable across changes THIS process made.
 *
 * Answers "has anybody else touched this file", which is the only question
 * {@link SecretVault.revision} exists to ask. Observing is what advances the identity: a state
 * that differs from the last one this process saw or wrote is, by elimination, somebody else's
 * work, and earns a fresh token that can never equal a previous one.
 */
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

/**
 * Re-anchor a path to the state this process just published, keeping its identity.
 *
 * This is what stops a session invalidating itself. Publishing genuinely changes the file, but
 * it is not an external change, and a session that treated its own `/secret add` as tampering
 * could never spend the secret it had just stored. Call while the scope lock is held, so the
 * state being recorded is still the one that was written.
 *
 * Both the lexical and the canonical path are re-anchored because {@link vaultRevision} hashes
 * the file under both names, and leaving either behind would reintroduce the self-invalidation
 * through the alias.
 */
function recordSelfWrittenVault(pathname: string): void {
	const written = revisionStat(pathname);
	const keys = [comparableVaultPath(pathname)];
	try {
		const canonical = canonicalVaultPathSync(pathname);
		if (canonical !== keys[0]) keys.push(canonical);
	} catch {
		// An unresolvable path is hashed as `canonical-error`, which carries no identity to keep.
	}
	for (const key of keys) {
		const record = vaultIdentities.get(key);
		// No record means nothing has ever observed this path, so there is no captured revision
		// this write could invalidate. The first observation mints an identity for the new state.
		if (record === undefined) continue;
		rememberVaultIdentity(key, { observed: written, identity: record.identity });
	}
}

/**
 * The unreadable state each vault path was last reported for, keyed by comparable path.
 *
 * A notice fires once per DISTINCT broken state rather than once per read. {@link load} runs on
 * every runtime refresh, so an unconditional notice would repeat the same warning several times a
 * minute and train the operator to ignore the one message that tells them how to recover.
 *
 * An entry is REMOVED the moment the path reads successfully, and that removal is what makes the
 * dedupe safe rather than merely quiet. Comparing against the last state we REPORTED is not enough
 * on its own: break a vault, repair it, break it the same way again, and the remembered state still
 * matches, so the second break would be silenced by a memory of the first. Nothing about the stat
 * rules that out either, since a rewrite can land on the same inode with the same size inside one
 * timestamp tick. Forgetting on success removes the whole collision class instead of betting on
 * timestamp granularity, because a warning that shows once per process and then never again is how
 * a broken vault ships unnoticed.
 */
const reportedUnreadableVaults = new Map<string, string>();

/**
 * Report a vault scope that exists but could not be read, once per distinct broken state.
 *
 * A vault whose bytes are present but do not parse used to be FATAL: the throw escaped `load()`,
 * escaped the secret-runtime build, and took the process down before the TUI drew a frame. That is
 * the worst available outcome, because the repair for a broken vault lives inside the product the
 * error prevents from starting. The operator was locked out at exactly the moment they needed
 * `/secret` most, with no reachable path to the fix.
 *
 * Degrading here does not weaken masking, and the reason is stronger than "redaction is
 * independent of the vault". In `loadSecretRuntime`, the `secrets.yml` entries and the env-keyword
 * entries are both collected BEFORE the vault is constructed, so the old throw did not merely fail
 * to load vault secrets: it discarded redaction that had ALREADY been built and would have worked.
 * Degrading strictly INCREASES masking coverage in the corrupt case, from none because the session
 * is dead, to env plus `secrets.yml` live. What is lost is expansion of that scope's placeholders,
 * which is refused at the spend seam rather than passed through.
 *
 * The message never includes bytes from the file. It is a credential store, and a parser's
 * complaint about unexpected input is a natural place for a fragment of ciphertext, or of
 * plaintext, to reach a transcript. The underlying reason goes LAST: parser messages end in their
 * own punctuation, and continuing the sentence after one produced a doubled period on screen.
 */
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

/**
 * Report a vault that could not be loaded at all, and say how to repair it from where you are.
 *
 * SEPARATE FROM {@link noteUnreadableVault} because the two conditions differ in what still works.
 * That one skips ONE scope and keeps the rest, so it can promise the other scopes loaded normally.
 * This one is the whole vault: nothing stored is available, every placeholder is refused, and the
 * only thing still masking is what came from the environment and `secrets.yml`. Promising more than
 * that would be wrong, and saying less would leave the operator thinking their secrets are still
 * covering the session.
 *
 * It names the scopes that actually have a file, so the repair it prints is one the operator can run.
 * The refusal that produced this used to be fatal, which meant the message recommending
 * `/secret discard` was printed by a surface that then exited before the command could be typed.
 */
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

/**
 * Forget any unreadable-vault complaint recorded for a path, because it just read cleanly.
 *
 * Called for a vault that is absent as well as one that parsed, since absent is not unreadable: a
 * vault repaired by deleting it and later recreated broken must warn again.
 */
function forgetUnreadableVault(vaultPath: string): void {
	reportedUnreadableVaults.delete(comparableVaultPath(vaultPath));
}

/**
 * Fingerprint of every configured vault FILE, excluding changes this process made.
 *
 * Deliberately does NOT stat the containing directories. It used to, and that made the feature
 * unusable: the three scope directories are `~/.veyyon`, the profile agent directory, and
 * `<cwd>/.veyyon`, the busiest state directories in the product. A directory's mtime and ctime
 * move whenever ANY entry is created or removed in it, so a SQLite `-wal` file, a session file,
 * a cache entry, or the vault's own `<vault>.lock` sibling all changed this fingerprint while
 * the vault itself sat untouched. Every secret expansion was then refused as though another
 * process had tampered with the vault.
 *
 * Nothing is lost by dropping it. A vault appearing, disappearing, or being replaced by
 * `replaceWithRollback` all land on the FILE, and {@link revisionStat} reports "absent" for a
 * missing path and pins dev, inode, and ctime for a present one. Swapping the directory moves
 * the file with it, which the file's own stat sees. The directory stat only ever added the
 * dirents of unrelated software.
 */
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
	/** Scopes skipped by the most recent {@link load} because their file could not be read. */
	#unreadableScopes: ReadonlySet<VaultScope> = new Set();

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
		const byName = new Map<string, ScopedVaultEntry>();
		for (const entry of await this.#loadEveryScope()) {
			// Map.set updates a value in place. Delete first so an override is ordered
			// with the narrower scope that owns the winning value.
			byName.delete(entry.name);
			byName.set(entry.name, entry);
		}
		return [...byName.values()];
	}

	/**
	 * Every live entry in every scope, INCLUDING a name that a narrower scope shadows.
	 *
	 * {@link load} collapses a repeated name to the narrowest holder, which is right for spending:
	 * one placeholder resolves to one value. It is wrong for any question ABOUT the scopes, and
	 * planning a move between them is exactly that. Asked through `load`, "does the destination
	 * already hold this name" is unanswerable, because the entry that would collide is the one
	 * `load` dropped. The planner would then see no conflict, the move would overwrite a live
	 * credential and delete the one being moved, and both would be gone.
	 */
	async loadEverywhere(): Promise<ScopedVaultEntry[]> {
		return await this.#loadEveryScope();
	}

	/**
	 * Walk every scope widest first, pruning expired entries and recording unreadable files.
	 *
	 * Shared by the collapsed and uncollapsed reads so the pruning and the unreadable bookkeeping
	 * happen once per read and cannot drift apart between the two.
	 */
	async #loadEveryScope(): Promise<ScopedVaultEntry[]> {
		const now = this.#now();
		const all: ScopedVaultEntry[] = [];
		const unreadable = new Set<VaultScope>();
		for (const scope of VAULT_SCOPES) {
			const vaultPath = vaultPathFor(this.#locations, scope);
			const pin = await pinVaultScope(scope, vaultPath);
			if (pin === null) {
				// Absent is not unreadable, and the distinction matters for the notice: a vault
				// repaired by DELETING it and later recreated broken has to warn again.
				forgetUnreadableVault(vaultPath);
				continue;
			}
			try {
				// One physical file cannot carry two semantic scope bindings, so the widest
				// configured owner reads it exactly once.
				if ((await this.#scopePathOwner(scope, pin)) !== scope) continue;
				for (const entry of await this.#loadScope(scope, pin, now)) all.push({ ...entry, scope });
				// This path read cleanly, so any earlier complaint about it is spent. Clearing on
				// success, rather than trusting the last state we reported, is what lets a
				// break/repair/break sequence in one session raise the notice both times.
				forgetUnreadableVault(vaultPath);
			} catch (error) {
				// NARROW BY DESIGN. Only a payload that already cleared every provenance and integrity
				// check may be skipped; see UnparseableVaultPayloadError for why catching anything
				// wider turned each of this file's security refusals into "that scope has no secrets"
				// and, through the obfuscator, into a silent disclosure path. Everything else rethrows
				// and still refuses to start.
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

	/**
	 * Scopes whose vault file existed but could not be read during the most recent {@link load}.
	 *
	 * Empty until the first load, and empty in the ordinary case of a vault that is simply absent.
	 * The spend seam consults this to tell "you have no secret by that name" apart from "the file
	 * holding your secret is broken", so a placeholder that cannot be resolved is refused with the
	 * repair rather than handed to a command as the literal text `#NAME#`.
	 */
	unreadableScopes(): readonly VaultScope[] {
		return [...this.#unreadableScopes];
	}

	/**
	 * Record that a whole {@link load} failed, so the session can start without the vault.
	 *
	 * WHY THIS IS NOT A WIDER CATCH IN `load()`. The narrow catch there is correct and must stay:
	 * skipping a scope that failed a provenance or integrity check turns each of this file's security
	 * refusals into "that scope has no secrets", and an attacker who tampers with a vault gets its
	 * entries silently dropped from the obfuscator. So `load()` still refuses, and the failure is
	 * absorbed one level up, where the answer is different: the ENTIRE vault is unavailable, and no
	 * caller can mistake that for a vault that is merely empty.
	 *
	 * The distinction is the whole point, and it is why this marks scopes UNREADABLE rather than
	 * returning nothing. An unreadable scope makes the spend seam refuse every placeholder it owns,
	 * with the repair; a scope believed empty makes `#NAME#` resolve to nothing and pass through. The
	 * failure aborts `load()`'s loop, so scopes that had already read cleanly are discarded too and
	 * must be marked alongside the one that threw: their entries are equally absent from the
	 * obfuscator, and leaving them unmarked is exactly the silent hole this avoids.
	 *
	 * Only scopes with a file present are named, so every `/secret discard X` the operator is
	 * told to run has a file to move aside. A scope with no vault would refuse that command.
	 */
	async noteFailedLoad(error: unknown): Promise<readonly VaultScope[]> {
		const unreadable = new Set<VaultScope>();
		for (const scope of VAULT_SCOPES) {
			try {
				// `lstat`, not a pin: this runs when the vault is already known to be broken, and the
				// question is only "is there a file here to move aside".
				await fs.lstat(vaultPathFor(this.#locations, scope));
				unreadable.add(scope);
			} catch {
				// Absent, so there is nothing to refuse and nothing to repair for this scope.
			}
		}
		this.#unreadableScopes = unreadable;
		noteFailedVaultLoad(this.#locations, [...unreadable], error);
		return [...unreadable];
	}

	/**
	 * Move an unreadable scope's vault file aside so that scope can be used again.
	 *
	 * The in-product repair for a vault that exists and cannot be read. `load()` degrades past such
	 * a file and `remove()` deliberately refuses to touch it, which leaves the operator able to
	 * start and unable to fix, so this is the one operation that resolves it from inside veyyon.
	 *
	 * MOVES rather than deletes. The file still holds real credentials, sealed with a key that is
	 * still on disk, so the damage may be a truncated tail with recoverable entries behind it.
	 * Destroying it to make the product usable again is a trade the operator has not agreed to, and
	 * a rename costs nothing. The new path is returned so it can be reported.
	 *
	 * Refuses a scope that reads normally, checked HERE under the lock rather than trusting an
	 * earlier {@link load}: the file may have been repaired in between, and `remove()` can name what
	 * it removed while this cannot. It is not a second delete path.
	 */
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
						// The whole precondition: it threw, so it is genuinely unreadable. The reason is
						// not inspected, because every reason lands the operator in the same place.
						readable = false;
						const ioPath = pinnedVaultPath(pin, vaultPath);
						for (let attempt = 0; attempt < 8; attempt++) {
							// ONE suffix, used twice on purpose. The rename goes through the pinned
							// descriptor path, because that is what guarantees the directory is still the
							// one this scope was verified against. The REPORTED path must be the real one:
							// the pinned form is `/proc/self/fd/<n>/...`, which names a descriptor this
							// process is about to close, so reporting it handed the operator a path that
							// does not exist for anyone else and stops existing here too. That string is
							// the only route back to credentials the file may still hold.
							const suffix = `.unreadable-${this.#now()}-${randomUUID().slice(0, 8)}`;
							if (!moveNoReplace(ioPath, `${ioPath}${suffix}`)) continue;
							await verifyVaultScopePin(scope, pin);
							// This process made the path absent, so the revision fingerprint must not read it
							// as somebody else tampering and start refusing expansions.
							recordSelfWrittenVault(vaultPath);
							// A later break at this path has to warn again.
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

	/** Live entries in one pinned scope, pruning any that have expired. */
	async #loadScope(scope: VaultScope, pin: VaultScopePin, now: number): Promise<VaultEntry[]> {
		const read = await this.#readScopeRaw(scope, pin);
		if (read === null) return [];
		const all = read.entries;
		const live = all.filter(entry => !isExpired(entry, now));
		if (live.length === all.length) return live;

		// Re-read inside the lock so a concurrent add is not pruned with the expired entries.
		//
		// Deliberately NOT wrapped in a catch. An earlier version swallowed a failure here and
		// returned the pre-lock `live` list, reasoning that a prune is only cleanup and a read-only
		// filesystem should not cost the operator their working credentials. That reasoning ignored
		// what else this call performs: it re-verifies the scope pin, so it is one of the places a
		// vault swapped underneath us is caught. Swallowing it converted that TOCTOU refusal into a
		// successful read of values taken before the swap.
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
					`scope or path. Refusing to guess its provenance. Re-add its credentials into the intended scope.`,
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
		// Before anything is sealed into it. A project vault lives in the user's OWN repository, so
		// without this the first project-vault store leaves an encrypted credential store
		// sitting untracked where `git add -A` sweeps it up. Observed in this repo. Runs on an
		// existing directory too, since a vault created before this shipped is the case that needs it.
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
		// Observe the pre-write state so this path has an identity to carry across the write. Any
		// external change that landed since the last look is caught HERE, before publishing, so
		// re-anchoring below preserves a fresh external identity rather than hiding one.
		externalVaultIdentity(vaultPath);
		await writeVaultAtomically(scope, vaultPath, pin, expected, text);
		recordSelfWrittenVault(vaultPath);
	}

	/**
	 * Store a secret, replacing any entry of the same name in the same scope.
	 *
	 * Reports whether it replaced one, because the caller has to be able to say so. Rotating a
	 * credential and destroying one by mistyping its name are the same write, and the only thing
	 * that distinguishes them for the operator is being told which happened.
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
	}): Promise<AddedVaultEntry> {
		const scope = options.scope ?? "profile";
		assertStorableValue(options.value);

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
				// Decided inside the lock against the same `existing` the write is built from, so it
				// cannot disagree with what `replaceVaultEntry` actually did.
				const replaced = existing.some(entry => entry.name === name);
				return { entries: replaceVaultEntry(existing, created), result: { ...created, replaced } };
			},
			true,
		);
		return { ...entry, scope };
	}

	/**
	 * Remove one entry by name. Returns the scope it was removed from, or `null`.
	 *
	 * `scope` restricts the search to a single vault instead of walking narrowest first. A move
	 * between scopes needs that: it writes the credential to the destination and then deletes the
	 * source, and an unrestricted delete would find whichever copy is narrower. When the
	 * destination is the narrower one that is the copy just written, so the move would report
	 * success having deleted the new entry and left the old one in place.
	 */
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

	/**
	 * Empty one scope's vault, returning the names it removed.
	 *
	 * WHY THIS EXISTS AS A VAULT OPERATION rather than as `list` piped into `remove`. A loop over
	 * `remove` takes and releases the scope lock once per entry, so a credential stored between two
	 * iterations survives a command the operator was told emptied the vault, and a failure halfway
	 * leaves a vault neither full nor empty with nothing saying which entries went. One locked
	 * transaction cannot report a partial result as success.
	 *
	 * NAMES, NOT A COUNT. The names are already the safe half of an entry -- `list` prints them and
	 * the placeholder is built from them -- and a count alone cannot tell an operator whether the
	 * credential they were worried about was in the scope they emptied.
	 *
	 * EXPIRED ENTRIES ARE REMOVED AND NOT REPORTED. They cannot expand, so naming them would pad
	 * the report with credentials the session had already stopped honouring; the write still drops
	 * them, because leaving them behind is what makes a cleared vault non-empty on disk.
	 */
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

	/**
	 * Replace a live entry's VALUE, keeping its name, its scope, its creation time and its expiry.
	 *
	 * THE GAP THIS CLOSES. A credential pasted with a character missing, or rotated at the provider,
	 * could only be revoked and stored again. That loses the name, which is the handle every prompt
	 * in the session already spends, and it re-dates the entry, so a secret with two days left comes
	 * back with the default lifetime. Correcting a value is the most ordinary thing an operator wants
	 * from a vault and it was the one write with no path to it.
	 *
	 * NOT `add`. `add` overwrites a same-name entry, which is how a credential is rotated from the
	 * command line, and it restarts the lifetime from now and needs the scope named. Both are wrong
	 * for a correction: the entry keeps the window it was given, and the scope is wherever it already
	 * lives.
	 *
	 * Walks narrowest first and edits the first holder, exactly as `extend` and `rename` do, so the
	 * entry that is edited is the one a placeholder would have spent.
	 */
	async replaceValue(name: string, value: string): Promise<ScopedVaultEntry | null> {
		// Both the name and the value are validated BEFORE the lock, so a refusal costs no contention
		// and, more importantly, cannot leave a scope locked while it is being explained.
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
				// Only the value. Spreading the target rather than rebuilding the entry is what keeps
				// `createdAt` and `expiresAt` out of this write: an edit that re-dated the entry would
				// be `add` under another name.
				const next: VaultEntry = { ...target, value };
				return { entries: replaceVaultEntry(live, next), result: next };
			});
			if (updated !== null) return { ...updated, scope };
		}
		return null;
	}

	/**
	 * Rename an entry in place, keeping its value, creation time and expiry.
	 *
	 * REFUSES a target name that is already taken rather than overwriting it. `add` deliberately
	 * overwrites, because storing a new value under an existing name is how a credential is
	 * rotated, and it reports the replacement so the operator can tell a rotation from a typo. A
	 * rename has no such legitimate reading: it carries no new value, so landing on an occupied
	 * name could only destroy the credential already there in exchange for nothing. Removing the
	 * occupant first is the only way to mean it.
	 *
	 * The lifetime is carried across untouched rather than restarted from now, so relabelling a
	 * secret cannot quietly lengthen or shorten how long it lives.
	 */
	async rename(from: string, to: string): Promise<{ scope: VaultScope; name: string } | null> {
		// Both names are validated BEFORE the lock, so a bad name fails fast without contending.
		const wanted = normaliseSecretName(from);
		const renamed = normaliseSecretName(to);
		const now = this.#now();
		for (const scope of VAULT_SCOPES_NARROWEST_FIRST) {
			const found = await this.#withScopeLocked<boolean>(scope, (current, exists) => {
				const live = current.filter(entry => !isExpired(entry, now));
				const target = live.find(entry => entry.name === wanted);
				// Nothing to rename here, so the only reason to write is a prune that dropped something.
				const pruneOnly = {
					entries: live,
					result: false,
					write: exists && live.length !== current.length,
				};
				if (target === undefined) return pruneOnly;
				// Renaming a secret to the name it already has is an answer, not a write.
				if (renamed === wanted) return { ...pruneOnly, result: true };
				if (live.some(entry => entry.name === renamed)) {
					throw new Error(
						`The ${scope} vault already has a secret named ${renamed}. Renaming ${wanted} onto it would ` +
							`destroy that credential. Remove ${renamed} first if that is what you want.`,
					);
				}
				const next: VaultEntry = { ...target, name: renamed };
				// Rename every copy of the old name, then collapse them the way any other in-place
				// replacement does: the entry keeps its position and malformed duplicates do not survive.
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
