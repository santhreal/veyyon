/**
 * In-process benchmark client.
 *
 * Replaces RpcClient subprocess spawning with direct AgentSession usage.
 * Eliminates ~2-3s CLI startup overhead per task by creating sessions
 * in-process and sharing auth/model infrastructure across tasks.
 */
import type { AgentEvent, AgentMessage, ResolvedThinkingLevel, ThinkingLevel } from "@veyyon/agent-core";
import type { Model, ToolExample } from "@veyyon/ai";
import type { AgentSession, AgentSessionEvent, AuthStorage, SessionStats } from "@veyyon/coding-agent";
import {
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@veyyon/coding-agent";
import {
	applyPromptOverridesToSystemPrompt,
	loadAndValidateConfigOverlay,
	loadAndValidatePromptOverlay,
} from "./overlays";

export type InProcessEventListener = (event: AgentEvent) => void;

/**
 * One tool as a session reports it, for a conversation dump or a description-token
 * measurement.
 *
 * Declared once here because five call sites had written the same four fields inline —
 * the client, the execution backend, the benchmark runner's two dump types and the
 * prompt bench — and an inline shape is what lets one of them drift a field.
 */
export interface DumpedTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: unknown;
	readonly examples?: readonly ToolExample[];
}

/** What a live in-process session reports about itself. */
export interface InProcessSessionState {
	readonly sessionFile?: string;
	readonly systemPrompt?: string[];
	readonly model?: Model;
	readonly thinkingLevel?: ThinkingLevel | undefined;
	readonly dumpTools?: readonly DumpedTool[];
	readonly settings?: Settings;
}

export interface InProcessClientOptions {
	cwd: string;
	model: string;
	/** Extra system prompt to append */
	appendSystemPrompt?: string;
	/** Tool names to enable */
	tools?: string[];
	/** Edit tool settings (passed via Settings, not env vars) */
	editVariant?: string;
	editFuzzy?: boolean | "auto";
	editFuzzyThreshold?: number | "auto";
	/** Shared infra (pass to avoid re-discovery per task) */
	shared?: SharedInfra;
	/** Path to config overlay file */
	configPath?: string | null;
	/** Path to prompt variant overlay file */
	promptVariantPath?: string | null;
	/** Pre-loaded prompt overrides map */
	promptOverrides?: Record<string, string> | null;
	/** Pre-constructed settings instance */
	settings?: Settings;
}

/** Shared infrastructure that can be reused across tasks. */
export interface SharedInfra {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}

export interface DiscoverSharedInfraOptions {
	cwd?: string;
	editVariant?: string;
	editFuzzy?: boolean | "auto";
	editFuzzyThreshold?: number | "auto";
}

/** Discover shared infrastructure once for the entire benchmark run. */
export async function discoverSharedInfra(_options: DiscoverSharedInfraOptions = {}): Promise<SharedInfra> {
	const authStorage = await discoverAuthStorage();
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		// Do NOT call global Settings.init() here: each trial must create its own isolated Settings
		// instance via Settings.loadIsolated() to avoid cross-trial settings contamination when running concurrently.
		return { authStorage, modelRegistry };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

/**
 * In-process client that wraps AgentSession with the same interface
 * that the benchmark runner expects from RpcClient.
 */
export class InProcessClient {
	#session: AgentSession | null = null;
	#sessionResult: CreateAgentSessionResult | null = null;
	#eventListeners: InProcessEventListener[] = [];
	#unsubscribe: (() => void) | null = null;
	#options: InProcessClientOptions;

	constructor(options: InProcessClientOptions) {
		this.#options = options;
	}

	async start(): Promise<void> {
		// Build settings instance with config overlay and edit overrides if applicable
		let sessionSettings = this.#options.settings;
		if (!sessionSettings) {
			const overrides: Record<string, unknown> = {};
			if (this.#options.configPath) {
				const loaded = await loadAndValidateConfigOverlay(this.#options.configPath, this.#options.cwd);
				Object.assign(overrides, loaded.parsed);
			}
			if (this.#options.editVariant && this.#options.editVariant !== "auto") {
				overrides["edit.mode"] = this.#options.editVariant;
			}
			if (this.#options.editFuzzy !== undefined && this.#options.editFuzzy !== "auto") {
				overrides["edit.fuzzyMatch"] = this.#options.editFuzzy;
			}
			if (this.#options.editFuzzyThreshold !== undefined && this.#options.editFuzzyThreshold !== "auto") {
				overrides["edit.fuzzyThreshold"] = this.#options.editFuzzyThreshold;
			}

			const configFiles = this.#options.configPath ? [this.#options.configPath] : undefined;
			sessionSettings = await Settings.loadIsolated({
				cwd: this.#options.cwd,
				configFiles,
				overrides,
			});
		}
		let promptOverrides = this.#options.promptOverrides;
		if (!promptOverrides && this.#options.promptVariantPath) {
			const loaded = await loadAndValidatePromptOverlay(this.#options.promptVariantPath, this.#options.cwd);
			promptOverrides = loaded.overrides;
		}

		const result = await createAgentSession({
			cwd: this.#options.cwd,
			modelPattern: this.#options.model,
			authStorage: this.#options.shared?.authStorage,
			modelRegistry: this.#options.shared?.modelRegistry,
			settings: sessionSettings,
			sessionManager: SessionManager.inMemory(this.#options.cwd),
			systemPrompt: (defaultPrompt: string[]) => {
				let promptBlocks = defaultPrompt;
				if (promptOverrides && Object.keys(promptOverrides).length > 0) {
					promptBlocks = applyPromptOverridesToSystemPrompt(promptBlocks, promptOverrides);
				}
				if (this.#options.appendSystemPrompt) {
					promptBlocks = [...promptBlocks, this.#options.appendSystemPrompt];
				}
				return promptBlocks;
			},
			toolNames: this.#options.tools ?? ["read", "edit", "write"],
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			rules: [],
			contextFiles: [],
			disableExtensionDiscovery: true,
		});

		this.#sessionResult = result;
		this.#session = result.session;

		// Subscribe to events and forward to listeners
		this.#unsubscribe = this.#session.subscribe((event: AgentSessionEvent) => {
			// Only forward AgentEvent types (not session-specific ones)
			if (isAgentEvent(event)) {
				for (const listener of this.#eventListeners) {
					listener(event);
				}
			}
		});
	}

	async setThinkingLevel(level: ResolvedThinkingLevel): Promise<void> {
		this.#session!.setThinkingLevel(level);
	}

	onEvent(listener: InProcessEventListener): () => void {
		this.#eventListeners.push(listener);
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	async prompt(text: string): Promise<void> {
		await this.#session!.prompt(text, { expandPromptTemplates: false });
		await this.#session!.waitForIdle();
	}

	async followUp(text: string): Promise<void> {
		await this.#session!.followUp(text);
		await this.#session!.waitForIdle();
	}

	abort(): void {
		this.#session?.abort();
	}

	async getSessionStats(): Promise<SessionStats> {
		return this.#session!.getSessionStats();
	}

	async getLastAssistantText(): Promise<string | null> {
		return this.#session!.getLastAssistantText() ?? null;
	}

	async getMessages(): Promise<AgentMessage[]> {
		return this.#session!.messages;
	}

	async getSettings(): Promise<Settings | undefined> {
		return this.#session?.settings;
	}

	async getState(): Promise<InProcessSessionState> {
		const session = this.#session!;
		return {
			sessionFile: undefined,
			systemPrompt: session.systemPrompt,
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			dumpTools: session.agent.state.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				examples: tool.examples,
			})),
			settings: session.settings,
		};
	}

	async dispose(): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		if (this.#session) {
			await this.#session.dispose();
			this.#session = null;
		}
		if (this.#sessionResult?.mcpManager) {
			await (this.#sessionResult.mcpManager as { dispose?: () => Promise<void> }).dispose?.();
		}
		this.#sessionResult = null;
		this.#eventListeners = [];
	}

	[Symbol.dispose](): void {
		// `Symbol.dispose` is synchronous and cannot await or reject, so there is nowhere for a teardown
		// failure to go: throwing here would replace whatever error ended the `using` block. A caller that
		// needs the teardown to succeed awaits `dispose()` itself, which reports in full.
		this.dispose().catch(() => {});
	}
}

const AGENT_EVENT_TYPES = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

function isAgentEvent(event: AgentSessionEvent): event is AgentEvent {
	return AGENT_EVENT_TYPES.has(event.type);
}
