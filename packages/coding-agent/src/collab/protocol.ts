import type { Usage as AgentUsage, ImageContent, Model } from "@veyyon/ai";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import type {
	BusChannel,
	CollabUiRequest,
	GuestFrame,
	ParsedCollabLink,
	Participant,
	SessionState,
	AgentEvent as WireAgentEvent,
	AgentSnapshot as WireAgentSnapshot,
	WireAssistantMessage,
	ContextUsage as WireContextUsage,
	WireMessage,
	WireModel,
	WireSessionEntry,
	WireSessionHeader,
	WireUsage,
} from "@veyyon/wire";
import {
	DEFAULT_RELAY_URL,
	ENVELOPE_HEADER_LENGTH,
	ROOM_ID_BYTES,
	ROOM_KEY_BYTES,
	WRITE_TOKEN_BYTES,
} from "@veyyon/wire";

import type { AgentSessionEvent } from "../session/agent-session";
import type { SessionEntry, SessionHeader, SessionMessageEntry } from "../session/session-entries";

export type {
	CollabPromptDetails,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	CollabUiSelectItem,
	ParsedCollabLink,
	RelayControlMessage,
	RelayControlToGuest,
	RelayControlToHost,
} from "@veyyon/wire";
export { COLLAB_PROMPT_MESSAGE_TYPE, COLLAB_PROTO } from "@veyyon/wire";
export { DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH, ROOM_ID_BYTES };

export type CollabParticipant = Participant;
export type AgentSnapshot = WireAgentSnapshot;

export function toWireSessionHeader(header: SessionHeader): WireSessionHeader {
	return { type: "session", id: header.id, title: header.title, timestamp: header.timestamp, cwd: header.cwd };
}

function toWireUsage(usage: AgentUsage): WireUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: { total: usage.cost.total },
	};
}

function toWireMessage(message: SessionMessageEntry["message"]): WireMessage {
	switch (message.role) {
		case "user":
			return {
				role: "user",
				content: message.content,
				synthetic: message.synthetic,
				timestamp: message.timestamp,
			};
		case "developer":
			return { role: "developer", content: message.content, timestamp: message.timestamp };
		case "assistant":
			return {
				role: "assistant",
				content: message.content as WireAssistantMessage["content"],
				model: message.model,
				provider: message.provider,
				usage: toWireUsage(message.usage),
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
				timestamp: message.timestamp,
			};
		case "toolResult":
			return {
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: message.content,
				details: message.details,
				isError: message.isError,
				timestamp: message.timestamp,
			};
		case "bashExecution":
			return {
				role: "bashExecution",
				command: message.command,
				output: message.output,
				exitCode: message.exitCode,
				signal: message.signal,
				cancelled: message.cancelled,
				truncated: message.truncated,
				meta: message.meta,
				excludeFromContext: message.excludeFromContext,
				timestamp: message.timestamp,
			};
		case "pythonExecution":
			return {
				role: "pythonExecution",
				code: message.code,
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				truncated: message.truncated,
				meta: message.meta,
				excludeFromContext: message.excludeFromContext,
				timestamp: message.timestamp,
			};
		case "custom":
		case "hookMessage":
			return {
				role: message.role,
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				timestamp: message.timestamp,
			};
		case "branchSummary":
			return {
				role: "branchSummary",
				summary: message.summary,
				fromId: message.fromId,
				timestamp: message.timestamp,
			};
		case "compactionSummary":
			return {
				role: "compactionSummary",
				summary: message.summary,
				shortSummary: message.shortSummary,
				tokensBefore: message.tokensBefore,
				warning: message.warning,
				timestamp: message.timestamp,
			};
		case "fileMention":
			return {
				role: "fileMention",
				files: message.files.map(file => ({
					path: file.path,
					hasContent: file.content.length > 0,
					lineCount: file.lineCount,
					byteSize: file.byteSize,
					skippedReason: file.skippedReason,
					image: file.image,
				})),
				timestamp: message.timestamp,
			};
	}
}

export function toWireSessionEntry(entry: SessionEntry): WireSessionEntry | undefined {
	const base = { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp };
	switch (entry.type) {
		case "message":
			return { ...base, type: "message", message: toWireMessage(entry.message) };
		case "custom_message":
			return {
				...base,
				type: "custom_message",
				customType: entry.customType,
				content: entry.content,
				details: entry.details,
				display: entry.display,
			};
		case "compaction":
			return {
				...base,
				type: "compaction",
				summary: entry.summary,
				shortSummary: entry.shortSummary,
				firstKeptEntryId: entry.firstKeptEntryId,
				tokensBefore: entry.tokensBefore,
			};
		case "branch_summary":
			return { ...base, type: "branch_summary", fromId: entry.fromId, summary: entry.summary };
		case "model_change":
			return { ...base, type: "model_change", model: entry.model, role: entry.role };
		case "thinking_level_change":
			return { ...base, type: "thinking_level_change", thinkingLevel: entry.thinkingLevel };
		default:
			return undefined;
	}
}

export function toWireAgentEvent(event: AgentSessionEvent): WireAgentEvent | undefined {
	switch (event.type) {
		case "agent_start":
		case "agent_end":
		case "turn_start":
		case "turn_end":
			return { type: event.type };
		case "message_start":
		case "message_update":
		case "message_end":
			return { type: event.type, message: toWireMessage(event.message) };
		case "tool_execution_start":
			return {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
			};
		case "tool_execution_update":
			return {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
		case "tool_execution_end":
			return {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
		case "notice":
			return { type: "notice", level: event.level, message: event.message, source: event.source };
		case "auto_compaction_start":
			return { type: "auto_compaction_start", reason: event.reason, action: event.action };
		case "auto_compaction_end":
			return {
				type: "auto_compaction_end",
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
				skipped: event.skipped,
			};
		case "auto_retry_start":
			return {
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
				mode: event.mode,
			};
		case "auto_retry_end":
			return {
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
				mode: event.mode,
			};
		case "thinking_level_changed":
			return { type: "thinking_level_changed", thinkingLevel: event.thinkingLevel };
		default:
			return undefined;
	}
}

export function fromWireSessionEntry(entry: WireSessionEntry): SessionEntry {
	if (entry.type === "message" && entry.message.role === "fileMention") {
		return {
			...entry,
			message: {
				...entry.message,
				files: entry.message.files.map(file => ({
					...file,
					content: "",
					contentNotReplicated: file.hasContent,
				})),
			},
		} as unknown as SessionEntry;
	}
	if (entry.type !== "message" || entry.message.role !== "assistant") return entry as SessionEntry;
	return {
		...entry,
		message: { ...entry.message, api: WIRE_API_UNREPORTED },
	} as unknown as SessionEntry;
}

export const WIRE_API_UNREPORTED = "unreported-over-wire";

export function fromWireAgentEvent(event: WireAgentEvent): AgentSessionEvent {
	if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") {
		return event as AgentSessionEvent;
	}
	if (event.message.role !== "assistant") return event as AgentSessionEvent;
	return {
		...event,
		message: { ...event.message, api: WIRE_API_UNREPORTED },
	} as unknown as AgentSessionEvent;
}

export const WIRE_MODEL_NO_ENDPOINT = "collab-guest://no-provider-endpoint";

export const WIRE_MODEL_API_UNREPORTED = "unreported-over-wire";

export function toWireModel(model: Model): WireModel {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		contextWindow: model.contextWindow,
		reasoning: model.reasoning,
		thinking: model.thinking
			? {
					mode: model.thinking.mode,
					efforts: model.thinking.efforts.slice(),
					defaultLevel: model.thinking.defaultLevel,
				}
			: undefined,
	};
}

export function fromWireModel(model: WireModel): Model {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider as Model["provider"],
		contextWindow: model.contextWindow,
		reasoning: model.reasoning ?? false,
		thinking: model.thinking
			? {
					mode: model.thinking.mode as NonNullable<Model["thinking"]>["mode"],
					efforts: model.thinking.efforts as NonNullable<Model["thinking"]>["efforts"],
					defaultLevel: model.thinking.defaultLevel as NonNullable<Model["thinking"]>["defaultLevel"],
				}
			: undefined,
		api: WIRE_MODEL_API_UNREPORTED as Model["api"],
		baseUrl: WIRE_MODEL_NO_ENDPOINT,
		input: ["text"],
		maxTokens: null,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		pricing: "unknown",
		compat: {} as Model["compat"],
	};
}

export type CollabSessionState = SessionState & {
	model?: WireModel;
	contextUsage?: WireContextUsage;
};

export function contextUsageFrame(breakdown: { usedTokens: number | null; contextWindow: number }): WireContextUsage {
	const { usedTokens, contextWindow } = breakdown;
	return {
		tokens: usedTokens,
		contextWindow,
		percent: usedTokens === null ? null : contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0,
	};
}

export type CollabFrame =
	| Exclude<GuestFrame, { t: "prompt" }>
	| { t: "prompt"; text: string; images?: ImageContent[] }
	| {
			t: "welcome";
			proto: number;
			header: WireSessionHeader;
			state: CollabSessionState;
			agents: AgentSnapshot[];
			entryCount: number;
			readOnly?: boolean;
	  }
	| { t: "snapshot-chunk"; entries: WireSessionEntry[]; final: boolean }
	| { t: "entry"; entry: WireSessionEntry }
	| { t: "event"; event: WireAgentEvent }
	| { t: "state"; state: CollabSessionState }
	| { t: "bus"; channel: BusChannel; data: unknown }
	| { t: "agents"; agents: AgentSnapshot[] }
	| { t: "ui-request"; request: CollabUiRequest }
	| { t: "ui-request-end"; reqId: number }
	| { t: "transcript"; reqId: number; text: string; newSize: number; error?: string }
	| { t: "bye"; reason: string }
	| { t: "error"; message: string };

export { packEnvelope, rewriteEnvelopePeer, unpackEnvelope } from "@veyyon/wire";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const LOCAL_HOSTNAMES: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

function isLocalHostname(hostname: string): boolean {
	return LOCAL_HOSTNAMES[hostname] === true;
}

export function generateRoomId(): string {
	const bytes = new Uint8Array(ROOM_ID_BYTES);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

function normalizeRelayOrigin(relayUrl: string): { origin: string } | { error: string } {
	let url: URL;
	try {
		url = new URL(relayUrl);
	} catch {
		return { error: `Invalid relay URL: ${relayUrl}` };
	}
	let scheme: string;
	switch (url.protocol) {
		case "wss:":
		case "https:":
			scheme = "wss:";
			break;
		case "ws:":
		case "http:":
			scheme = "ws:";
			break;
		default:
			return { error: `Unsupported relay URL scheme: ${url.protocol}` };
	}
	if (scheme === "ws:" && !isLocalHostname(url.hostname)) {
		return { error: "relay link must be wss:// (plain ws:// is only allowed for localhost)" };
	}
	const port = url.port ? `:${url.port}` : "";
	return { origin: `${scheme}//${url.hostname}${port}` };
}

function formatCollabLinkPayload(
	relayUrl: string,
	roomId: string,
	key: Uint8Array,
	writeToken: Uint8Array | undefined,
	joiner: string,
): string {
	const normalized = normalizeRelayOrigin(relayUrl);
	if ("error" in normalized) throw new Error(normalized.error);
	const secret = writeToken ? Buffer.concat([key, writeToken]) : Buffer.from(key);
	const keyText = secret.toString("base64url");
	if (normalized.origin === DEFAULT_RELAY_URL) return `${roomId}.${keyText}`;
	const compact = normalized.origin.startsWith("wss://")
		? normalized.origin.slice("wss://".length)
		: normalized.origin;
	return `${compact}/r/${roomId}${joiner}${keyText}`;
}

export function formatCollabLink(relayUrl: string, roomId: string, key: Uint8Array, writeToken?: Uint8Array): string {
	return formatCollabLinkPayload(relayUrl, roomId, key, writeToken, "#");
}

function normalizeCollabWebBaseUrl(relayUrl: string, webUrl?: string): string {
	const explicitWebUrl = webUrl?.trim();
	if (!explicitWebUrl) {
		const normalized = normalizeRelayOrigin(relayUrl);
		if ("error" in normalized) throw new Error(normalized.error);
		return normalized.origin.startsWith("wss://")
			? `https://${normalized.origin.slice("wss://".length)}`
			: `http://${normalized.origin.slice("ws://".length)}`;
	}

	let url: URL;
	try {
		url = new URL(explicitWebUrl);
	} catch {
		throw new Error("collab.webUrl must start with http:// or https://");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("collab.webUrl must start with http:// or https://");
	}
	if (url.protocol === "http:" && !isLocalHostname(url.hostname)) {
		throw new Error("collab.webUrl must use https:// unless it targets localhost");
	}
	if (url.search || url.hash) {
		throw new Error("collab.webUrl must not include a query string or fragment");
	}
	const path = trimTrailingSlashes(url.pathname);
	return `${url.origin}${path}`;
}

export function formatCollabWebLink(
	relayUrl: string,
	roomId: string,
	key: Uint8Array,
	writeToken?: Uint8Array,
	webUrl?: string,
): string {
	const payload = formatCollabLinkPayload(relayUrl, roomId, key, writeToken, ".");
	return `${normalizeCollabWebBaseUrl(relayUrl, webUrl)}/#${payload}`;
}

export function parseCollabLink(link: string): ParsedCollabLink | { error: string } {
	let text = link.trim().replace(/%23/gi, "#");
	const bare = BARE_LINK_RE.exec(text);
	if (bare) text = `${DEFAULT_RELAY_URL}/r/${bare[1]}.${bare[2]}`;
	else if (!text.includes("://")) text = `wss://${text}`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { error: `Invalid collab link: ${link}` };
	}
	if ((url.protocol === "http:" || url.protocol === "https:") && url.hash) {
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		const parsed = parseCollabLink(inner);
		if (!("error" in parsed)) return parsed;
	}
	const normalized = normalizeRelayOrigin(url.origin);
	if ("error" in normalized) return normalized;
	const match = ROOM_PATH_RE.exec(url.pathname);
	if (!match) {
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		if (inner && url.protocol !== "http:" && url.protocol !== "https:") return parseCollabLink(inner);
		return { error: "Collab link must contain a /r/<roomId> path" };
	}
	const roomId = match[1]!;
	const fragment = match[2] ?? (url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
	if (!fragment) {
		return { error: "Collab link is missing the <key> part" };
	}
	const secret = B64URL_RE.test(fragment) ? new Uint8Array(Buffer.from(fragment, "base64url")) : null;
	if (!secret || (secret.byteLength !== ROOM_KEY_BYTES && secret.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES)) {
		return { error: "Collab link key must be 32 (view) or 48 (full) base64url bytes" };
	}
	const key = secret.subarray(0, ROOM_KEY_BYTES);
	const writeToken = secret.byteLength > ROOM_KEY_BYTES ? secret.subarray(ROOM_KEY_BYTES) : undefined;
	return { wsUrl: `${normalized.origin}/r/${roomId}`, roomId, key, writeToken };
}
