import type { AgentEvent, AgentMessage, ResolvedThinkingLevel, ThinkingLevel } from "@veyyon/agent-core";
import type { Model, ToolExample } from "@veyyon/ai";
import type { AgentSession, AgentSessionEvent, SessionStats } from "@veyyon/coding-agent";
import { type CreateAgentSessionResult, createAgentSession, SessionManager } from "@veyyon/coding-agent";

import type { InProcessClientOptions, InProcessEventListener } from "./in-process-client-helpers";

export type { SharedInfra } from "./in-process-client-helpers";
export { discoverSharedInfra } from "./in-process-client-helpers";

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
		const shared = this.#options.shared;

		const result = await createAgentSession({
			cwd: this.#options.cwd,
			modelPattern: this.#options.model,
			authStorage: shared?.authStorage,
			modelRegistry: shared?.modelRegistry,
			sessionManager: SessionManager.inMemory(this.#options.cwd),
			systemPrompt: this.#options.appendSystemPrompt
				? (defaultPrompt: string[]) => [...defaultPrompt, this.#options.appendSystemPrompt!]
				: undefined,
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

		this.#unsubscribe = this.#session.subscribe((event: AgentSessionEvent) => {
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

	async getState(): Promise<{
		sessionFile?: string;
		systemPrompt?: string[];
		model?: Model;
		thinkingLevel?: ThinkingLevel | undefined;
		dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	}> {
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
