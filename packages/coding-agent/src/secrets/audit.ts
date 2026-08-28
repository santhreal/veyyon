import { constants as fsConstants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	applyOwnerOnlyWindowsAcl,
	clamp,
	errorMessage,
	escapeTerminalText,
	isEnoent,
	isRecord,
	verifyOwnerOnlyWindowsAcl,
	withFileLock,
} from "@veyyon/utils";
import type { OperatorNotices } from "../session/operator-notices";
import { PLACEHOLDER_RE } from "./placeholder";
import type { VaultLocations } from "./vault";

export const SECRET_AUDIT_FILENAME = "secret-audit.jsonl";

export const MAX_RECORD_BYTES = 2048;

export const MAX_COMMAND_CHARS = 1200;
export const MAX_RECORDED_SECRETS = 16;
export const MAX_SECRET_JSON_BYTES = 128;
export const MAX_METADATA_JSON_BYTES = 256;
export const MAX_FIELD_CHARS = MAX_RECORD_BYTES;
export const MAX_AUDIT_DEPTH = 24;
export const MAX_AUDIT_NODES = 512;
export const MAX_PLACEHOLDER_CANDIDATES = 4096;
export const MAX_SCANNED_STRING_BYTES = 256 * 1024;
export const MAX_TOTAL_SCANNED_STRING_BYTES = 512 * 1024;
export const MAX_SNAPSHOT_STRING_BYTES = 4096;
export const MAX_SNAPSHOT_NODES = 128;
export const MAX_DECODE_LINES = 32_768;
export const MAX_DECODE_RECORDS = 32_768;
export const MAX_PENDING_RECORDS = 128;
export const MAX_PENDING_BYTES = MAX_PENDING_RECORDS * MAX_RECORD_BYTES;

export const ROTATE_AT_BYTES = 2 * 1024 * 1024;

export const ROTATED_SUFFIX = ".1";

export interface SecretExpansionRecord {
	at: number;
	secrets: string[];
	omittedSecrets?: number;
	tool: string;
	session?: string;
	command: string;
	truncated?: true;
}

export function secretAuditPath(locations: VaultLocations): string {
	return path.join(locations.profileDir, SECRET_AUDIT_FILENAME);
}

export function placeholdersIn(value: unknown, known: (placeholder: string) => boolean): string[] {
	return inspectAuditValue(value, known, text => text, false).secrets;
}

export type InertSnapshot =
	| null
	| boolean
	| number
	| string
	| { kind: "array"; items: InertSnapshot[]; omitted: number }
	| { kind: "object"; entries: Array<[string, InertSnapshot]>; omitted: number };

export interface InspectionState {
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

export interface InspectionResult {
	secrets: string[];
	snapshot: InertSnapshot;
	truncated: boolean;
}

export interface PendingInspection {
	value: unknown;
	depth: number;
	capture: boolean;
	assign: (value: InertSnapshot) => void;
}

export function inspectAuditValue(
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

export function inspectText(value: string, state: InspectionState): string {
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

export function protectMetadata(value: string, obfuscate: (value: string) => string): string {
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

export function stringifySnapshot(value: InertSnapshot): string {
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

export function assertEncodableRecord(record: SecretExpansionRecord): void {
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

export function serialiseRecord(record: SecretExpansionRecord): string {
	return `${JSON.stringify(record)}\n`;
}

export function boundedPrefix(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : prefixWithEllipsis(value, maxChars - 1);
}

export function prefixWithEllipsis(value: string, requestedEnd: number): string {
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

export function capJsonString(value: string, maxBytes: number): string {
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

export function terminalSafeRecord(record: SecretExpansionRecord): SecretExpansionRecord {
	return {
		...record,
		secrets: record.secrets.map(escapeTerminalText),
		tool: escapeTerminalText(record.tool),
		command: escapeTerminalText(record.command),
		...(record.session === undefined ? {} : { session: escapeTerminalText(record.session) }),
	};
}

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

export function isSecretExpansionRecord(value: unknown): value is SecretExpansionRecord {
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

export function assertOwnedRegularFile(filePath: string, stats: Stats): void {
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

// circular import: class moved to helpers
export { SecretAuditLog } from "./audit-helpers";
