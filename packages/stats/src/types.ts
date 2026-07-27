import type { AssistantMessage, ServiceTier, ServiceTierByFamily, StopReason, Usage } from "@veyyon/ai";
import type { AgentType } from "./shared-types";

export * from "./shared-types";

/**
 * Extracted stats from an assistant message.
 */
export interface MessageStats {
	/** Database ID */
	id?: number;
	/** Session file path */
	sessionFile: string;
	/** Entry ID within the session */
	entryId: string;
	/** Folder/project path (extracted from session filename) */
	folder: string;
	/** Model ID */
	model: string;
	/** Provider name */
	provider: string;
	/** API type */
	api: string;
	/** Unix timestamp in milliseconds */
	timestamp: number;
	/** Request duration in milliseconds */
	duration: number | null;
	/** Time to first token in milliseconds */
	ttft: number | null;
	/** Stop reason */
	stopReason: StopReason;
	/** Error message if stopReason is error */
	errorMessage: string | null;
	/** Token usage */
	usage: Usage;
	/** Which agent produced this message (main agent, task subagent, advisor) */
	agentType: AgentType;
}

/**
 * Full details of a request, including content.
 */
export interface RequestDetails extends MessageStats {
	/** The full conversation history or just the last turn. */
	messages: unknown[];
	/** The model's response. */
	output: unknown;
}

/**
 * The first line of a session JSONL log, as this parser reads it.
 *
 * One of three types that were all called `SessionHeader`. The writer's own is
 * `SessionHeader` in `@veyyon/coding-agent/session/session-entries` and carries `titleSource`,
 * `parentSession` and `providerPromptCacheKey` besides these; `WireSessionHeader` in
 * `@veyyon/wire` is the four fields a collab guest receives.
 */
export interface SessionLogHeader {
	type: "session";
	/**
	 * Schema version, ABSENT on v1 sessions.
	 *
	 * Typed as required here while the writer declares `version?: number // v1 sessions don't have
	 * this`, so a v1 header parsed through this type presented a `number` that is `undefined` at
	 * runtime -- the one field where the two copies disagreed, and disagreed in the direction that
	 * hands a caller a value the file does not contain. Nothing in this package reads it yet, which
	 * is why it never surfaced; anything that starts reading it must handle the absence.
	 */
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	title?: string;
}

/**
 * The old name for {@link SessionLogHeader}, kept because this package is published.
 *
 * Deprecated: import `SessionLogHeader`. A renamed export rather than an alias declaration, so the
 * name keeps exactly one declaration repo-wide.
 */
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

/**
 * One line of a session JSONL log as the stats parser sees it.
 *
 * Deliberately tolerant: the `{ type: string }` arm keeps a line the parser has no
 * interest in from being a parse failure, which is why this is NOT the session's own
 * entry union (`SessionEntry` in `@veyyon/agent-core/compaction/entries`) nor the
 * guest-renderable subset (`WireSessionEntry` in `@veyyon/wire`). All three were spelled
 * `SessionEntry`, and this one is the widest of them: it admits any object with a `type`,
 * so a value from here typechecks in places that then read fields it has no promise of.
 */
export type SessionLogEntry = SessionLogHeader | SessionMessageEntry | SessionServiceTierChangeEntry | { type: string };

/**
 * The old name for {@link SessionLogEntry}, kept because this package is published.
 *
 * Deprecated: import `SessionLogEntry`. A renamed export rather than an alias declaration,
 * so the name keeps exactly one declaration repo-wide.
 */
export type { SessionLogEntry as SessionEntry };

/**
 * Behavioral stats extracted from a single user message.
 */
export interface UserMessageStats {
	/** Database ID */
	id?: number;
	/** Session file path */
	sessionFile: string;
	/** Entry ID within the session */
	entryId: string;
	/** Folder/project path */
	folder: string;
	/** Unix timestamp in ms */
	timestamp: number;
	/** Model that responded to this user message, if linked */
	model: string | null;
	/** Provider that responded to this user message, if linked */
	provider: string | null;
	/** Total characters of message text */
	chars: number;
	/** Whitespace-delimited word count */
	words: number;
	/** Yelling sentences (> 50% uppercase letters) */
	yelling: number;
	/** Profanity hits */
	profanity: number;
	/** Catch-all upset signal: drama runs + `noooo`/`ughh`/... + `dude` + `:(` */
	anguish: number;
	/** Corrective negation ("no", "nope", "thats not what i meant") */
	negation: number;
	/** User repeating themselves ("i meant", "still doesnt work", "like i said") */
	repetition: number;
	/** Second-person reproach ("you didnt", "why did you", "stop X-ing") */
	blame: number;
}

/**
 * Pair emitted by the parser when it sees an assistant message whose
 * `parentId` points to a user message that wasn't parsed in the same pass
 * (e.g. user prompt landed in an earlier incremental sync). The aggregator
 * applies the link to the persisted `user_messages` row so it stops showing
 * up in the "unknown" model bucket.
 */
export interface UserMessageLink {
	sessionFile: string;
	entryId: string;
	model: string;
	provider: string;
}

/**
 * One tool call extracted from an assistant message's `toolCall` content
 * blocks. `callsInTurn` records how many calls that assistant turn contained
 * so aggregation can split the turn's real provider usage evenly per call.
 */
export interface ToolCallStats {
	/** Session file path */
	sessionFile: string;
	/** Assistant-message entry ID that emitted the call */
	entryId: string;
	/** Provider-assigned tool call ID (unique within a session) */
	toolCallId: string;
	/** Folder/project path (extracted from session filename) */
	folder: string;
	/** Tool name */
	toolName: string;
	/** Model that emitted the call */
	model: string;
	/** Provider name */
	provider: string;
	/** Assistant-message timestamp (Unix ms) */
	timestamp: number;
	/** Which agent produced the call */
	agentType: AgentType;
	/** Total tool calls in the same assistant turn (>= 1) */
	callsInTurn: number;
	/** Serialized argument characters */
	argsChars: number;
}

/**
 * Result linkage emitted when the parser sees a `toolResult` message entry.
 * Applied as an UPDATE on the persisted tool-call row — results can land in a
 * later incremental sync pass than the call that produced them.
 */
export interface ToolResultLink {
	sessionFile: string;
	toolCallId: string;
	/** Text characters fed back into context */
	resultChars: number;
	isError: boolean;
}
