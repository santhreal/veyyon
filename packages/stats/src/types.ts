import type { AssistantMessage, ServiceTier, ServiceTierByFamily, StopReason, Usage } from "@veyyon/ai";
import type { AgentType } from "./shared-types";

export * from "./shared-types";

/** Extracted stats from an assistant message. */
export interface MessageStats {
	id?: number;
	sessionFile: string;
	entryId: string;
	folder: string;
	model: string;
	provider: string;
	api: string;
	timestamp: number;
	duration: number | null;
	ttft: number | null;
	stopReason: StopReason;
	errorMessage: string | null;
	usage: Usage;
	agentType: AgentType;
}

/** Full details of a request, including content. */
export interface RequestDetails extends MessageStats {
	/** The full conversation history or just the last turn. */
	messages: unknown[];
	/** The model's response. */
	output: unknown;
}

/** First line of a session JSONL log. */
export interface SessionLogHeader {
	type: "session";
	/** Schema version. */
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	title?: string;
}

/** Deprecated alias for SessionLogHeader. */
export type { SessionLogHeader as SessionHeader };

export interface SessionMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: AssistantMessage | { role: "user" | "toolResult" };
}

export interface SessionServiceTierChangeEntry {
	type: "service_tier_change";
	id: string;
	parentId?: string | null;
	timestamp: string;
	serviceTier: ServiceTierByFamily | ServiceTier | null;
}

/** One line of a session JSONL log as the stats parser sees it. */
export type SessionLogEntry = SessionLogHeader | SessionMessageEntry | SessionServiceTierChangeEntry | { type: string };

/** Deprecated alias for SessionLogEntry. */
export type { SessionLogEntry as SessionEntry };

/** Behavioral stats extracted from a single user message. */
export interface UserMessageStats {
	id?: number;
	sessionFile: string;
	entryId: string;
	folder: string;
	timestamp: number;
	model: string | null;
	provider: string | null;
	chars: number;
	words: number;
	yelling: number;
	profanity: number;
	anguish: number;
	negation: number;
	repetition: number;
	blame: number;
}

/** Pair emitted by parser for linking user messages. */
export interface UserMessageLink {
	sessionFile: string;
	entryId: string;
	model: string;
	provider: string;
}

/** One tool call extracted from assistant message toolCall blocks. */
export interface ToolCallStats {
	sessionFile: string;
	entryId: string;
	toolCallId: string;
	folder: string;
	toolName: string;
	model: string;
	provider: string;
	timestamp: number;
	agentType: AgentType;
	callsInTurn: number;
	argsChars: number;
}

/** Result linkage emitted for toolResult message entry. */
export interface ToolResultLink {
	sessionFile: string;
	toolCallId: string;
	resultChars: number;
	isError: boolean;
}
