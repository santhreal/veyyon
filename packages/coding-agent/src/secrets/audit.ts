/**
 * An append-only record of which credential was spent where.
 *
 * WHAT THIS IS FOR. Obfuscation is a preventive control: the value never reaches the provider.
 * This is the detective half, and it answers a question the preventive half cannot: after the
 * fact, which of your credentials did this agent actually use, and in what command? For
 * bug-bounty and VDP work that is the difference between "the vault is careful" and "I can
 * show you exactly what that token touched". Expansion funnels through ONE call site
 * (`transformToolCallArguments` in `sdk.ts`), so recording it costs one line per tool call that
 * mentions a secret, and nothing at all for every call that does not.
 *
 * A VALUE CANNOT END UP IN HERE, BY CONSTRUCTION RATHER THAN BY CARE. The recorded command is
 * the arguments as they were BEFORE expansion, which is the form in which every secret is still
 * a placeholder. There is no redaction step to get wrong, no allow-list of fields to keep in
 * sync, and no ordering hazard where a later edit moves the write to after the substitution: the
 * pre-expansion arguments are value-free because the whole point of the obfuscator is that they
 * are what the model produced. {@link buildExpansionRecord} takes the pre-expansion arguments
 * and has no access to anything else.
 *
 * ONE LINE IS ONE BOUNDED APPEND. {@link MAX_RECORD_BYTES} is not a tidiness cap: every
 * provider process sharing a profile must be able to append a complete record rather than an
 * unbounded fragment. The append and the size-check/rotation transaction run under the
 * repository's cross-process file lock, so rotation cannot race another process's write. A
 * record too long to fit keeps bounded evidence and reports how many placeholders were omitted.
 *
 * IT DOES NOT GROW FOREVER. The log rotates at {@link ROTATE_AT_BYTES}, keeping one previous
 * generation, and reads span both. An append-only file with no ceiling is a slow leak that also
 * makes `/secret log` slower every day it is left running.
 *
 * WHY A FAILED WRITE DOES NOT STOP THE COMMAND. Refusing to run a tool because a log file could
 * not be appended turns a full disk into an agent outage, and the preventive control is still
 * working, so nothing is unsafe. Silence is what is banned (Law 10), not carrying on: a failed
 * append raises an operator notice, which is a channel the operator actually sees, so a log that
 * has stopped recording cannot look like a log with nothing to record.
 */
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { clamp, isEnoent, isRecord, withFileLock } from "@veyyon/utils";
import type { OperatorNotices } from "../session/operator-notices";
import { PLACEHOLDER_RE } from "./placeholder";
import type { VaultLocations } from "./vault";

/** Filename of the log, inside the active profile's directory. */
export const SECRET_AUDIT_FILENAME = "secret-audit.jsonl";

/**
 * Longest complete JSONL record the log will emit, including the newline.
 *
 * The cross-process lock prevents interleaving; this separate cap prevents a single pathological
 * expansion from turning the append-only evidence stream into an unbounded line.
 */
export const MAX_RECORD_BYTES = 2048;

/** How much of the command is kept, leaving room for the record's other fields. */
const MAX_COMMAND_CHARS = 1200;

/** Most placeholder names retained verbatim when a record has an adversarially large list. */
const MAX_RECORDED_SECRETS = 16;

/** A real placeholder is at most 66 bytes; reject typed-but-invalid giant entries as evidence. */
const MAX_SECRET_JSON_BYTES = 128;

/** Bounded tool/session evidence retained when the complete record cannot fit. */
const MAX_METADATA_JSON_BYTES = 256;

/** Preflight bound that prevents serialising an arbitrarily large direct-call string. */
const MAX_FIELD_CHARS = MAX_RECORD_BYTES;

/**
 * Size at which the log is rotated, keeping one previous generation.
 *
 * An append-only file with no ceiling is a slow leak, and this one has a second cost: `read`
 * parses the whole file to show the last twenty lines, so an unbounded log makes `/secret log`
 * get slower for the lifetime of a profile (Law 7). Two megabytes is roughly ten thousand
 * expansions, which is far more history than the question "which credential did this agent use"
 * ever needs, and small enough that parsing it is imperceptible.
 *
 * ROTATION, NOT TRUNCATION. Deleting the oldest history to make room for the newest would throw
 * away exactly the records an incident asks about. The previous generation is kept as
 * `secret-audit.jsonl.1` and {@link SecretAuditLog.read} reads through it, so a `--limit 20`
 * issued just after a rotation still answers with twenty records rather than with however few
 * happen to have landed since.
 */
export const ROTATE_AT_BYTES = 2 * 1024 * 1024;

/** Suffix of the kept previous generation. */
export const ROTATED_SUFFIX = ".1";

/** One expansion, as it appears on one line of the log. */
export interface SecretExpansionRecord {
	/** Epoch milliseconds at expansion. */
	at: number;
	/** Placeholders that were substituted, for example `#GITHUB_TOKEN#`. Never values. */
	secrets: string[];
	/** Number of additional placeholders not listed so the record remains bounded. */
	omittedSecrets?: number;
	/** Tool that received them. */
	tool: string;
	/**
	 * Session the expansion happened in, so a log shared by a profile can be split by session.
	 *
	 * Optional because a session id is optional: a session that has not been persisted has none
	 * yet, and dropping the whole record over a missing label would lose the part that matters.
	 */
	session?: string;
	/** The command as the model wrote it, with every retained secret still a placeholder. */
	command: string;
	/** True when any evidence in this record was cut to fit {@link MAX_RECORD_BYTES}. */
	truncated?: true;
}

/** Absolute path of the log for a set of vault locations. */
export function secretAuditPath(locations: VaultLocations): string {
	// PROFILE, never project: a project directory is a git worktree, and a log of which
	// credentials an agent used is not something to invite into a commit.
	return path.join(locations.profileDir, SECRET_AUDIT_FILENAME);
}

/**
 * Placeholders present in a value, in the order they appear, without duplicates.
 *
 * Reads the pre-expansion arguments, so what it finds is what the substitution is about to
 * replace. A placeholder that is not one of ours is left in the list only if the caller's
 * `known` predicate accepts it, so a literal `#HELLO#` an operator typed is not recorded as a
 * spent credential.
 */
export function placeholdersIn(value: unknown, known: (placeholder: string) => boolean): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const walk = (node: unknown): void => {
		if (typeof node === "string") {
			// The OWNER's regex, not a copy of its source. This line used to build
			// `new RegExp(PLACEHOLDER_RE.source, "g")` on every string node it walked, which put a
			// regex construction on the hottest path the secrets code has: every string of every
			// tool call's arguments, recursively (Law 7). The copy was also a second definition of
			// one shape. `PLACEHOLDER_RE` is already global, and `String.prototype.match` with a
			// global pattern resets `lastIndex` before it scans, so sharing the object carries none
			// of the sticky-state hazard that usually makes a shared global regex a bug.
			for (const match of node.match(PLACEHOLDER_RE) ?? []) {
				if (seen.has(match) || !known(match)) continue;
				seen.add(match);
				found.push(match);
			}
			return;
		}
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (node !== null && typeof node === "object") {
			for (const item of Object.values(node)) walk(item);
		}
	};
	walk(value);
	return found;
}

/**
 * Build the record for one tool call, or `null` when no secret was involved.
 *
 * Pure, so the shape of what gets written is tested without a filesystem, and separate from the
 * writing so the "no secret, no record" decision is one readable line rather than a condition
 * buried in an I/O path.
 */
export function buildExpansionRecord(options: {
	/** Arguments BEFORE expansion. The placeholder-bearing form. */
	args: Record<string, unknown>;
	tool: string;
	session: string | undefined;
	at: number;
	known: (placeholder: string) => boolean;
}): SecretExpansionRecord | null {
	const secrets = placeholdersIn(options.args, options.known);
	if (secrets.length === 0) return null;

	const serialised = safeStringify(options.args);
	const truncated = serialised.length > MAX_COMMAND_CHARS;
	const record: SecretExpansionRecord = {
		at: options.at,
		secrets,
		tool: options.tool,
		command: truncated ? `${serialised.slice(0, MAX_COMMAND_CHARS)}…` : serialised,
	};
	if (options.session !== undefined) record.session = options.session;
	if (truncated) record.truncated = true;
	return record;
}

/** Stringify arguments for the log, surviving a value that JSON cannot represent. */
function safeStringify(args: Record<string, unknown>): string {
	try {
		return JSON.stringify(args) ?? "";
	} catch {
		// A circular or otherwise unserialisable argument object is not a reason to lose the
		// record: the placeholders are already known, and the command text is context.
		return "[arguments could not be serialised]";
	}
}

/** Serialise one record to the exact bytes appended, newline included. */
export function encodeRecord(record: SecretExpansionRecord): string {
	assertEncodableRecord(record);

	const originalOmitted = record.omittedSecrets ?? 0;
	const secrets: string[] = [];
	const inspectedSecrets = Math.min(record.secrets.length, MAX_RECORDED_SECRETS);
	for (let index = 0; index < inspectedSecrets; index++) {
		const secret = record.secrets[index];
		if (
			secret.length <= MAX_SECRET_JSON_BYTES &&
			Buffer.byteLength(JSON.stringify(secret)) <= MAX_SECRET_JSON_BYTES
		) {
			secrets.push(secret);
		}
	}
	let omittedSecrets = originalOmitted + record.secrets.length - secrets.length;
	if (!Number.isSafeInteger(omittedSecrets)) {
		throw new Error("The secret audit record omitted-placeholder count exceeds the safe integer range.");
	}

	const tool = boundedPrefix(record.tool, MAX_FIELD_CHARS);
	const session = record.session === undefined ? undefined : boundedPrefix(record.session, MAX_FIELD_CHARS);
	const command = boundedPrefix(record.command, MAX_FIELD_CHARS);
	const evidenceWasTrimmed =
		omittedSecrets !== originalOmitted ||
		tool !== record.tool ||
		session !== record.session ||
		command !== record.command;

	const encoded: SecretExpansionRecord = {
		at: record.at,
		secrets,
		tool,
		command,
	};
	if (session !== undefined) encoded.session = session;
	if (record.truncated === true || evidenceWasTrimmed || omittedSecrets > 0) encoded.truncated = true;
	if (omittedSecrets > 0) encoded.omittedSecrets = omittedSecrets;

	let line = serialiseRecord(encoded);
	if (Buffer.byteLength(line) <= MAX_RECORD_BYTES) return line;

	// Placeholder names are the primary evidence. Keep a bounded ordered prefix plus the exact
	// omitted count, then spend whatever remains on command context. Tool and session labels are
	// bounded separately so hostile direct callers cannot crowd both kinds of evidence out.
	encoded.truncated = true;
	encoded.tool = capJsonString(encoded.tool, MAX_METADATA_JSON_BYTES);
	if (encoded.session !== undefined) {
		encoded.session = capJsonString(encoded.session, MAX_METADATA_JSON_BYTES);
	}
	const fullCommand = encoded.command;
	encoded.command = "";

	while (Buffer.byteLength(serialiseRecord(encoded)) > MAX_RECORD_BYTES && encoded.secrets.length > 0) {
		encoded.secrets.pop();
		if (omittedSecrets === Number.MAX_SAFE_INTEGER) {
			throw new Error("The secret audit record omitted-placeholder count exceeds the safe integer range.");
		}
		omittedSecrets++;
		encoded.omittedSecrets = omittedSecrets;
	}

	line = serialiseRecord(encoded);
	if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
		// This can only be reached through a typed-but-invalid runtime value whose fixed metadata
		// cannot fit. Refusing the append is safer than emitting an over-cap or malformed line.
		throw new Error("The secret audit record metadata exceeds the maximum record size.");
	}

	encoded.command = fullCommand;
	line = serialiseRecord(encoded);
	if (Buffer.byteLength(line) <= MAX_RECORD_BYTES) return line;

	let low = 0;
	let high = fullCommand.length;
	let best = "";
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = middle === fullCommand.length ? fullCommand : prefixWithEllipsis(fullCommand, middle);
		encoded.command = candidate;
		const candidateBytes = Buffer.byteLength(serialiseRecord(encoded));
		if (candidateBytes <= MAX_RECORD_BYTES) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	encoded.command = best;
	line = serialiseRecord(encoded);
	if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
		throw new Error("The secret audit record could not be bounded to the maximum record size.");
	}
	return line;
}

/** Fail closed on runtime values that escaped the TypeScript interface. */
function assertEncodableRecord(record: SecretExpansionRecord): void {
	const valid =
		Number.isFinite(record.at) &&
		Array.isArray(record.secrets) &&
		record.secrets.every(secret => typeof secret === "string") &&
		typeof record.tool === "string" &&
		typeof record.command === "string" &&
		(record.session === undefined || typeof record.session === "string") &&
		(record.truncated === undefined || record.truncated === true) &&
		(record.omittedSecrets === undefined ||
			(Number.isSafeInteger(record.omittedSecrets) && record.omittedSecrets > 0));
	if (!valid) throw new Error("The secret audit record has invalid metadata.");
}

/** Construct the on-disk line in one field order, discarding unknown runtime properties. */
function serialiseRecord(record: SecretExpansionRecord): string {
	return `${JSON.stringify(record)}\n`;
}

/** Bound a direct-call string before JSON encoding so preflight itself cannot allocate without limit. */
function boundedPrefix(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : prefixWithEllipsis(value, maxChars - 1);
}

/** Keep a UTF-16-safe prefix and record the cut visibly. */
function prefixWithEllipsis(value: string, requestedEnd: number): string {
	let end = clamp(requestedEnd, 0, value.length);
	if (
		end > 0 &&
		end < value.length &&
		value.charCodeAt(end - 1) >= 0xd800 &&
		value.charCodeAt(end - 1) <= 0xdbff &&
		value.charCodeAt(end) >= 0xdc00 &&
		value.charCodeAt(end) <= 0xdfff
	) {
		end--;
	}
	return `${value.slice(0, end)}…`;
}

/** Cap a JSON string by its encoded bytes, not its source character count. */
function capJsonString(value: string, maxBytes: number): string {
	if (Buffer.byteLength(JSON.stringify(value)) <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	let best = "";
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = prefixWithEllipsis(value, middle);
		if (Buffer.byteLength(JSON.stringify(candidate)) <= maxBytes) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

/** Parse a log back, skipping nothing silently: an unreadable line is reported as such. */
export function decodeLog(text: string): { records: SecretExpansionRecord[]; malformed: number } {
	const records: SecretExpansionRecord[] = [];
	let malformed = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isSecretExpansionRecord(parsed)) records.push(parsed);
			else malformed++;
		} catch {
			malformed++;
		}
	}
	return { records, malformed };
}

/**
 * Whether a parsed line is a secret-expansion record, checking EVERY field the renderer reads.
 *
 * The check used to be `typeof at === "number" && Array.isArray(secrets)` followed by a cast, so a
 * line missing `tool` or `command`, or carrying a `secrets` array of numbers, counted as a valid
 * record and `/secret log` printed `undefined` in the middle of a security report. Half-checking
 * and then asserting the type is the same class of mistake as not checking: the renderer trusts
 * this predicate, so it has to cover what the renderer touches. A line that fails is counted as
 * malformed, which is reported to the operator rather than dropped.
 *
 * It used to be called `isRecord`, which is the name `@veyyon/utils` gives to the plain
 * "is this an object" guard, and having one name mean two different checks in one tree is worse
 * than a duplicate: a reader who knows the shared guard reads this call site as a cheap object
 * test and has no reason to look, and an import of the shared name here would have silently
 * shadowed the strict check with the loose one, letting a half-formed line through as valid. The
 * object test IS the shared guard now, and this predicate adds only the fields the renderer reads.
 */
function isSecretExpansionRecord(value: unknown): value is SecretExpansionRecord {
	if (!isRecord(value)) return false;
	const candidate = value;
	const omittedSecretsAreValid =
		candidate.omittedSecrets === undefined ||
		(Number.isSafeInteger(candidate.omittedSecrets) && (candidate.omittedSecrets as number) > 0);
	return (
		typeof candidate.at === "number" &&
		Number.isFinite(candidate.at) &&
		Array.isArray(candidate.secrets) &&
		candidate.secrets.every(secret => typeof secret === "string") &&
		typeof candidate.tool === "string" &&
		typeof candidate.command === "string" &&
		(candidate.session === undefined || typeof candidate.session === "string") &&
		(candidate.truncated === undefined || candidate.truncated === true) &&
		omittedSecretsAreValid &&
		(candidate.omittedSecrets === undefined || candidate.truncated === true)
	);
}

/** Reject paths an audit write must never follow or reinterpret. */
function assertOwnedRegularFile(filePath: string, stats: Stats): void {
	if (!stats.isFile()) {
		throw new Error(`The secret audit path at ${filePath} is not a regular file.`);
	}
	const currentUid = process.getuid?.();
	if (currentUid !== undefined && stats.uid !== currentUid) {
		throw new Error(`The secret audit file at ${filePath} is not owned by the current user.`);
	}
}

/**
 * Correct an existing owned regular file to 0600. Absence is returned to the caller; symlinks,
 * directories, devices and files owned by another user are refused.
 */
async function secureExistingFile(filePath: string): Promise<Stats | null> {
	let before: Stats;
	try {
		before = await fs.lstat(filePath);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	assertOwnedRegularFile(filePath, before);
	if (process.platform !== "win32" && (before.mode & 0o7777) !== 0o600) {
		await fs.chmod(filePath, 0o600);
		const after = await fs.lstat(filePath);
		assertOwnedRegularFile(filePath, after);
		if (after.dev !== before.dev || after.ino !== before.ino || (after.mode & 0o7777) !== 0o600) {
			throw new Error(`The secret audit file at ${filePath} could not be secured to mode 0600.`);
		}
		return after;
	}
	return before;
}

/** Re-check the opened inode so a path swap cannot turn a verified file into the write target. */
async function secureHandle(filePath: string, handle: FileHandle): Promise<void> {
	let stats = await handle.stat();
	assertOwnedRegularFile(filePath, stats);
	if (process.platform !== "win32" && (stats.mode & 0o7777) !== 0o600) {
		await handle.chmod(0o600);
		stats = await handle.stat();
		assertOwnedRegularFile(filePath, stats);
		if ((stats.mode & 0o7777) !== 0o600) {
			throw new Error(`The secret audit file at ${filePath} could not be secured to mode 0600.`);
		}
	}
}

/**
 * Appends records, in order, without blocking the tool call that produced them.
 *
 * The tool-argument transform is synchronous, so {@link record} takes the record and returns.
 * Writes are chained rather than fired independently, so the log's order matches the order the
 * expansions happened in even when several land in the same millisecond.
 */
export class SecretAuditLog {
	readonly #logPath: string;
	readonly #notices: OperatorNotices | undefined;
	#chain: Promise<void> = Promise.resolve();

	constructor(logPath: string, notices?: OperatorNotices) {
		this.#logPath = logPath;
		this.#notices = notices;
	}

	/** Path being appended to, so `/secret log` can name the file it read. */
	get path(): string {
		return this.#logPath;
	}

	/** Path of the kept previous generation. */
	get rotatedPath(): string {
		return `${this.#logPath}${ROTATED_SUFFIX}`;
	}

	/** Queue one record. Never throws: a write failure becomes an operator notice. */
	record(record: SecretExpansionRecord): void {
		this.#chain = this.#chain.then(async () => {
			try {
				const line = encodeRecord(record);
				await fs.mkdir(path.dirname(this.#logPath), { recursive: true });
				await withFileLock(this.#logPath, async () => {
					// The lock covers the entire read-modify-write transaction. Two processes can
					// neither both decide the same old file still fits nor rotate out each other's
					// newly appended record.
					await this.#rotateIfFull(Buffer.byteLength(line));
					await this.#appendLine(line);
				});
			} catch (error) {
				this.#notices?.error(
					"secrets",
					`The secret audit log at ${this.#logPath} could not be appended to (${String(error)}). ` +
						`Credentials are still protected, but their use is no longer being recorded.`,
				);
			}
		});
	}

	/** Append through a verified 0600 regular-file handle while the cross-process lock is held. */
	async #appendLine(line: string): Promise<void> {
		const flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
		const handle = await fs.open(this.#logPath, flags, 0o600);
		try {
			await secureHandle(this.#logPath, handle);
			const bytes = Buffer.from(line);
			let offset = 0;
			while (offset < bytes.length) {
				const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
				if (bytesWritten === 0) {
					throw new Error("The secret audit append made no forward progress.");
				}
				offset += bytesWritten;
			}
		} finally {
			await handle.close();
		}
	}

	/**
	 * Move the log aside when this record would carry it past {@link ROTATE_AT_BYTES}.
	 *
	 * Checked before the append rather than after, so the ceiling is a ceiling rather than a
	 * threshold the file is allowed to sit above until the next write. `rename` replaces any
	 * existing previous generation, which is what bounds the total to two files.
	 *
	 * A rotation failure deliberately does NOT stop the append: the caller's `catch` would then
	 * report a lost record when nothing was lost, and an over-size log still records correctly.
	 */
	async #rotateIfFull(incomingBytes: number): Promise<void> {
		const current = await secureExistingFile(this.#logPath);
		const rotationNeeded = current !== null && current.size + incomingBytes > ROTATE_AT_BYTES;
		if (!rotationNeeded) {
			// A stale previous generation is audit evidence too. Do not leave it permissive merely
			// because this particular append did not need to replace it.
			await secureExistingFile(this.rotatedPath);
			return;
		}

		try {
			// Validate the destination too. `rename` atomically replaces a regular generation, but
			// must not bless an operator-created symlink or special file by replacing it silently.
			await secureExistingFile(this.rotatedPath);
			await fs.rename(this.#logPath, this.rotatedPath);
		} catch (error) {
			this.#notices?.warn(
				"secrets",
				`The secret audit log at ${this.#logPath} has reached ${current.size} bytes and could not be ` +
					`rotated (${String(error)}). Use is still being recorded, in a file that will keep growing.`,
			);
		}
	}

	/**
	 * Wait for queued writes to land.
	 *
	 * Awaited by the `session.dispose` wrapper in `sdk.ts`, which is the whole reason it is not
	 * test-only: quitting ends the process rather than waiting for pending work, so without that
	 * call whichever records were still queued were lost, silently, and the last credential an
	 * agent used is exactly the one an incident asks about. This doc comment claimed a shutdown
	 * caller before one existed.
	 */
	async flush(): Promise<void> {
		await this.#chain;
	}

	/**
	 * Read the log back, newest last.
	 *
	 * Returns an empty list when the file does not exist, because "no credential has been used
	 * yet" is the ordinary state of a fresh profile and is not a failure.
	 */
	async read(options?: { limit?: number }): Promise<{ records: SecretExpansionRecord[]; malformed: number }> {
		const parentDir = path.dirname(this.#logPath);
		try {
			const parent = await fs.stat(parentDir);
			if (!parent.isDirectory()) {
				throw new Error(`The secret audit directory at ${parentDir} is not a directory.`);
			}
		} catch (error) {
			if (isEnoent(error)) return { records: [], malformed: 0 };
			throw error;
		}

		const generations = await withFileLock(this.#logPath, async () =>
			// Oldest generation first, so the combined list stays in expansion order. Taking the
			// same lock as writers prevents a read from combining one side of the old generation
			// pair with one side of the new pair during rotation.
			Promise.all([this.#readOne(this.rotatedPath), this.#readOne(this.#logPath)]),
		);
		const records = generations.flatMap(generation => generation.records);
		const malformed = generations.reduce((total, generation) => total + generation.malformed, 0);
		const limit = options?.limit;
		return { records: limit === undefined ? records : records.slice(-limit), malformed };
	}

	/** One generation, absent-is-empty, unsafe-or-unreadable-is-an-error. */
	async #readOne(filePath: string): Promise<{ records: SecretExpansionRecord[]; malformed: number }> {
		try {
			if ((await secureExistingFile(filePath)) === null) return { records: [], malformed: 0 };
			const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
			const handle = await fs.open(filePath, flags);
			try {
				await secureHandle(filePath, handle);
				return decodeLog(await handle.readFile("utf8"));
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (isEnoent(error)) return { records: [], malformed: 0 };
			throw new Error(`The secret audit log at ${filePath} could not be read (${String(error)}).`);
		}
	}
}
