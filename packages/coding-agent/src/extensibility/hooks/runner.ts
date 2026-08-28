import type { AgentMessage } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { errorMessage } from "@veyyon/utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { SessionManager } from "../../session/session-manager";
import { createNoOpUIContext } from "../utils";
import type {
	AppendEntryHandler,
	BranchHandler,
	LoadedHook,
	NavigateTreeHandler,
	NewSessionHandler,
	SendMessageHandler,
} from "./loader";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ContextEvent,
	ContextEventResult,
	HookCommandContext,
	HookContext,
	HookError,
	HookEvent,
	HookMessageRenderer,
	HookUIContext,
	RegisteredCommand,
	SessionBeforeCompactResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEventResult,
} from "./types";

export type HookErrorListener = (error: HookError) => void;

export { execCommand } from "../../exec/exec";

export class HookRunner {
	#uiContext: HookUIContext;
	#hasUI: boolean;
	#errorListeners: Set<HookErrorListener> = new Set();
	#getModel: () => Model | undefined = () => undefined;
	#isIdleFn: () => boolean = () => true;
	#waitForIdleFn: () => Promise<void> = async () => {};
	#abortFn: () => void = () => {};
	#hasQueuedMessagesFn: () => boolean = () => false;
	#obfuscateProviderTextFn: (text: string) => string = text => text;
	#newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	#branchHandler: BranchHandler = async () => ({ cancelled: false });
	#navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });

	constructor(
		private readonly hooks: LoadedHook[],
		private readonly cwd: string,
		private readonly sessionManager: SessionManager,
		private readonly modelRegistry: ModelRegistry,
	) {
		this.#uiContext = createNoOpUIContext();
		this.#hasUI = false;
	}

	initialize(options: {
		getModel: () => Model | undefined;
		sendMessageHandler: SendMessageHandler;
		appendEntryHandler: AppendEntryHandler;
		newSessionHandler?: NewSessionHandler;
		branchHandler?: BranchHandler;
		navigateTreeHandler?: NavigateTreeHandler;
		isIdle?: () => boolean;
		waitForIdle?: () => Promise<void>;
		abort?: () => void;
		hasQueuedMessages?: () => boolean;
		obfuscateProviderText?: (text: string) => string;
		uiContext?: HookUIContext;
		hasUI?: boolean;
	}): void {
		this.#getModel = options.getModel;
		this.#isIdleFn = options.isIdle ?? (() => true);
		this.#waitForIdleFn = options.waitForIdle ?? (async () => {});
		this.#abortFn = options.abort ?? (() => {});
		this.#hasQueuedMessagesFn = options.hasQueuedMessages ?? (() => false);
		this.#obfuscateProviderTextFn = options.obfuscateProviderText ?? (text => text);
		if (options.newSessionHandler) {
			this.#newSessionHandler = options.newSessionHandler;
		}
		if (options.branchHandler) {
			this.#branchHandler = options.branchHandler;
		}
		if (options.navigateTreeHandler) {
			this.#navigateTreeHandler = options.navigateTreeHandler;
		}
		for (const hook of this.hooks) {
			hook.setSendMessageHandler(options.sendMessageHandler);
			hook.setAppendEntryHandler(options.appendEntryHandler);
		}
		this.#uiContext = options.uiContext ?? createNoOpUIContext();
		this.#hasUI = options.hasUI ?? false;
	}

	getUIContext(): HookUIContext | null {
		return this.#uiContext;
	}

	getHasUI(): boolean {
		return this.#hasUI;
	}

	getHookPaths(): string[] {
		return this.hooks.map(h => h.path);
	}

	onError(listener: HookErrorListener): () => void {
		this.#errorListeners.add(listener);
		return () => this.#errorListeners.delete(listener);
	}

	emitError(error: HookError): void {
		for (const listener of this.#errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		for (const hook of this.hooks) {
			const handlers = hook.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	getMessageRenderer(customType: string): HookMessageRenderer | undefined {
		for (const hook of this.hooks) {
			const renderer = hook.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	getRegisteredCommands(): RegisteredCommand[] {
		const commands: RegisteredCommand[] = [];
		for (const hook of this.hooks) {
			for (const command of hook.commands.values()) {
				commands.push(command);
			}
		}
		return commands;
	}

	getCommand(name: string): RegisteredCommand | undefined {
		for (const hook of this.hooks) {
			const command = hook.commands.get(name);
			if (command) {
				return command;
			}
		}
		return undefined;
	}

	#createContext(): HookContext {
		return {
			ui: this.#uiContext,
			hasUI: this.#hasUI,
			cwd: this.cwd,
			sessionManager: this.sessionManager,
			modelRegistry: this.modelRegistry,
			model: this.#getModel(),
			obfuscateProviderText: text => this.#obfuscateProviderTextFn(text),
			isIdle: () => this.#isIdleFn(),
			abort: () => this.#abortFn(),
			hasQueuedMessages: () => this.#hasQueuedMessagesFn(),
		};
	}

	createCommandContext(): HookCommandContext {
		return {
			...this.#createContext(),
			waitForIdle: () => this.#waitForIdleFn(),
			newSession: options => this.#newSessionHandler(options),
			branch: entryId => this.#branchHandler(entryId),
			navigateTree: (targetId, options) => this.#navigateTreeHandler(targetId, options),
		};
	}

	#isSessionBeforeEvent(
		type: string,
	): type is "session_before_switch" | "session_before_branch" | "session_before_compact" | "session_before_tree" {
		return (
			type === "session_before_switch" ||
			type === "session_before_branch" ||
			type === "session_before_compact" ||
			type === "session_before_tree"
		);
	}

	async emit(
		event: HookEvent,
	): Promise<
		SessionBeforeCompactResult | SessionBeforeTreeResult | SessionCompactingResult | ToolResultEventResult | undefined
	> {
		const ctx = this.#createContext();
		let result:
			| SessionBeforeCompactResult
			| SessionBeforeTreeResult
			| SessionCompactingResult
			| ToolResultEventResult
			| undefined;

		for (const hook of this.hooks) {
			const handlers = hook.handlers.get(event.type);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, ctx);

					if (this.#isSessionBeforeEvent(event.type) && handlerResult) {
						result = handlerResult as SessionBeforeCompactResult | SessionBeforeTreeResult;
						if (result.cancel) {
							return result;
						}
					}

					if (event.type === "tool_result" && handlerResult) {
						result = handlerResult as ToolResultEventResult;
					}
					if (event.type === "session_compacting" && handlerResult) {
						result = handlerResult as SessionCompactingResult;
					}
				} catch (err) {
					const message = errorMessage(err);
					this.emitError({
						hookPath: hook.path,
						event: event.type,
						error: message,
					});
				}
			}
		}

		return result;
	}

	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		const ctx = this.#createContext();
		let result: ToolCallEventResult | undefined;

		for (const hook of this.hooks) {
			const handlers = hook.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = await handler(event, ctx);

				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					if (result.block) {
						return result;
					}
				}
			}
		}

		return result;
	}

	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const ctx = this.#createContext();
		let currentMessages = messages;

		for (const hook of this.hooks) {
			const handlers = hook.handlers.get("context");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: ContextEvent = { type: "context", messages: currentMessages };
					const handlerResult = await handler(event, ctx);

					if (handlerResult && (handlerResult as ContextEventResult).messages) {
						currentMessages = (handlerResult as ContextEventResult).messages!;
					}
				} catch (err) {
					const message = errorMessage(err);
					this.emitError({
						hookPath: hook.path,
						event: "context",
						error: message,
					});
				}
			}
		}

		return currentMessages;
	}

	async emitBeforeAgentStart(
		prompt: string,
		images?: import("@veyyon/ai").ImageContent[],
	): Promise<BeforeAgentStartEventResult | undefined> {
		const ctx = this.#createContext();
		let result: BeforeAgentStartEventResult | undefined;

		for (const hook of this.hooks) {
			const handlers = hook.handlers.get("before_agent_start");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: BeforeAgentStartEvent = { type: "before_agent_start", prompt, images };
					const handlerResult = await handler(event, ctx);

					if (handlerResult && (handlerResult as BeforeAgentStartEventResult).message && !result) {
						result = handlerResult as BeforeAgentStartEventResult;
					}
				} catch (err) {
					const message = errorMessage(err);
					this.emitError({
						hookPath: hook.path,
						event: "before_agent_start",
						error: message,
					});
				}
			}
		}

		return result;
	}
}
