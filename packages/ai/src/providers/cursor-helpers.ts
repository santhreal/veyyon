import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { fromBinary, type JsonValue, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { ConversationStateStructure, CursorRule } from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import { CURSOR_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { $env } from "@veyyon/utils/env";
import { parseJsonWithRepair } from "@veyyon/utils/json-parse";
import * as AIError from "../error";
import type { CursorExecHandlers, CursorRuleInput, CursorToolResultHandler, StreamOptions } from "../types";

export const CURSOR_API_URL = CURSOR_API_ENDPOINT;
export const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";

export const CURSOR_PROXY_TUNNEL_TIMEOUT_MS = 30_000;

export class BoundedLruMap<K, V> {
	readonly #max: number;
	readonly #map = new Map<K, V>();
	constructor(max: number) {
		this.#max = max;
	}
	get(key: K): V | undefined {
		const value = this.#map.get(key);
		if (value !== undefined && this.#map.delete(key)) this.#map.set(key, value);
		return value;
	}
	set(key: K, value: V): void {
		this.#map.delete(key);
		this.#map.set(key, value);
		while (this.#map.size > this.#max) {
			const oldest = this.#map.keys().next().value;
			if (oldest === undefined) break;
			this.#map.delete(oldest);
		}
	}
}

export const CURSOR_CONVERSATION_CACHE_MAX = 128;
export const conversationStateCache = new BoundedLruMap<string, ConversationStateStructure>(
	CURSOR_CONVERSATION_CACHE_MAX,
);
export const conversationBlobStores = new BoundedLruMap<string, Map<string, Uint8Array>>(CURSOR_CONVERSATION_CACHE_MAX);
export const conversationRulesDelivered = new BoundedLruMap<string, string>(CURSOR_CONVERSATION_CACHE_MAX);

export function cursorRulesFingerprint(rules: readonly CursorRule[]): string {
	const hash = createHash("sha256");
	for (const rule of rules) {
		hash.update(rule.fullPath);
		hash.update("\u0000");
		hash.update(rule.content);
		hash.update("\u0000");
	}
	return hash.digest("hex");
}

export interface CursorOptions extends StreamOptions {
	customSystemPrompt?: string;
	execHandlers?: CursorExecHandlers;
	onToolResult?: CursorToolResultHandler;
	cursorRules?: CursorRuleInput[];
	wireModelId?: string;
}

export const CONNECT_END_STREAM_FLAG = 0b00000010;

export const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;

export interface CursorLogEntry {
	ts: number;
	type: string;
	subtype?: string;
	data?: unknown;
}

export async function appendCursorDebugLog(entry: CursorLogEntry): Promise<void> {
	const logPath = $env.DEBUG_CURSOR_LOG;
	if (!logPath) return;
	try {
		await fs.appendFile(logPath, `${JSON.stringify(entry, debugReplacer)}\n`);
	} catch {}
}

export function log(type: string, subtype?: string, data?: unknown): void {
	if (!$env.DEBUG_CURSOR) return;
	const normalizedData = data ? decodeLogData(data) : data;
	const entry: CursorLogEntry = { ts: Date.now(), type, subtype, data: normalizedData };
	const verbose = $env.DEBUG_CURSOR === "2" || $env.DEBUG_CURSOR === "verbose";
	const dataStr = verbose && normalizedData ? ` ${JSON.stringify(normalizedData, debugReplacer)?.slice(0, 500)}` : "";
	console.error(`[CURSOR] ${type}${subtype ? `: ${subtype}` : ""}${dataStr}`);
	void appendCursorDebugLog(entry);
}

export function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

export function cursorStreamFailure(code: string, message: string, label: string): Error {
	const text = `${label} ${code}: ${AIError.boundProviderErrorDetail(message)}`;
	const failureStatus = AIError.connectFailureStatus({ code, message });
	if (failureStatus !== undefined) return new AIError.CursorApiError(text, failureStatus);
	return new AIError.ProviderResponseError(text, { provider: "cursor", kind: "envelope" });
}

export function parseConnectEndStream(data: Uint8Array): Error | null {
	try {
		const payload = JSON.parse(new TextDecoder().decode(data));
		const error = payload?.error;
		if (error) {
			const code = typeof error.code === "string" ? error.code : "unknown";
			const message = typeof error.message === "string" ? error.message : "Unknown error";
			return cursorStreamFailure(code, message, "Connect error");
		}
		return null;
	} catch {
		return new AIError.ProviderResponseError("Failed to parse Connect end stream", {
			provider: "cursor",
			kind: "incomplete-stream",
		});
	}
}

export function debugBytes(bytes: Uint8Array, asHex: boolean): string {
	if (asHex) {
		return Buffer.from(bytes).toString("hex");
	}
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (/^[\x20-\x7E\s]*$/.test(text)) return text;
	} catch {}
	return Buffer.from(bytes).toString("hex");
}

export function debugReplacer(key: string, value: unknown): unknown {
	if (
		value instanceof Uint8Array ||
		(value && typeof value === "object" && "type" in value && value.type === "Buffer" && "data" in value)
	) {
		const bytes = value instanceof Uint8Array ? value : new Uint8Array((value as { data: ArrayLike<number> }).data);
		const asHex = key === "blobId" || key === "blob_id" || key.endsWith("Id") || key.endsWith("_id");
		return debugBytes(bytes, asHex);
	}
	if (typeof value === "bigint") return value.toString();
	return value;
}

export function extractLogBytes(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) {
		return value;
	}
	if (value && typeof value === "object" && "type" in value && value.type === "Buffer") {
		const data = (value as { data?: number[] }).data;
		if (Array.isArray(data)) {
			return new Uint8Array(data);
		}
	}
	return null;
}

export function parseToolArgsJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) {
		return text;
	}
	try {
		return parseJsonWithRepair<unknown>(trimmed);
	} catch {
		return text;
	}
}

export function decodeMcpArgValue(value: Uint8Array): unknown {
	try {
		const parsedValue = fromBinary(ValueSchema, value);
		const jsonValue = toJson(ValueSchema, parsedValue) as JsonValue;
		if (typeof jsonValue === "string") {
			return parseToolArgsJson(jsonValue);
		}
		return jsonValue;
	} catch {}
	const text = new TextDecoder().decode(value);
	return parseToolArgsJson(text);
}

function decodeMcpArgsForLog(args?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!args) {
		return undefined;
	}
	let mutated = false;
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		const bytes = extractLogBytes(value);
		if (bytes) {
			decoded[key] = decodeMcpArgValue(bytes);
			mutated = true;
			continue;
		}
		const normalizedValue = decodeLogData(value);
		decoded[key] = normalizedValue;
		if (normalizedValue !== value) {
			mutated = true;
		}
	}
	return mutated ? decoded : args;
}

export function decodeLogData(value: unknown): unknown {
	if (!value || typeof value !== "object") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(entry => decodeLogData(entry));
	}
	const record = value as Record<string, unknown>;
	const typeName = record.$typeName;
	const stripTypeName = typeof typeName === "string" && typeName.startsWith("agent.v1.");

	if (typeName === "agent.v1.McpArgs") {
		const decodedArgs = decodeMcpArgsForLog(record.args as Record<string, unknown> | undefined);
		const base = stripTypeName ? omitTypeName(record) : record;
		return decodedArgs ? { ...base, args: decodedArgs } : base;
	}
	if (typeName === "agent.v1.McpToolCall") {
		const argsRecord = record.args as Record<string, unknown> | undefined;
		const decodedArgs = decodeMcpArgsForLog(argsRecord?.args as Record<string, unknown> | undefined);
		const base = stripTypeName ? omitTypeName(record) : record;
		if (decodedArgs && argsRecord) {
			return { ...base, args: { ...argsRecord, args: decodedArgs } };
		}
		return base;
	}

	let mutated = stripTypeName;
	const decoded: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (stripTypeName && key === "$typeName") {
			continue;
		}
		const normalizedEntry = decodeLogData(entry);
		decoded[key] = normalizedEntry;
		if (normalizedEntry !== entry) {
			mutated = true;
		}
	}
	return mutated ? decoded : record;
}

export function omitTypeName(record: Record<string, unknown>): Record<string, unknown> {
	const { $typeName: _, ...rest } = record;
	return rest;
}
