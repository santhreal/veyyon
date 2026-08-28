import type { AssistantMessage, ServiceTier, ServiceTierByFamily, StopReason, Usage } from "@veyyon/ai";
import type { AgentType } from "./shared-types";

export * from "./shared-types";

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

export interface RequestDetails extends MessageStats {
	messages: unknown[];
	output: unknown;
}

export interface SessionLogHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	title?: string;
}

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

export type SessionLogEntry = SessionLogHeader | SessionMessageEntry | SessionServiceTierChangeEntry | { type: string };

export type { SessionLogEntry as SessionEntry };

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

export interface UserMessageLink {
	sessionFile: string;
	entryId: string;
	model: string;
	provider: string;
}

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

export interface ToolResultLink {
	sessionFile: string;
	toolCallId: string;
	resultChars: number;
	isError: boolean;
}
