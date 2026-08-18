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
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	applyOwnerOnlyWindowsAcl,
	clamp,
	escapeTerminalText,
	isEnoent,
	isRecord,
	verifyOwnerOnlyWindowsAcl,
	withFileLock,
} from "@veyyon/utils";
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

/** Snapshot and traversal bounds are security limits, not presentation preferences. */
const MAX_COMMAND_CHARS = 1200;
const MAX_RECORDED_SECRETS = 16;
const MAX_SECRET_JSON_BYTES = 128;
const MAX_METADATA_JSON_BYTES = 256;
const MAX_FIELD_CHARS = MAX_RECORD_BYTES;
const MAX_AUDIT_DEPTH = 24;
const MAX_AUDIT_NODES = 512;
const MAX_PLACEHOLDER_CANDIDATES = 4096;
const MAX_SCANNED_STRING_BYTES = 256 * 1024;
const MAX_TOTAL_SCANNED_STRING_BYTES = 512 * 1024;
const MAX_SNAPSHOT_STRING_BYTES = 4096;
const MAX_SNAPSHOT_NODES = 128;
const MAX_DECODE_LINES = 32_768;
const MAX_DECODE_RECORDS = 32_768;
const MAX_PENDING_RECORDS = 128;
const MAX_PENDING_BYTES = MAX_PENDING_RECORDS * MAX_RECORD_BYTES;

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
 * `secret-audit.jsonl.1` and {@link SecretAuditLog.read} reads through it, so a `/secret log 20`
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
 * Placeholders present in a value, in encounter order, without duplicates.
 *
 * The walk is iterative and bounded. It deliberately uses the same enumerable string keys and
 * property reads as argument expansion, but a hostile proxy, getter, depth, or input-size limit
 * fails closed instead of allowing expansion with incomplete evidence.
 */
export function placeholdersIn(value: unknown, known: (placeholder: string) => boolean): string[] {
	return inspectAuditValue(value, known, text => text, false).secrets;
}

type InertSnapshot =
	| null
	| boolean
	| number
	| string
	| { kind: "array"; items: InertSnapshot[]; omitted: number }
	| { kind: "object"; entries: Array<[string, InertSnapshot]>; omitted: number };

interface InspectionState {
	readonly known: (placeholder: string) => boolean;
	readonly obfuscate: (value: string) => string;
	readonly found: string[];
	readonly seenPlaceholders: Set<string>;
	readonly seenObjects: WeakSet<object>;
	totalStringBytes: number;
	nodes: number;
	snapshotSlots: number;
	truncated: boolean;
	protectionFailed: boolean;
}

interface InspectionResult {
	secrets: string[];
	snapshot: InertSnapshot;
	truncated: boolean;
}

interface PendingInspection {
	value: unknown;
	depth: number;
	capture: boolean;
	assign: (value: InertSnapshot) => void;
}

/** Build one inert snapshot while discovering placeholders; input objects never reach JSON.stringify. */
function inspectAuditValue(
	value: unknown,
	known: (placeholder: string) => boolean,
	obfuscate: (value: string) => string,
	captureSnapshot: boolean,
): InspectionResult {
	let root: InertSnapshot = "[audit evidence unavailable]";
	const state: InspectionState = {
		known,
		obfuscate,
		found: [],
		seenPlaceholders: new Set(),
		seenObjects: new WeakSet(),
		totalStringBytes: 0,
		nodes: 0,
		snapshotSlots: captureSnapshot ? MAX_SNAPSHOT_NODES - 1 : 0,
		truncated: false,
		protectionFailed: false,
	};
	const pending: PendingInspection[] = [
		{ value, depth: 0, capture: captureSnapshot, assign: snapshot => (root = snapshot) },
	];

	while (pending.length > 0) {
		const current = pending.pop()!;
		state.nodes++;
		if (state.nodes > MAX_AUDIT_NODES) {
			throw new Error("Refusing secret expansion because its audit evidence exceeds the node limit.");
		}
		if (current.depth > MAX_AUDIT_DEPTH) {
			throw new Error("Refusing secret expansion because its audit evidence exceeds the depth limit.");
		}

		const node = current.value;
		if (typeof node === "string") {
			const protectedText = inspectText(node, state);
			if (current.capture) current.assign(protectedText);
			continue;
		}
		if (node === null || typeof node === "boolean") {
			if (current.capture) current.assign(node);
			continue;
		}
		if (typeof node === "number") {
			if (current.capture) current.assign(Number.isFinite(node) ? node : "[non-finite number]");
			continue;
		}
		if (typeof node !== "object") {
			if (current.capture) current.assign(`[${typeof node} omitted]`);
			state.truncated = true;
			continue;
		}
		if (state.seenObjects.has(node)) {
			if (current.capture) current.assign("[circular reference]");
			state.truncated = true;
			continue;
		}
		state.seenObjects.add(node);

		let isArray: boolean;
		try {
			isArray = Array.isArray(node);
		} catch {
			throw new Error("Refusing secret expansion because its audit evidence cannot inspect a proxy.");
		}
		if (isArray) {
			let length: number;
			try {
				length = (node as unknown[]).length;
			} catch {
				throw new Error("Refusing secret expansion because its audit evidence cannot inspect an array.");
			}
			if (!Number.isSafeInteger(length) || length < 0 || length + state.nodes > MAX_AUDIT_NODES) {
				throw new Error("Refusing secret expansion because its audit evidence exceeds the node limit.");
			}
			const snapshot = { kind: "array" as const, items: [] as InertSnapshot[], omitted: 0 };
			if (current.capture) current.assign(snapshot);
			const children: PendingInspection[] = [];
			for (let index = 0; index < length; index++) {
				let item: unknown;
				try {
					item = Reflect.get(node, index);
				} catch {
					throw new Error(
						"Refusing secret expansion because its audit evidence cannot materialise an array value.",
					);
				}
				const capture = current.capture && state.snapshotSlots > 0;
				if (capture) {
					state.snapshotSlots--;
					const target = snapshot.items.length;
					snapshot.items.push(null);
					children.push({
						value: item,
						depth: current.depth + 1,
						capture: true,
						assign: captured => (snapshot.items[target] = captured),
					});
				} else {
					if (current.capture) snapshot.omitted++;
					children.push({ value: item, depth: current.depth + 1, capture: false, assign: () => {} });
				}
			}
			if (snapshot.omitted > 0) state.truncated = true;
			for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
			continue;
		}

		let keys: string[];
		try {
			keys = Object.keys(node);
		} catch {
			throw new Error("Refusing secret expansion because its audit evidence cannot inspect object keys.");
		}
		if (keys.length + state.nodes > MAX_AUDIT_NODES) {
			throw new Error("Refusing secret expansion because its audit evidence exceeds the node limit.");
		}
		const snapshot = {
			kind: "object" as const,
			entries: [] as Array<[string, InertSnapshot]>,
			omitted: 0,
		};
		if (current.capture) current.assign(snapshot);
		const children: PendingInspection[] = [];
		for (const key of keys) {
			const protectedKey = inspectText(key, state);
			let item: unknown;
			try {
				item = Reflect.get(node, key);
			} catch {
				throw new Error("Refusing secret expansion because its audit evidence cannot materialise an object value.");
			}
			const capture = current.capture && state.snapshotSlots > 0;
			if (capture) {
				state.snapshotSlots--;
				const target = snapshot.entries.length;
				snapshot.entries.push([protectedKey, null]);
				children.push({
					value: item,
					depth: current.depth + 1,
					capture: true,
					assign: captured => (snapshot.entries[target][1] = captured),
				});
			} else {
				if (current.capture) snapshot.omitted++;
				children.push({ value: item, depth: current.depth + 1, capture: false, assign: () => {} });
			}
		}
		if (snapshot.omitted > 0) state.truncated = true;
		for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
	}

	return {
		secrets: state.found,
		snapshot: root,
		truncated: state.truncated || state.protectionFailed,
	};
}

/** Scan without match-array materialisation, then protect the complete string before retaining it. */
function inspectText(value: string, state: InspectionState): string {
	if (value.length > MAX_SCANNED_STRING_BYTES) {
		throw new Error("Refusing secret expansion because an audit string exceeds the byte limit.");
	}
	const bytes = Buffer.byteLength(value);
	if (bytes > MAX_SCANNED_STRING_BYTES || state.totalStringBytes + bytes > MAX_TOTAL_SCANNED_STRING_BYTES) {
		throw new Error("Refusing secret expansion because its audit strings exceed the byte limit.");
	}
	state.totalStringBytes += bytes;

	const candidates: string[] = [];
	PLACEHOLDER_RE.lastIndex = 0;
	try {
		for (let match = PLACEHOLDER_RE.exec(value); match !== null; match = PLACEHOLDER_RE.exec(value)) {
			const placeholder = match[0];
			if (state.seenPlaceholders.has(placeholder)) continue;
			if (state.seenPlaceholders.size >= MAX_PLACEHOLDER_CANDIDATES) {
				throw new Error("Refusing secret expansion because its audit evidence has too many placeholders.");
			}
			state.seenPlaceholders.add(placeholder);
			candidates.push(placeholder);
		}
	} finally {
		PLACEHOLDER_RE.lastIndex = 0;
	}
	for (const placeholder of candidates) {
		if (state.known(placeholder)) state.found.push(placeholder);
	}

	if (bytes > MAX_SNAPSHOT_STRING_BYTES) {
		state.truncated = true;
		return "[oversized string omitted]";
	}
	try {
		const protectedText = state.obfuscate(value);
		if (typeof protectedText !== "string" || Buffer.byteLength(protectedText) > MAX_SNAPSHOT_STRING_BYTES) {
			state.protectionFailed = true;
			return "[protected string omitted]";
		}
		return protectedText;
	} catch {
		state.protectionFailed = true;
		return "[protected string unavailable]";
	}
}

/** Build a bounded record from arguments before expansion. */
export function buildExpansionRecord(options: {
	args: Record<string, unknown>;
	tool: string;
	session: string | undefined;
	at: number;
	known: (placeholder: string) => boolean;
	obfuscate: (value: string) => string;
}): SecretExpansionRecord | null {
	const inspection = inspectAuditValue(options.args, options.known, options.obfuscate, true);
	if (inspection.secrets.length === 0) return null;

	const serialised = stringifySnapshot(inspection.snapshot);
	const commandWasCut = serialised.length > MAX_COMMAND_CHARS;
	let command = commandWasCut ? prefixWithEllipsis(serialised, MAX_COMMAND_CHARS - 1) : serialised;
	if (inspection.truncated && !command.endsWith("…")) {
		command = prefixWithEllipsis(command, Math.min(command.length, MAX_COMMAND_CHARS - 1));
	}
	const protectedSecrets = inspection.secrets
		.slice(0, MAX_RECORDED_SECRETS)
		.map(secret => protectMetadata(secret, options.obfuscate));
	const omittedSecrets = inspection.secrets.length - protectedSecrets.length;
	const record: SecretExpansionRecord = {
		at: options.at,
		secrets: protectedSecrets,
		tool: protectMetadata(options.tool, options.obfuscate),
		command,
	};
	if (options.session !== undefined) record.session = protectMetadata(options.session, options.obfuscate);
	if (omittedSecrets > 0) record.omittedSecrets = omittedSecrets;
	if (inspection.truncated || commandWasCut || omittedSecrets > 0) record.truncated = true;
	return record;
}

/** Protect labels without ever retaining attacker text when protection itself is unavailable. */
function protectMetadata(value: string, obfuscate: (value: string) => string): string {
	if (value.length > MAX_FIELD_CHARS || Buffer.byteLength(value) > MAX_FIELD_CHARS) {
		return "[oversized metadata omitted]";
	}
	try {
		const protectedText = obfuscate(value);
		return typeof protectedText === "string"
			? boundedPrefix(protectedText, MAX_FIELD_CHARS)
			: "[metadata unavailable]";
	} catch {
		return "[metadata unavailable]";
	}
}

/** Serialize only our inert tagged snapshot; input properties and `toJSON` are never consulted. */
function stringifySnapshot(value: InertSnapshot): string {
	if (value === null || typeof value === "boolean" || typeof value === "number") return String(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (value.kind === "array") {
		const items = value.items.map(stringifySnapshot);
		if (value.omitted > 0) items.push(JSON.stringify(`[${value.omitted} array values omitted]`));
		return `[${items.join(",")}]`;
	}
	const entries = value.entries.map(([key, item]) => `${JSON.stringify(key)}:${stringifySnapshot(item)}`);
	if (value.omitted > 0) {
		entries.push(`${JSON.stringify("[audit fields omitted]")}:${value.omitted}`);
	}
	return `{${entries.join(",")}}`;
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

/**
 * The encoder's JSON escapes protect the file format, not the terminal: JSON.parse restores control
 * bytes. Normalise every decoded string before it reaches `/secret log`, including hand-edited or
 * crash-damaged evidence that did not pass through this process's encoder.
 */
function terminalSafeRecord(record: SecretExpansionRecord): SecretExpansionRecord {
	return {
		...record,
		secrets: record.secrets.map(escapeTerminalText),
		tool: escapeTerminalText(record.tool),
		command: escapeTerminalText(record.command),
		...(record.session === undefined ? {} : { session: escapeTerminalText(record.session) }),
	};
}

/** Parse a log back, skipping nothing silently: an unreadable line is reported as such. */
export function decodeLog(text: string): { records: SecretExpansionRecord[]; malformed: number } {
	const records: SecretExpansionRecord[] = [];
	let malformed = 0;
	let line = "";
	let lineBytes = 0;
	let lineHasContent = false;
	let lineOverCap = false;
	let decodedBytes = 0;
	let lines = 0;

	const finishLine = (): void => {
		if (!lineHasContent) return;
		lines++;
		if (lines > MAX_DECODE_LINES) {
			throw new Error(`The secret audit log exceeds the ${MAX_DECODE_LINES}-line decode limit.`);
		}
		if (lineOverCap) {
			malformed++;
			return;
		}
		try {
			const parsed: unknown = JSON.parse(line);
			if (isSecretExpansionRecord(parsed)) {
				if (records.length >= MAX_DECODE_RECORDS) {
					throw new Error(`The secret audit log exceeds the ${MAX_DECODE_RECORDS}-record decode limit.`);
				}
				records.push(terminalSafeRecord(parsed));
			} else {
				malformed++;
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes("record decode limit")) throw error;
			malformed++;
		}
	};

	for (let index = 0; index <= text.length; index++) {
		const codeUnit = index === text.length ? 0x0a : text.charCodeAt(index);
		if (codeUnit === 0x0a) {
			decodedBytes++;
			if (decodedBytes > ROTATE_AT_BYTES + 1) {
				throw new Error(`The secret audit text exceeds the ${ROTATE_AT_BYTES}-byte decode limit.`);
			}
			finishLine();
			line = "";
			lineBytes = 0;
			lineHasContent = false;
			lineOverCap = false;
			continue;
		}

		let character = text[index];
		let characterBytes: number;
		if (codeUnit <= 0x7f) {
			characterBytes = 1;
		} else if (codeUnit <= 0x7ff) {
			characterBytes = 2;
		} else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				character += text[++index];
				characterBytes = 4;
			} else {
				characterBytes = 3;
			}
		} else {
			characterBytes = 3;
		}
		decodedBytes += characterBytes;
		if (decodedBytes > ROTATE_AT_BYTES + 1) {
			throw new Error(`The secret audit text exceeds the ${ROTATE_AT_BYTES}-byte decode limit.`);
		}
		if (codeUnit !== 0x20 && codeUnit !== 0x09 && codeUnit !== 0x0d) lineHasContent = true;
		lineBytes += characterBytes;
		if (lineBytes > MAX_RECORD_BYTES) {
			lineOverCap = true;
		} else {
			line += character;
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
		throw new Error(`The secret audit path at ${escapeTerminalText(filePath)} is not a regular file.`);
	}
	if (stats.nlink !== 1) {
		throw new Error(`The secret audit file at ${escapeTerminalText(filePath)} does not have exactly one hard link.`);
	}
	const currentUid = process.getuid?.();
	if (currentUid !== undefined && stats.uid !== currentUid) {
		throw new Error(`The secret audit file at ${escapeTerminalText(filePath)} is not owned by the current user.`);
	}
}

interface PinnedParent {
	path: string;
	handle: FileHandle;
	stats: Stats;
}

interface OpenedAuditFile {
	handle: FileHandle;
	stats: Stats;
	created: boolean;
}

function sameIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function assertPathIdentity(filePath: string, expected: Stats): Promise<Stats> {
	const actual = await fs.lstat(filePath);
	assertOwnedRegularFile(filePath, actual);
	if (!sameIdentity(actual, expected)) {
		throw new Error(`The secret audit path at ${escapeTerminalText(filePath)} was replaced during the operation.`);
	}
	return actual;
}

async function openPinnedParent(filePath: string): Promise<PinnedParent> {
	const parentPath = path.dirname(filePath);
	const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
	const handle = await fs.open(parentPath, flags);
	try {
		const stats = await handle.stat();
		if (!stats.isDirectory()) {
			throw new Error(`The secret audit directory at ${escapeTerminalText(parentPath)} is not a directory.`);
		}
		const currentUid = process.getuid?.();
		if (currentUid !== undefined && stats.uid !== currentUid) {
			throw new Error(
				`The secret audit directory at ${escapeTerminalText(parentPath)} is not owned by the current user.`,
			);
		}
		const pinned = { path: parentPath, handle, stats };
		await assertParentIdentity(pinned);
		return pinned;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function assertParentIdentity(parent: PinnedParent): Promise<void> {
	const opened = await parent.handle.stat();
	if (!opened.isDirectory() || !sameIdentity(opened, parent.stats)) {
		throw new Error(`The pinned secret audit directory at ${escapeTerminalText(parent.path)} changed identity.`);
	}
	const current = await fs.lstat(parent.path);
	if (!current.isDirectory() || !sameIdentity(current, parent.stats)) {
		throw new Error(`The secret audit directory at ${escapeTerminalText(parent.path)} was replaced.`);
	}
}

/** Create missing parent components one at a time while every namespace mutation pins its parent. */
async function ensureAuditParent(filePath: string): Promise<void> {
	const target = path.dirname(filePath);
	const parsed = path.parse(target);
	const segments = target
		.slice(parsed.root.length)
		.split(path.sep)
		.filter(segment => segment.length > 0);
	const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
	let currentPath = parsed.root;
	let currentHandle = await fs.open(currentPath, flags);
	let currentStats = await currentHandle.stat();
	try {
		for (const segment of segments) {
			const parent: PinnedParent = { path: currentPath, handle: currentHandle, stats: currentStats };
			await assertParentIdentity(parent);
			const childPath = path.join(currentPath, segment);
			let childHandle: FileHandle;
			let created = false;
			try {
				childHandle = await fs.open(childPath, flags);
			} catch (error) {
				if (!isEnoent(error)) throw error;
				await fs.mkdir(childPath, { mode: 0o700 });
				created = true;
				childHandle = await fs.open(childPath, flags);
			}
			let childStats: Stats;
			try {
				childStats = await childHandle.stat();
				if (!childStats.isDirectory()) {
					throw new Error(`The secret audit parent at ${escapeTerminalText(childPath)} is not a directory.`);
				}
				const childPathStats = await fs.lstat(childPath);
				if (!childPathStats.isDirectory() || !sameIdentity(childPathStats, childStats)) {
					throw new Error(`The secret audit parent at ${escapeTerminalText(childPath)} was replaced.`);
				}
				if (created) {
					if (process.platform === "win32") {
						await applyOwnerOnlyWindowsAcl(childPath);
						await verifyOwnerOnlyWindowsAcl(childPath);
					} else {
						await childHandle.chmod(0o700);
						childStats = await childHandle.stat();
						if ((childStats.mode & 0o7777) !== 0o700) {
							throw new Error(`The secret audit parent at ${escapeTerminalText(childPath)} is not mode 0700.`);
						}
					}
					const securedPathStats = await fs.lstat(childPath);
					if (!sameIdentity(securedPathStats, childStats)) {
						throw new Error(`The secret audit parent at ${escapeTerminalText(childPath)} was replaced.`);
					}
					await childHandle.sync();
					await currentHandle.sync();
				}
				await assertParentIdentity(parent);
			} catch (error) {
				await childHandle.close();
				throw error;
			}
			await currentHandle.close();
			currentPath = childPath;
			currentHandle = childHandle;
			currentStats = childStats;
		}
	} finally {
		await currentHandle.close();
	}
}

/** Secure the exact opened descriptor, then prove the pathname still names that inode. */
async function secureHandle(filePath: string, handle: FileHandle, applyAcl: boolean): Promise<Stats> {
	let stats = await handle.stat();
	assertOwnedRegularFile(filePath, stats);
	await assertPathIdentity(filePath, stats);
	if (process.platform === "win32") {
		if (applyAcl) await applyOwnerOnlyWindowsAcl(filePath);
		await verifyOwnerOnlyWindowsAcl(filePath);
		await assertPathIdentity(filePath, stats);
	} else if ((stats.mode & 0o7777) !== 0o600) {
		await handle.chmod(0o600);
		stats = await handle.stat();
		assertOwnedRegularFile(filePath, stats);
		if ((stats.mode & 0o7777) !== 0o600) {
			throw new Error(`The secret audit file at ${escapeTerminalText(filePath)} could not be secured to mode 0600.`);
		}
		await assertPathIdentity(filePath, stats);
	}
	return stats;
}

async function throwClassifiedOpenError(filePath: string, error: unknown): Promise<never> {
	let stats: Stats;
	try {
		stats = await fs.lstat(filePath);
	} catch {
		throw error;
	}
	assertOwnedRegularFile(filePath, stats);
	throw error;
}

async function openExistingAuditFile(filePath: string, flags: number): Promise<OpenedAuditFile | null> {
	let handle: FileHandle;
	try {
		handle = await fs.open(filePath, flags | (fsConstants.O_NOFOLLOW ?? 0));
	} catch (error) {
		if (isEnoent(error)) return null;
		return await throwClassifiedOpenError(filePath, error);
	}
	try {
		const stats = await secureHandle(filePath, handle, true);
		return { handle, stats, created: false };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function openOrCreateAuditFile(filePath: string, flags: number, parent: PinnedParent): Promise<OpenedAuditFile> {
	await assertParentIdentity(parent);
	let handle: FileHandle;
	let created = false;
	try {
		handle = await fs.open(
			filePath,
			flags | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
			0o600,
		);
		created = true;
	} catch (error) {
		if (!isAlreadyExists(error)) return await throwClassifiedOpenError(filePath, error);
		try {
			handle = await fs.open(filePath, flags | (fsConstants.O_NOFOLLOW ?? 0));
		} catch (openError) {
			return await throwClassifiedOpenError(filePath, openError);
		}
	}
	try {
		await assertParentIdentity(parent);
		const stats = await secureHandle(filePath, handle, true);
		return { handle, stats, created };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

function isAlreadyExists(error: unknown): boolean {
	return isRecord(error) && error.code === "EEXIST";
}

/** Whether an append needs a boundary before its first JSON byte. */
async function handleNeedsLineSeparator(handle: FileHandle, stats: Stats): Promise<boolean> {
	if (stats.size === 0) return false;
	const lastByte = Buffer.allocUnsafe(1);
	const { bytesRead } = await handle.read(lastByte, 0, 1, stats.size - 1);
	if (bytesRead !== 1) throw new Error("The secret audit log's final byte could not be read.");
	return lastByte[0] !== 0x0a;
}

async function writeAll(handle: FileHandle, bytes: Buffer, position: number | null): Promise<void> {
	let offset = 0;
	while (offset < bytes.length) {
		const { bytesWritten } = await handle.write(
			bytes,
			offset,
			bytes.length - offset,
			position === null ? null : position + offset,
		);
		if (bytesWritten === 0) throw new Error("The secret audit write made no forward progress.");
		offset += bytesWritten;
	}
}

async function readBounded(handle: FileHandle, cap: number): Promise<Buffer> {
	const bytes = Buffer.allocUnsafe(cap + 1);
	let offset = 0;
	while (offset < bytes.length) {
		const read = await handle.read(bytes, offset, bytes.length - offset, offset);
		if (read.bytesRead === 0) break;
		offset += read.bytesRead;
	}
	if (offset > cap) throw new Error(`The secret audit generation is above the ${cap}-byte read limit.`);
	return bytes.subarray(0, offset);
}

/**
 * Ordered, bounded audit queue. Records are encoded synchronously so the queue never retains a
 * caller object whose getters or fields can change after expansion has begun.
 */
export class SecretAuditLog {
	readonly #logPath: string;
	readonly #rawRotatedPath: string;
	readonly #notices: OperatorNotices | undefined;
	readonly #pending: Array<{ line: string; bytes: number }> = [];
	#retainedRecords = 0;
	#retainedBytes = 0;
	#drainPromise: Promise<void> | null = null;
	#degraded = false;
	#queueFullNotified = false;

	constructor(logPath: string, notices?: OperatorNotices) {
		if (!path.isAbsolute(logPath)) throw new Error("The secret audit log path must be absolute.");
		this.#logPath = logPath;
		this.#rawRotatedPath = `${logPath}${ROTATED_SUFFIX}`;
		this.#notices = notices;
	}

	get path(): string {
		return escapeTerminalText(this.#logPath);
	}

	get rotatedPath(): string {
		return escapeTerminalText(this.#rawRotatedPath);
	}

	/**
	 * Queue one already-sanitized record. Capacity exhaustion throws synchronously, before the
	 * caller expands placeholders, and emits one visible bounded-loss notice.
	 */
	record(record: SecretExpansionRecord): void {
		const line = encodeRecord(record);
		const bytes = Buffer.byteLength(line);
		if (this.#retainedRecords >= MAX_PENDING_RECORDS || this.#retainedBytes + bytes > MAX_PENDING_BYTES) {
			if (!this.#queueFullNotified) {
				this.#notices?.error(
					"secrets",
					`The secret audit queue at ${escapeTerminalText(this.#logPath)} is full; credential expansion was refused before use.`,
				);
				this.#queueFullNotified = true;
			}
			throw new Error("The secret audit queue is full; refusing credential expansion.");
		}
		this.#pending.push({ line, bytes });
		this.#retainedRecords++;
		this.#retainedBytes += bytes;
		this.#startDrain();
	}

	#startDrain(): void {
		if (this.#drainPromise !== null) return;
		let tracked: Promise<void>;
		tracked = Promise.resolve()
			.then(async () => await this.#drainOneBatch())
			.finally(() => {
				if (this.#drainPromise === tracked) this.#drainPromise = null;
				if (this.#pending.length > 0) this.#startDrain();
			});
		this.#drainPromise = tracked;
	}

	async #drainOneBatch(): Promise<void> {
		const batch = this.#pending.splice(0);
		if (batch.length === 0) return;
		try {
			await ensureAuditParent(this.#logPath);
			const parent = await openPinnedParent(this.#logPath);
			try {
				await withFileLock(this.#logPath, async () => {
					await assertParentIdentity(parent);
					for (const entry of batch) {
						await this.#rotateIfFull(entry.bytes, parent);
						await this.#appendLine(entry.line, entry.bytes, parent);
					}
					await assertParentIdentity(parent);
				});
			} finally {
				await parent.handle.close();
			}
			if (this.#degraded) {
				this.#notices?.warn(
					"secrets",
					`The secret audit log at ${escapeTerminalText(this.#logPath)} recovered; recording has resumed.`,
				);
			}
			this.#degraded = false;
		} catch (error) {
			if (!this.#degraded) {
				this.#notices?.error(
					"secrets",
					`The secret audit log at ${escapeTerminalText(this.#logPath)} could not be appended to ` +
						`(${escapeTerminalText(String(error))}). ${batch.length} bounded queued ` +
						`record${batch.length === 1 ? " was" : "s were"} not written. Credentials remain protected; ` +
						`credential use is no longer being recorded until the next append recovers.`,
				);
			}
			this.#degraded = true;
		} finally {
			this.#retainedRecords -= batch.length;
			this.#retainedBytes -= batch.reduce((total, entry) => total + entry.bytes, 0);
			if (this.#retainedRecords < MAX_PENDING_RECORDS && this.#retainedBytes < MAX_PENDING_BYTES) {
				this.#queueFullNotified = false;
			}
		}
	}

	async #appendLine(line: string, lineBytes: number, parent: PinnedParent): Promise<void> {
		const opened = await openOrCreateAuditFile(this.#logPath, fsConstants.O_APPEND | fsConstants.O_RDWR, parent);
		try {
			const stats = await opened.handle.stat();
			assertOwnedRegularFile(this.#logPath, stats);
			const separator = await handleNeedsLineSeparator(opened.handle, stats);
			if (stats.size + (separator ? 1 : 0) + lineBytes > ROTATE_AT_BYTES) {
				throw new Error("The secret audit append would exceed the generation cap.");
			}
			const bytes = Buffer.from(separator ? `\n${line}` : line);
			await writeAll(opened.handle, bytes, null);
			await opened.handle.datasync();
			const after = await opened.handle.stat();
			if (after.size > ROTATE_AT_BYTES || !sameIdentity(after, stats)) {
				throw new Error("The secret audit file changed during append.");
			}
			await assertPathIdentity(this.#logPath, after);
			await assertParentIdentity(parent);
			if (opened.created) await parent.handle.sync();
		} finally {
			await opened.handle.close();
		}
	}

	/**
	 * Copy the full live generation into the pinned previous-generation descriptor and datasync it
	 * before truncating the still-open live descriptor. A failed rotation therefore leaves the
	 * readable live generation untouched, and no rename/unlink can delete a substituted inode.
	 */
	async #rotateIfFull(incomingBytes: number, parent: PinnedParent): Promise<void> {
		const current = await openExistingAuditFile(this.#logPath, fsConstants.O_RDWR);
		if (current === null) {
			const old = await openExistingAuditFile(this.#rawRotatedPath, fsConstants.O_RDONLY);
			if (old !== null) await old.handle.close();
			return;
		}
		try {
			const separator = await handleNeedsLineSeparator(current.handle, current.stats);
			if (current.stats.size + (separator ? 1 : 0) + incomingBytes <= ROTATE_AT_BYTES) {
				const old = await openExistingAuditFile(this.#rawRotatedPath, fsConstants.O_RDONLY);
				if (old !== null) await old.handle.close();
				return;
			}
			if (current.stats.size > ROTATE_AT_BYTES) {
				throw new Error("The live secret audit generation is already above its cap.");
			}

			const rotated = await openOrCreateAuditFile(this.#rawRotatedPath, fsConstants.O_RDWR, parent);
			try {
				await assertPathIdentity(this.#logPath, current.stats);
				await assertPathIdentity(this.#rawRotatedPath, rotated.stats);
				await assertParentIdentity(parent);
				const source = await readBounded(current.handle, ROTATE_AT_BYTES);
				await rotated.handle.truncate(0);
				await writeAll(rotated.handle, source, 0);
				await rotated.handle.truncate(source.length);
				await rotated.handle.datasync();
				await assertPathIdentity(this.#rawRotatedPath, rotated.stats);
				await assertPathIdentity(this.#logPath, current.stats);
				await current.handle.truncate(0);
				await current.handle.datasync();
				await assertPathIdentity(this.#logPath, current.stats);
				await assertParentIdentity(parent);
				if (rotated.created) await parent.handle.sync();
			} finally {
				await rotated.handle.close();
			}
		} finally {
			await current.handle.close();
		}
	}

	async flush(): Promise<void> {
		for (;;) {
			const drain = this.#drainPromise;
			if (drain === null) return;
			await drain;
		}
	}

	async read(options?: { limit?: number }): Promise<{ records: SecretExpansionRecord[]; malformed: number }> {
		let parent: PinnedParent;
		try {
			parent = await openPinnedParent(this.#logPath);
		} catch (error) {
			if (isEnoent(error)) return { records: [], malformed: 0 };
			throw error;
		}
		try {
			const generations = await withFileLock(this.#logPath, async () => {
				await assertParentIdentity(parent);
				const rotated = await this.#readOne(this.#rawRotatedPath);
				const current = await this.#readOne(this.#logPath);
				await assertParentIdentity(parent);
				return [rotated, current];
			});
			const records = generations.flatMap(generation => generation.records);
			const malformed = generations.reduce((total, generation) => total + generation.malformed, 0);
			const limit = options?.limit;
			return { records: limit === undefined ? records : records.slice(-limit), malformed };
		} finally {
			await parent.handle.close();
		}
	}

	async #readOne(filePath: string): Promise<{ records: SecretExpansionRecord[]; malformed: number }> {
		try {
			const opened = await openExistingAuditFile(filePath, fsConstants.O_RDONLY);
			if (opened === null) return { records: [], malformed: 0 };
			try {
				const bytes = await readBounded(opened.handle, ROTATE_AT_BYTES);
				const after = await opened.handle.stat();
				if (
					!sameIdentity(after, opened.stats) ||
					after.size !== opened.stats.size ||
					after.size > ROTATE_AT_BYTES
				) {
					throw new Error("The secret audit generation changed or grew beyond its read limit.");
				}
				await assertPathIdentity(filePath, after);
				return decodeLog(bytes.toString("utf8"));
			} finally {
				await opened.handle.close();
			}
		} catch (error) {
			if (isEnoent(error)) return { records: [], malformed: 0 };
			throw new Error(
				`The secret audit log at ${escapeTerminalText(filePath)} could not be read safely ` +
					`(${escapeTerminalText(String(error))}).`,
			);
		}
	}
}
