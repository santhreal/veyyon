import { isPromise } from "node:util/types";
import type {
	ApiKey,
	AssistantMessage,
	AssistantMessageEvent,
	CacheEnforcement,
	Context,
	CursorExecHandlers,
	CursorRuleInput,
	CursorToolResultHandler,
	Effort,
	ImageContent,
	InstrumentationLevel,
	Message,
	Model,
	ProviderSessionState,
	ServiceTier,
	SimpleStreamOptions,
	TextContent,
	ThinkingBudgets,
	ToolChoice,
	ToolResultMessage,
} from "@veyyon/ai";
import { streamSimple } from "@veyyon/ai/stream";
import type { HarmonyAuditEvent } from "@veyyon/ai/utils/harmony-leak";
import { preferredDialect } from "@veyyon/catalog/identity";
import { emptyUsage, getBundledModel } from "@veyyon/catalog/models";
import { errorMessage, logger } from "@veyyon/utils";
import {
	abortReasonText,
	agentLoop,
	agentLoopContinue,
	normalizeMessagesForProvider,
	normalizeTools,
	resolveConfiguredDialect,
} from "./agent-loop";
import type { AppendOnlyContextManager } from "./append-only-context";
import { isProviderRefusalMessage } from "./replay-policy";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentState,
	AgentToolContext,
	AgentTurnEndContext,
	AnyAgentTool,
	AsideMessage,
	ConfiguredDialect,
	StreamFn,
	ToolCallArgumentTransform,
	ToolCallContext,
	ToolChoiceDirective,
} from "./types";
import { isSoftToolRequirement } from "./types";
import { EventLoopKeepalive } from "./utils/yield";

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter((m): m is Message => {
		if (m.role === "assistant") return !isProviderRefusalMessage(m);
		return m.role === "user" || m.role === "toolResult";
	});
}

const ANTHROPIC_OUTPUT_BLOCKED_PREFIX = "Output blocked by conten";

function isAnthropicOutputBlockedError(message: string): boolean {
	return message.includes(ANTHROPIC_OUTPUT_BLOCKED_PREFIX);
}

function refreshToolChoiceForActiveTools(
	toolChoice: ToolChoice | undefined,
	tools: AgentContext["tools"] = [],
): ToolChoice | undefined {
	if (!toolChoice || typeof toolChoice === "string") {
		return toolChoice;
	}

	const toolName =
		toolChoice.type === "tool"
			? toolChoice.name
			: "function" in toolChoice
				? toolChoice.function.name
				: toolChoice.name;

	return tools.some(tool => tool.name === toolName) ? toolChoice : undefined;
}

export class AgentBusyError extends Error {
	constructor(
		message: string = "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.",
	) {
		super(message);
		this.name = "AgentBusyError";
	}
}
export interface AgentOptions {
	initialState?: Partial<AgentState>;

	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;

	steeringMode?: "all" | "one-at-a-time";

	followUpMode?: "all" | "one-at-a-time";

	interruptMode?: "immediate" | "wait";

	kimiApiFormat?: "openai" | "anthropic";

	preferWebsockets?: boolean;

	streamFn?: StreamFn;
	deadline?: number;

	sessionId?: string;
	promptCacheKey?: string;
	providerSessionState?: Map<string, ProviderSessionState>;

	getApiKey?: (model: Model) => Promise<ApiKey | undefined> | ApiKey | undefined;

	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	onSseEvent?: SimpleStreamOptions["onSseEvent"];
	onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;

	onHarmonyLeak?: (event: HarmonyAuditEvent) => void | Promise<void>;
	thinkingBudgets?: ThinkingBudgets;

	temperature?: number;

	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
	serviceTier?: ServiceTier;
	cacheEnforcement?: CacheEnforcement;
	serviceTierResolver?: (model: Model) => ServiceTier | undefined;
	hideThinkingSummary?: boolean;

	maxRetryDelayMs?: number;

	getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;

	transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => ToolCallArgumentTransform;

	intentTracing?: boolean | (() => boolean);
	instrumentation?: InstrumentationLevel;
	pruneToolDescriptions?: boolean | ((model: Model) => boolean);
	dialect?: ConfiguredDialect;
	abortOnFabricatedToolResult?: boolean;
	getToolChoice?: () => ToolChoiceDirective | undefined;

	cursorExecHandlers?: CursorExecHandlers;

	cursorOnToolResult?: CursorToolResultHandler;

	cursorRulesResolver?: () => CursorRuleInput[];

	cwd?: string;
	cwdResolver?: () => string | undefined;
	repairToolCallArguments?: AgentLoopConfig["repairToolCallArguments"];
	beforeToolCall?: AgentLoopConfig["beforeToolCall"];

	afterToolCall?: AgentLoopConfig["afterToolCall"];

	transformAssistantMessage?: AgentLoopConfig["transformAssistantMessage"];

	telemetry?: AgentLoopConfig["telemetry"];
	appendOnlyContext?: AppendOnlyContextManager;
}

export interface AgentPromptOptions {
	toolChoice?: ToolChoice;
}

interface CursorToolResultEntry {
	toolResult: ToolResultMessage;
}

export class Agent {
	#state: AgentState = {
		systemPrompt: [],
		model: getBundledModel("google", "gemini-2.5-flash-lite-preview-06-17"),
		thinkingLevel: undefined,
		disableReasoning: false,
		tools: [],
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
		error: undefined,
	};

	#listeners = new Set<(e: AgentEvent) => void>();
	#abortController?: AbortController;
	#convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	#transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	#transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;
	#steeringQueue: AgentMessage[] = [];
	#followUpQueue: AgentMessage[] = [];
	#steeringMode: "all" | "one-at-a-time";
	#followUpMode: "all" | "one-at-a-time";
	#interruptMode: "immediate" | "wait";
	#sessionId?: string;
	#deadline?: number;
	#promptCacheKey?: string;
	#metadata?: Record<string, unknown>;
	#metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	#providerSessionState?: Map<string, ProviderSessionState>;
	#thinkingBudgets?: ThinkingBudgets;
	#temperature?: number;
	#topP?: number;
	#topK?: number;
	#minP?: number;
	#presencePenalty?: number;
	#repetitionPenalty?: number;
	#serviceTier?: ServiceTier;
	#cacheEnforcement?: CacheEnforcement;
	#serviceTierResolver?: (model: Model) => ServiceTier | undefined;
	#hideThinkingSummary?: boolean;
	#maxRetryDelayMs?: number;
	#getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;
	#cursorExecHandlers?: CursorExecHandlers;
	#cursorOnToolResult?: CursorToolResultHandler;
	#cursorRulesResolver?: () => CursorRuleInput[];
	#cwd?: string;
	#cwdResolver?: () => string | undefined;

	#runningPrompt?: Promise<void>;
	#resolveRunningPrompt?: () => void;
	#kimiApiFormat?: "openai" | "anthropic";
	#preferWebsockets?: boolean;
	#transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => ToolCallArgumentTransform;
	#repairToolCallArguments?: AgentLoopConfig["repairToolCallArguments"];
	#resolveIntentTracing: () => boolean;
	#instrumentation: InstrumentationLevel;
	#resolvePruneToolDescriptions: (model: Model) => boolean;
	#dialect?: ConfiguredDialect;
	#abortOnFabricatedToolResult?: boolean;
	#getToolChoice?: () => ToolChoiceDirective | undefined;
	#onPayload?: SimpleStreamOptions["onPayload"];
	#onResponse?: SimpleStreamOptions["onResponse"];
	#onSseEvent?: SimpleStreamOptions["onSseEvent"];
	#onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;
	#onHarmonyLeak?: (event: HarmonyAuditEvent) => void | Promise<void>;
	#onBeforeYield?: () => Promise<void> | void;
	#onTurnEnd?: (messages: AgentMessage[], signal?: AbortSignal, context?: AgentTurnEndContext) => Promise<void> | void;
	#asideMessageProvider?: () => AsideMessage[] | Promise<AsideMessage[]>;
	#telemetry?: AgentLoopConfig["telemetry"];
	#appendOnlyContext?: AppendOnlyContextManager;

	#cursorToolResultBuffer: CursorToolResultEntry[] = [];

	streamFn: StreamFn;
	getApiKey?: (model: Model) => Promise<ApiKey | undefined> | ApiKey | undefined;
	beforeToolCall?: AgentLoopConfig["beforeToolCall"];
	afterToolCall?: AgentLoopConfig["afterToolCall"];
	transformAssistantMessage?: AgentLoopConfig["transformAssistantMessage"];
	hasIrcInterrupts?: AgentLoopConfig["hasIrcInterrupts"];

	constructor(opts: AgentOptions = {}) {
		this.#state = { ...this.#state, ...opts.initialState };
		if (opts.initialState?.messages) this.#state.messages = opts.initialState.messages.slice();
		if (opts.initialState?.pendingToolCalls)
			this.#state.pendingToolCalls = new Set(opts.initialState.pendingToolCalls);
		this.#convertToLlm = opts.convertToLlm || defaultConvertToLlm;
		this.#transformContext = opts.transformContext;
		this.#steeringMode = opts.steeringMode || "one-at-a-time";
		this.#followUpMode = opts.followUpMode || "one-at-a-time";
		this.#interruptMode = opts.interruptMode || "immediate";
		this.streamFn = opts.streamFn || streamSimple;
		this.#sessionId = opts.sessionId;
		this.#deadline = opts.deadline;
		this.#promptCacheKey = opts.promptCacheKey;
		this.#providerSessionState = opts.providerSessionState;
		this.#thinkingBudgets = opts.thinkingBudgets;
		this.#temperature = opts.temperature;
		this.#topP = opts.topP;
		this.#topK = opts.topK;
		this.#minP = opts.minP;
		this.#presencePenalty = opts.presencePenalty;
		this.#repetitionPenalty = opts.repetitionPenalty;
		this.#serviceTier = opts.serviceTier;
		this.#cacheEnforcement = opts.cacheEnforcement;
		this.#serviceTierResolver = opts.serviceTierResolver;
		this.#hideThinkingSummary = opts.hideThinkingSummary;
		this.#maxRetryDelayMs = opts.maxRetryDelayMs;
		this.getApiKey = opts.getApiKey;
		this.#onPayload = opts.onPayload;
		this.#onResponse = opts.onResponse;
		this.#onSseEvent = opts.onSseEvent;
		this.#getToolContext = opts.getToolContext;
		this.#cursorExecHandlers = opts.cursorExecHandlers;
		this.#cursorOnToolResult = opts.cursorOnToolResult;
		this.#cursorRulesResolver = opts.cursorRulesResolver;
		this.#cwd = opts.cwd;
		this.#cwdResolver = opts.cwdResolver;
		this.#kimiApiFormat = opts.kimiApiFormat;
		this.#preferWebsockets = opts.preferWebsockets;
		this.#transformToolCallArguments = opts.transformToolCallArguments;
		this.#repairToolCallArguments = opts.repairToolCallArguments;
		this.#resolveIntentTracing =
			typeof opts.intentTracing === "function" ? opts.intentTracing : () => opts.intentTracing === true;
		this.#instrumentation = opts.instrumentation ?? "off";
		this.#resolvePruneToolDescriptions =
			typeof opts.pruneToolDescriptions === "function"
				? opts.pruneToolDescriptions
				: () => opts.pruneToolDescriptions === true;
		this.#dialect = opts.dialect;
		this.#abortOnFabricatedToolResult = opts.abortOnFabricatedToolResult;
		this.#getToolChoice = opts.getToolChoice;
		this.#onAssistantMessageEvent = opts.onAssistantMessageEvent;
		this.#onHarmonyLeak = opts.onHarmonyLeak;
		this.beforeToolCall = opts.beforeToolCall;
		this.afterToolCall = opts.afterToolCall;
		this.transformAssistantMessage = opts.transformAssistantMessage;
		this.#telemetry = opts.telemetry;
		this.#appendOnlyContext = opts.appendOnlyContext;
		this.#transformProviderContext = opts.transformProviderContext;
	}

	get sessionId(): string | undefined {
		return this.#sessionId;
	}

	set sessionId(value: string | undefined) {
		this.#sessionId = value;
	}

	set instrumentation(value: InstrumentationLevel) {
		this.#instrumentation = value;
	}

	get promptCacheKey(): string | undefined {
		return this.#promptCacheKey;
	}

	set promptCacheKey(value: string | undefined) {
		this.#promptCacheKey = value;
	}

	get metadata(): Record<string, unknown> | undefined {
		return this.#metadata;
	}

	set metadata(value: Record<string, unknown> | undefined) {
		this.#metadata = value;
		this.#metadataResolver = undefined;
	}

	metadataForProvider(provider: string): Record<string, unknown> | undefined {
		if (this.#metadataResolver) return this.#metadataResolver(provider);
		return this.#metadata;
	}

	setMetadataResolver(resolver: ((provider: string) => Record<string, unknown> | undefined) | undefined): void {
		this.#metadataResolver = resolver;
	}

	get telemetry(): AgentLoopConfig["telemetry"] | undefined {
		return this.#telemetry;
	}

	setTelemetry(telemetry: AgentLoopConfig["telemetry"] | undefined): void {
		this.#telemetry = telemetry;
	}

	get providerSessionState(): Map<string, ProviderSessionState> | undefined {
		return this.#providerSessionState;
	}

	set providerSessionState(value: Map<string, ProviderSessionState> | undefined) {
		this.#providerSessionState = value;
	}

	get thinkingBudgets(): ThinkingBudgets | undefined {
		return this.#thinkingBudgets;
	}

	set thinkingBudgets(value: ThinkingBudgets | undefined) {
		this.#thinkingBudgets = value;
	}

	get temperature(): number | undefined {
		return this.#temperature;
	}

	set temperature(value: number | undefined) {
		this.#temperature = value;
	}

	get topP(): number | undefined {
		return this.#topP;
	}

	set topP(value: number | undefined) {
		this.#topP = value;
	}

	get topK(): number | undefined {
		return this.#topK;
	}

	set topK(value: number | undefined) {
		this.#topK = value;
	}

	get minP(): number | undefined {
		return this.#minP;
	}

	set minP(value: number | undefined) {
		this.#minP = value;
	}

	get presencePenalty(): number | undefined {
		return this.#presencePenalty;
	}

	set presencePenalty(value: number | undefined) {
		this.#presencePenalty = value;
	}

	get repetitionPenalty(): number | undefined {
		return this.#repetitionPenalty;
	}

	set repetitionPenalty(value: number | undefined) {
		this.#repetitionPenalty = value;
	}

	get serviceTier(): ServiceTier | undefined {
		return this.#serviceTier;
	}

	set serviceTier(value: ServiceTier | undefined) {
		this.#serviceTier = value;
	}

	get cacheEnforcement(): CacheEnforcement | undefined {
		return this.#cacheEnforcement;
	}

	set cacheEnforcement(value: CacheEnforcement | undefined) {
		this.#cacheEnforcement = value;
	}

	get serviceTierResolver(): ((model: Model) => ServiceTier | undefined) | undefined {
		return this.#serviceTierResolver;
	}

	set serviceTierResolver(value: ((model: Model) => ServiceTier | undefined) | undefined) {
		this.#serviceTierResolver = value;
	}

	get hideThinkingSummary(): boolean | undefined {
		return this.#hideThinkingSummary;
	}

	set hideThinkingSummary(value: boolean | undefined) {
		this.#hideThinkingSummary = value;
	}

	get maxRetryDelayMs(): number | undefined {
		return this.#maxRetryDelayMs;
	}

	set maxRetryDelayMs(value: number | undefined) {
		this.#maxRetryDelayMs = value;
	}

	get state(): AgentState {
		return this.#state;
	}

	get appendOnlyContext(): AppendOnlyContextManager | undefined {
		return this.#appendOnlyContext;
	}

	setAppendOnlyContext(manager?: AppendOnlyContextManager): void {
		this.#appendOnlyContext = manager;
	}

	async buildSideRequestContext(
		llmMessages: Message[],
		systemPrompt: string[] = this.#state.systemPrompt,
	): Promise<Context> {
		const model = this.#state.model;
		if (!model) throw new Error("No active model on agent");
		const ownedDialect = resolveConfiguredDialect(this.#dialect, model);
		const messages = normalizeMessagesForProvider(llmMessages, model);
		const tools = ownedDialect
			? []
			: (normalizeTools(
					this.#state.tools,
					this.#resolveIntentTracing(),
					preferredDialect(model.id),
					this.#resolvePruneToolDescriptions(model),
				) ?? []);
		let context: Context = { systemPrompt, messages, tools };
		if (this.#transformProviderContext) context = await this.#transformProviderContext(context, model);
		return context;
	}

	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	setProviderResponseInterceptor(fn: SimpleStreamOptions["onResponse"] | undefined): void {
		this.#onResponse = fn;
	}

	setTransformProviderContext(fn: ((context: Context, model: Model) => Context | Promise<Context>) | undefined): void {
		this.#transformProviderContext = fn;
	}

	setRawSseEventInterceptor(fn: SimpleStreamOptions["onSseEvent"] | undefined): void {
		this.#onSseEvent = fn;
	}

	setAssistantMessageEventInterceptor(
		fn: ((message: AssistantMessage, event: AssistantMessageEvent) => void) | undefined,
	): void {
		this.#onAssistantMessageEvent = fn;
	}

	setOnBeforeYield(fn: (() => Promise<void> | void) | undefined): void {
		this.#onBeforeYield = fn;
	}
	setOnTurnEnd(
		fn:
			| ((messages: AgentMessage[], signal?: AbortSignal, context?: AgentTurnEndContext) => Promise<void> | void)
			| undefined,
	): void {
		this.#onTurnEnd = fn;
	}

	setAsideMessageProvider(fn: (() => AsideMessage[] | Promise<AsideMessage[]>) | undefined): void {
		this.#asideMessageProvider = fn;
	}

	emitExternalEvent(event: AgentEvent) {
		switch (event.type) {
			case "message_start":
			case "message_update":
				this.#state.streamMessage = event.message;
				break;
			case "message_end":
				this.#state.streamMessage = null;
				this.appendMessage(event.message);
				break;
			case "tool_execution_start":
				this.#state.pendingToolCalls.add(event.toolCallId);
				break;
			case "tool_execution_end":
				this.#state.pendingToolCalls.delete(event.toolCallId);
				break;
		}

		this.#emit(event);
	}

	setSystemPrompt(v: string[] | string) {
		this.#state.systemPrompt = typeof v === "string" ? [v] : v;
	}

	setModel(m: Model) {
		this.#state.model = m;
	}

	setThinkingLevel(l: Effort | undefined) {
		this.#state.thinkingLevel = l;
	}

	setDisableReasoning(disabled: boolean) {
		this.#state.disableReasoning = disabled;
	}

	setSteeringMode(mode: "all" | "one-at-a-time") {
		this.#steeringMode = mode;
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.#steeringMode;
	}

	setFollowUpMode(mode: "all" | "one-at-a-time") {
		this.#followUpMode = mode;
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.#followUpMode;
	}

	setInterruptMode(mode: "immediate" | "wait") {
		this.#interruptMode = mode;
	}

	getInterruptMode(): "immediate" | "wait" {
		return this.#interruptMode;
	}

	setTools(t: AnyAgentTool[]) {
		this.#state.tools = t;
	}

	replaceMessages(ms: AgentMessage[]) {
		this.#state.messages = ms.slice();
	}

	replaceQueues(steering: AgentMessage[], followUp: AgentMessage[]) {
		this.#steeringQueue = steering.slice();
		this.#followUpQueue = followUp.slice();
	}

	appendMessage(m: AgentMessage) {
		this.#state.messages.push(m);
	}

	popMessage(): AgentMessage | undefined {
		const removed = this.#state.messages.pop();
		if (removed && this.#state.streamMessage === removed) {
			this.#state.streamMessage = null;
		}
		return removed;
	}

	steer(m: AgentMessage) {
		this.#steeringQueue.push(m);
	}

	followUp(m: AgentMessage) {
		this.#followUpQueue.push(m);
	}

	clearSteeringQueue() {
		this.#steeringQueue = [];
	}

	clearFollowUpQueue() {
		this.#followUpQueue = [];
	}

	clearAllQueues() {
		this.#steeringQueue = [];
		this.#followUpQueue = [];
	}

	hasQueuedMessages(): boolean {
		return this.#steeringQueue.length > 0 || this.#followUpQueue.length > 0;
	}

	peekSteeringQueue(): readonly AgentMessage[] {
		return this.#steeringQueue;
	}

	peekFollowUpQueue(): readonly AgentMessage[] {
		return this.#followUpQueue;
	}

	get isAborting(): boolean {
		return this.#abortController?.signal.aborted === true && this.#state.isStreaming;
	}

	#dequeueSteeringMessages(): AgentMessage[] {
		if (this.#steeringMode === "one-at-a-time") {
			if (this.#steeringQueue.length > 0) {
				const first = this.#steeringQueue[0];
				this.#steeringQueue = this.#steeringQueue.slice(1);
				return [first];
			}
			return [];
		}
		const steering = this.#steeringQueue.slice();
		this.#steeringQueue = [];
		return steering;
	}

	#dequeueFollowUpMessages(): AgentMessage[] {
		if (this.#followUpMode === "one-at-a-time") {
			if (this.#followUpQueue.length > 0) {
				const first = this.#followUpQueue[0];
				this.#followUpQueue = this.#followUpQueue.slice(1);
				return [first];
			}
			return [];
		}
		const followUp = this.#followUpQueue.slice();
		this.#followUpQueue = [];
		return followUp;
	}

	popLastSteer(): AgentMessage | undefined {
		return this.#steeringQueue.pop();
	}

	popLastFollowUp(): AgentMessage | undefined {
		return this.#followUpQueue.pop();
	}

	clearMessages() {
		this.#state.messages.length = 0;
	}

	abort(reason?: unknown) {
		this.#abortController?.abort(reason);
	}

	waitForIdle(): Promise<void> {
		return this.#runningPrompt ?? Promise.resolve();
	}

	reset() {
		this.#state.messages.length = 0;
		this.#state.isStreaming = false;
		this.#state.streamMessage = null;
		this.#state.pendingToolCalls.clear();
		this.#state.error = undefined;
		this.#steeringQueue = [];
		this.#followUpQueue = [];
	}

	async prompt(message: AgentMessage | AgentMessage[], options?: AgentPromptOptions): Promise<void>;
	async prompt(input: string, options?: AgentPromptOptions): Promise<void>;
	async prompt(input: string, images?: ImageContent[], options?: AgentPromptOptions): Promise<void>;
	async prompt(
		input: string | AgentMessage | AgentMessage[],
		imagesOrOptions?: ImageContent[] | AgentPromptOptions,
		options?: AgentPromptOptions,
	) {
		if (this.#state.isStreaming) {
			throw new AgentBusyError();
		}

		const model = this.#state.model;
		if (!model) throw new Error("No model configured");

		let msgs: AgentMessage[];
		let promptOptions: AgentPromptOptions | undefined;
		let images: ImageContent[] | undefined;

		if (Array.isArray(input)) {
			msgs = input;
			promptOptions = imagesOrOptions as AgentPromptOptions | undefined;
		} else if (typeof input === "string") {
			if (Array.isArray(imagesOrOptions)) {
				images = imagesOrOptions;
				promptOptions = options;
			} else {
				promptOptions = imagesOrOptions;
			}
			const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
			if (images && images.length > 0) {
				for (let ii = 0; ii < images.length; ii++) content.push(images[ii]!);
			}
			msgs = [
				{
					role: "user",
					content,
					timestamp: Date.now(),
				},
			];
		} else {
			msgs = [input];
			promptOptions = imagesOrOptions as AgentPromptOptions | undefined;
		}

		await this.#runLoop(msgs, promptOptions);
	}

	async continue() {
		if (this.#state.isStreaming) {
			throw new AgentBusyError();
		}

		const messages = this.#state.messages;
		if (messages.length === 0) {
			throw new Error("No messages to continue from");
		}
		if (messages[messages.length - 1].role === "assistant") {
			const queuedSteering = this.#dequeueSteeringMessages();
			if (queuedSteering.length > 0) {
				await this.#runLoop(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			const queuedFollowUp = this.#dequeueFollowUpMessages();
			if (queuedFollowUp.length > 0) {
				await this.#runLoop(queuedFollowUp);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this.#runLoop(undefined);
	}

	async #runLoop(messages?: AgentMessage[], options?: AgentPromptOptions & { skipInitialSteeringPoll?: boolean }) {
		const model = this.#state.model;
		if (!model) throw new Error("No model configured");

		let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true;
		using _ = new EventLoopKeepalive();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#runningPrompt = promise;
		this.#resolveRunningPrompt = resolve;

		this.#abortController = new AbortController();
		this.#state.isStreaming = true;
		this.#state.streamMessage = null;
		this.#state.error = undefined;

		this.#cursorToolResultBuffer = [];

		const reasoning = this.#state.thinkingLevel;

		const context: AgentContext = {
			systemPrompt: this.#state.systemPrompt,
			messages: this.#state.messages.slice(),
			tools: this.#state.tools,
		};

		const cursorOnToolResult =
			this.#cursorExecHandlers || this.#cursorOnToolResult
				? async (message: ToolResultMessage) => {
						let finalMessage = message;
						if (this.#cursorOnToolResult) {
							const updated = await this.#cursorOnToolResult(message);
							if (updated) {
								finalMessage = updated;
							}
						}
						this.#cursorToolResultBuffer.push({ toolResult: finalMessage });
						return finalMessage;
					}
				: undefined;

		const getToolChoice = (): ToolChoiceDirective | undefined => {
			const queued = this.#getToolChoice?.();
			if (queued !== undefined) {
				if (isSoftToolRequirement(queued)) {
					return (this.#state.tools ?? []).some(tool => tool.name === queued.toolName) ? queued : undefined;
				}
				return refreshToolChoiceForActiveTools(queued, this.#state.tools);
			}
			return refreshToolChoiceForActiveTools(options?.toolChoice, this.#state.tools);
		};

		const config: AgentLoopConfig = {
			model,
			reasoning,
			disableReasoning: this.#state.disableReasoning,
			temperature: this.#temperature,
			topP: this.#topP,
			topK: this.#topK,
			minP: this.#minP,
			presencePenalty: this.#presencePenalty,
			repetitionPenalty: this.#repetitionPenalty,
			serviceTier: this.#serviceTier,
			cacheEnforcement: this.#cacheEnforcement,
			hideThinkingSummary: this.#hideThinkingSummary,
			interruptMode: this.#interruptMode,
			sessionId: this.#sessionId,
			deadline: this.#deadline,
			promptCacheKey: this.#promptCacheKey,
			metadata: this.#metadataResolver ? undefined : this.#metadata,
			metadataResolver: this.#metadataResolver,
			providerSessionState: this.#providerSessionState,
			thinkingBudgets: this.#thinkingBudgets,
			maxRetryDelayMs: this.#maxRetryDelayMs,
			kimiApiFormat: this.#kimiApiFormat,
			preferWebsockets: this.#preferWebsockets,
			convertToLlm: this.#convertToLlm,
			transformProviderContext: this.#transformProviderContext,
			transformContext: this.#transformContext,
			onPayload: this.#onPayload,
			onResponse: this.#onResponse,
			onSseEvent: this.#onSseEvent,
			getApiKey: this.getApiKey,
			getToolContext: this.#getToolContext,
			syncContextBeforeModelCall: async context => {
				if (this.#listeners.size > 0) {
					await Bun.sleep(0);
				}
				context.systemPrompt = this.#state.systemPrompt;
				context.tools = this.#state.tools;
			},
			cursorExecHandlers: this.#cursorExecHandlers,
			cursorOnToolResult,
			cursorRules: this.#cursorRulesResolver?.(),
			cwd: this.#cwd,
			getCwd: this.#cwdResolver,
			transformToolCallArguments: this.#transformToolCallArguments,
			repairToolCallArguments: this.#repairToolCallArguments,
			intentTracing: this.#resolveIntentTracing(),
			instrumentation: this.#instrumentation,
			pruneToolDescriptions: this.#resolvePruneToolDescriptions(model),
			dialect: this.#dialect,
			abortOnFabricatedToolResult: this.#abortOnFabricatedToolResult,
			appendOnlyContext: this.#appendOnlyContext,
			beforeToolCall: this.beforeToolCall ? (ctx, signal) => this.beforeToolCall?.(ctx, signal) : undefined,
			afterToolCall: this.afterToolCall ? (ctx, signal) => this.afterToolCall?.(ctx, signal) : undefined,
			transformAssistantMessage: this.transformAssistantMessage
				? (message, signal) => this.transformAssistantMessage?.(message, signal)
				: undefined,
			onAssistantMessageEvent: this.#onAssistantMessageEvent,
			onHarmonyLeak: this.#onHarmonyLeak,
			onTurnEnd: (messages, signal, context) => this.#onTurnEnd?.(messages, signal, context),
			getToolChoice,
			getModel: () => this.#state.model ?? model,
			getReasoning: () => this.#state.thinkingLevel,
			getDisableReasoning: () => this.#state.disableReasoning,
			getServiceTier: this.#serviceTierResolver,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.#dequeueSteeringMessages();
			},
			hasSteeringMessages: () => {
				if (this.#steeringQueue.length === 0) {
					return { queued: false };
				}
				for (const message of this.#steeringQueue) {
					const role = "role" in message ? message.role : undefined;
					const attribution = "attribution" in message ? message.attribution : undefined;
					if (role === "user" && attribution !== "agent") {
						return { queued: true, source: "user" };
					}
				}
				return { queued: true, source: "system" };
			},
			hasIrcInterrupts: this.hasIrcInterrupts,
			getFollowUpMessages: async () => this.#dequeueFollowUpMessages(),
			getAsideMessages: async () => (await this.#asideMessageProvider?.()) ?? [],
			onBeforeYield: () => this.#onBeforeYield?.(),
			telemetry: this.#telemetry,
		};

		let partial: AgentMessage | null = null;

		try {
			const stream = messages
				? agentLoop(messages, context, config, this.#abortController.signal, this.streamFn)
				: agentLoopContinue(context, config, this.#abortController.signal, this.streamFn);

			for await (const event of stream) {
				switch (event.type) {
					case "message_start":
						partial = event.message;
						this.#state.streamMessage = event.message;
						break;

					case "message_update":
						partial = event.message;
						this.#state.streamMessage = event.message;
						break;

					case "message_end":
						partial = null;
						if (event.message.role === "assistant" && this.#cursorToolResultBuffer.length > 0) {
							this.#emitCursorSplitAssistantMessage(event.message as AssistantMessage);
							continue; // Skip default emit - split method handles everything
						}
						this.#state.streamMessage = null;
						this.appendMessage(event.message);
						break;

					case "tool_execution_start":
						this.#state.pendingToolCalls.add(event.toolCallId);
						break;

					case "tool_execution_end":
						this.#state.pendingToolCalls.delete(event.toolCallId);
						break;

					case "turn_end":
						if (
							event.message.role === "assistant" &&
							"errorMessage" in event.message &&
							typeof event.message.errorMessage === "string"
						) {
							this.#state.error = event.message.errorMessage;
						}
						break;

					case "agent_end":
						this.#state.isStreaming = false;
						this.#state.streamMessage = null;
						break;
				}

				this.#emit(event);
			}

			if (partial && partial.role === "assistant" && Array.isArray(partial.content) && partial.content.length > 0) {
				const onlyEmpty = !partial.content.some(
					c =>
						(c.type === "thinking" && c.thinking.trim().length > 0) ||
						(c.type === "text" && c.text.trim().length > 0) ||
						(c.type === "toolCall" && c.name.trim().length > 0),
				);
				if (!onlyEmpty) {
					this.appendMessage(partial);
				} else {
					if (this.#abortController?.signal.aborted) {
						throw new Error("Request was aborted");
					}
				}
			}
		} catch (err) {
			const stoppedForAbort = this.#abortController?.signal.aborted === true;
			const failureMessage = stoppedForAbort ? abortReasonText(this.#abortController?.signal) : errorMessage(err);
			const shouldEmitVisibleOutputBlockedError = !stoppedForAbort && isAnthropicOutputBlockedError(failureMessage);
			const assistantPartial = partial?.role === "assistant" ? partial : undefined;
			const hadAssistantStart = assistantPartial !== undefined;
			const errorMsg: AssistantMessage =
				shouldEmitVisibleOutputBlockedError && assistantPartial
					? { ...assistantPartial, stopReason: "error", errorMessage: failureMessage }
					: {
							role: "assistant",
							content: [{ type: "text", text: "" }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: emptyUsage(),
							stopReason: stoppedForAbort ? "aborted" : "error",
							errorMessage: failureMessage,
							timestamp: Date.now(),
						};

			if (shouldEmitVisibleOutputBlockedError) {
				if (!hadAssistantStart) {
					this.#state.streamMessage = errorMsg;
					this.#emit({ type: "message_start", message: errorMsg });
				}
				this.#state.streamMessage = null;
				this.appendMessage(errorMsg);
				this.#state.error = failureMessage;
				this.#emit({ type: "message_end", message: errorMsg });
				this.#emit({ type: "turn_end", message: errorMsg, toolResults: [] });
				this.#emit({ type: "agent_end", messages: [errorMsg] });
			} else {
				this.appendMessage(errorMsg);
				this.#state.error = failureMessage;
				this.#emit({ type: "agent_end", messages: [errorMsg] });
			}
		} finally {
			this.#state.isStreaming = false;
			this.#state.streamMessage = null;
			this.#state.pendingToolCalls.clear();
			this.#abortController = undefined;
			this.#resolveRunningPrompt?.();
			this.#runningPrompt = undefined;
			this.#resolveRunningPrompt = undefined;
		}
	}

	#emit(e: AgentEvent) {
		for (const listener of this.#listeners) {
			try {
				const result = listener(e) as unknown;
				if (isPromise(result)) {
					result.catch(err => {
						logger.warn("Agent listener rejected", {
							error: errorMessage(err),
						});
					});
				}
			} catch (err) {
				logger.warn("Agent listener threw", {
					error: errorMessage(err),
				});
			}
		}
	}

	#emitCursorSplitAssistantMessage(assistantMessage: AssistantMessage): void {
		const buffer = this.#cursorToolResultBuffer;
		this.#cursorToolResultBuffer = [];

		this.#state.streamMessage = null;
		this.appendMessage(assistantMessage);
		this.#emit({ type: "message_end", message: assistantMessage });

		for (const { toolResult } of buffer) {
			this.#emit({ type: "message_start", message: toolResult });
			this.appendMessage(toolResult);
			this.#emit({ type: "message_end", message: toolResult });
		}
	}
}
