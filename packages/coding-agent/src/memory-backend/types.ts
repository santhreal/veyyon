/** Memory backend abstraction. Backends are mutually exclusive — `await resolveMemoryBackend(settings)` returns */

import type { AgentMessage } from "@veyyon/agent-core";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { HindsightSessionState } from "../hindsight/state";
import type { MnemopiSessionState } from "../mnemopi/state";
import type { AgentSession } from "../session/agent-session";

export type MemoryBackendId = "off" | "local" | "hindsight" | "mnemopi";

export interface MemoryBackendStatus {
	backend: MemoryBackendId;
	active: boolean;
	writable: boolean;
	searchable: boolean;
	scope?: string;
	retainBank?: string;
	recallBanks?: string[];
	workingCount?: number;
	episodicCount?: number;
	tripleCount?: number;
	lastMemory?: string;
	lastRecall?: boolean;
	database?: string;
	message?: string;
	error?: string;
}

export interface MemoryBackendSearchOptions {
	limit?: number;
	/** Best-effort abort signal. Backends may only observe it before/after an underlying recall call. */
	signal?: AbortSignal;
}

export interface MemoryBackendSearchItem {
	id?: string;
	content: string;
	source?: string;
	timestamp?: string;
	score?: number;
}

export interface MemoryBackendSearchResult {
	backend: MemoryBackendId;
	query: string;
	count: number;
	items: MemoryBackendSearchItem[];
	message?: string;
}

export interface MemoryBackendSaveInput {
	content: string;
	context?: string;
	source?: string;
	importance?: number;
}

export interface MemoryBackendSaveResult {
	backend: MemoryBackendId;
	stored: number;
	ids?: string[];
	queued?: boolean;
	message?: string;
}

export interface MemoryBackendOperationContext {
	agentDir: string;
	cwd: string;
	session?: AgentSession;
}

export interface MemoryRuntimeContext {
	status(): Promise<MemoryBackendStatus>;
	search(query: string, options?: MemoryBackendSearchOptions): Promise<MemoryBackendSearchResult>;
	save(input: string | MemoryBackendSaveInput): Promise<MemoryBackendSaveResult>;
}

export interface MemoryBackendStartOptions {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	taskDepth: number;
	parentHindsightSessionState?: HindsightSessionState;
	parentMnemopiSessionState?: MnemopiSessionState;
}

export interface MemoryBackend {
	readonly id: MemoryBackendId;

	/** Wire any background work or session subscriptions for this backend. Called once per agent session at startup. Implementations MUST be */
	start(options: MemoryBackendStartOptions): void | Promise<void>;

	/** Markdown injected as the system-prompt append section. Returned on every prompt rebuild via `refreshBaseSystemPrompt()`. */
	buildDeveloperInstructions(
		agentDir: string,
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined>;

	/** Markdown that changes while the session runs, delivered at the TAIL of the context as a message rather than in the system prompt. */
	buildVolatileContext?(session: AgentSession): Promise<string | undefined>;

	/** Wipe all persisted state for this backend (slash `/memory clear`). */
	clear(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

	/** Force consolidation/retain to happen now (slash `/memory enqueue`). */
	enqueue(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

	/** Structured state for UI, slash commands, and extensions. */
	status?(context: MemoryBackendOperationContext): Promise<MemoryBackendStatus>;

	/** Explicit user-facing semantic/lexical search. */
	search?(
		context: MemoryBackendOperationContext,
		query: string,
		options?: MemoryBackendSearchOptions,
	): Promise<MemoryBackendSearchResult>;

	/** Explicit user-facing save operation. */
	save?(context: MemoryBackendOperationContext, input: MemoryBackendSaveInput): Promise<MemoryBackendSaveResult>;

	/** Render backend-specific memory statistics as markdown (`/memory stats`). */
	stats?(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined>;

	/** Render backend-specific memory diagnostics as markdown (`/memory diagnose`). */
	diagnose?(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined>;
	/** Optional hook to inject a backend-specific block into the current turn's system prompt before the agent starts generating. */
	beforeAgentStartPrompt?(session: AgentSession, promptText: string): Promise<string | undefined>;

	/** Optional hook to splice extra context into a compaction summarization. Called from the compaction call site before the LLM summary is requested. */
	preCompactionContext?(
		messages: AgentMessage[],
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined>;
}
