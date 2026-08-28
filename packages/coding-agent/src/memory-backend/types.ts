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

	start(options: MemoryBackendStartOptions): void | Promise<void>;

	buildDeveloperInstructions(
		agentDir: string,
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined>;

	buildVolatileContext?(session: AgentSession): Promise<string | undefined>;

	clear(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

	enqueue(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

	status?(context: MemoryBackendOperationContext): Promise<MemoryBackendStatus>;

	search?(
		context: MemoryBackendOperationContext,
		query: string,
		options?: MemoryBackendSearchOptions,
	): Promise<MemoryBackendSearchResult>;

	save?(context: MemoryBackendOperationContext, input: MemoryBackendSaveInput): Promise<MemoryBackendSaveResult>;

	stats?(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined>;

	diagnose?(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined>;
	beforeAgentStartPrompt?(session: AgentSession, promptText: string): Promise<string | undefined>;

	preCompactionContext?(
		messages: AgentMessage[],
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined>;
}
