import * as fs from "node:fs/promises";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ServiceTier,
	SimpleStreamOptions,
	ToolCall,
	ToolChoice,
} from "@veyyon/ai";
import {
	setAnthropicProviderModule,
	setAzureOpenAIResponsesProviderModule,
	setBedrockProviderModule,
	setCursorProviderModule,
	setDevinProviderModule,
	setGoogleGeminiCliProviderModule,
	setGoogleProviderModule,
	setGoogleVertexProviderModule,
	setOllamaProviderModule,
	setOpenAICodexResponsesProviderModule,
	setOpenAICompletionsProviderModule,
	setOpenAIResponsesProviderModule,
} from "@veyyon/ai/providers/register-builtins";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@veyyon/ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { ThinkingLoopDetector } from "@veyyon/ai/utils/thinking-loop";
import { buildModel } from "@veyyon/catalog/build";
import type { Effort } from "@veyyon/catalog/effort";
import { emptyUsage } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { buildServiceTierByFamily } from "@veyyon/coding-agent/config/service-tier";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { TtsrManager } from "@veyyon/coding-agent/export/ttsr";
import { AgentSession, type AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { MemorySessionStorage } from "@veyyon/coding-agent/session/session-storage";
import { createSettingsAwareStreamFn } from "@veyyon/coding-agent/session/settings-stream-fn";
import { wrapStreamFnWithProviderConcurrency } from "@veyyon/coding-agent/task/provider-concurrency";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

const SIM_API = "bedrock-converse-stream" as const;

export const SIM_IDLE_BUDGET_SECONDS = 0.3;
export const SIM_FIRST_EVENT_BUDGET_SECONDS = 0.3;
export const SIM_COST_PER_TOKEN = 0.001;

export interface ScriptedTurn {
	readonly stream: AssistantMessageEventStream;
	readonly call: number;
	readonly model: Model<Api>;
	readonly context: Context;
	readonly signal: AbortSignal | undefined;
	readonly toolChoice: ToolChoice | undefined;
	readonly cacheRouting: { readonly sessionId: string | undefined; readonly promptCacheKey: string | undefined };
	readonly options: SimpleStreamOptions | undefined;
	text(value: string): void;
	thinking(value: string, signature?: string): void;
	openThinking(partialValue: string): void;
	toolCall(name: string, args: Record<string, unknown>, id?: string, intent?: string): void;
	openToolCall(name: string, partialArgs: string, id?: string, intent?: string): void;
	execResolvedToolCall(name: string, args: Record<string, unknown>, id?: string, intent?: string): void;
	usage(counts: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): void;
	finish(reason?: "stop" | "toolUse" | "length"): void;
	fail(message: string, errorId?: number): void;
	trackLocalWork(work: Promise<unknown>): Promise<void>;
	onLocalWorkProbe(callback: (probeCount: number) => void): void;
}

export type ProviderScript = (turn: ScriptedTurn) => void | Promise<void>;

class SimulatedProviderStream extends AssistantMessageEventStream {
	probeCount = 0;
	onProbe: ((probeCount: number) => void) | undefined;

	override get hasPendingLocalWork(): boolean {
		this.probeCount += 1;
		this.onProbe?.(this.probeCount);
		return super.hasPendingLocalWork;
	}
}

let activeScript: ProviderScript | undefined;
let callCount = 0;

function createSimulatedStream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: unknown,
): SimulatedProviderStream {
	const script = activeScript;
	callCount += 1;
	const call = callCount;
	const stream = new SimulatedProviderStream();
	if (!script) {
		queueMicrotask(() => stream.fail(new Error("simulation: no provider script installed")));
		return stream;
	}
	void runScript(script, stream, model as Model<Api>, context, options as SimpleStreamOptions, call);
	return stream;
}

setBedrockProviderModule({ streamBedrock: (m, c, o) => createSimulatedStream(m, c, o) });
setAnthropicProviderModule({ streamAnthropic: (m, c, o) => createSimulatedStream(m, c, o) });
setOpenAICompletionsProviderModule({ streamOpenAICompletions: (m, c, o) => createSimulatedStream(m, c, o) });
setOpenAIResponsesProviderModule({ streamOpenAIResponses: (m, c, o) => createSimulatedStream(m, c, o) });
setGoogleProviderModule({ streamGoogle: (m, c, o) => createSimulatedStream(m, c, o) });
setGoogleGeminiCliProviderModule({ streamGoogleGeminiCli: (m, c, o) => createSimulatedStream(m, c, o) });
setGoogleVertexProviderModule({ streamGoogleVertex: (m, c, o) => createSimulatedStream(m, c, o) });
setOllamaProviderModule({ streamOllama: (m, c, o) => createSimulatedStream(m, c, o) });
setCursorProviderModule({ streamCursor: (m, c, o) => createSimulatedStream(m, c, o) });
setDevinProviderModule({ streamDevin: (m, c, o) => createSimulatedStream(m, c, o) });
setAzureOpenAIResponsesProviderModule({ streamAzureOpenAIResponses: (m, c, o) => createSimulatedStream(m, c, o) });
setOpenAICodexResponsesProviderModule({ streamOpenAICodexResponses: (m, c, o) => createSimulatedStream(m, c, o) });

function assertScriptedPayloadIsNotALoop(kind: "text" | "thinking", value: string): void {
	const detector = new ThinkingLoopDetector();
	const detail = detector.push(value) ?? detector.flush();
	if (detail === null) return;
	throw new Error(
		`simulation: scripted ${kind} is a degenerate loop the shipped guard aborts (${detail}). ` +
			"A long answer is bulkProse(words); a payload that repeats one phrase is a stall, not an answer.",
	);
}

const FILLER_WORDS = [
	"parser",
	"buffer",
	"window",
	"header",
	"branch",
	"cursor",
	"handle",
	"marker",
	"anchor",
	"stream",
	"packet",
	"record",
	"vector",
	"symbol",
	"module",
	"target",
	"budget",
	"filter",
	"socket",
	"thread",
	"column",
	"origin",
	"legend",
	"matrix",
	"driver",
	"editor",
	"loader",
	"logger",
	"router",
	"walker",
	"writer",
	"reader",
] as const;

export function bulkProse(words: number, tag = "sim"): string {
	const out: string[] = [];
	for (let i = 0; i < words; i += 1) {
		if (i % 24 === 0) out.push(`${tag}_span${i}`);
		out.push(FILLER_WORDS[(i * 7 + ((i * i) % 13)) % FILLER_WORDS.length]);
	}
	return out.join(" ");
}

function baseMessage(model: Model<Api>, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function runScript(
	script: ProviderScript,
	stream: SimulatedProviderStream,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	call: number,
): Promise<void> {
	const content: AssistantMessage["content"] = [];
	const partial = baseMessage(model, content);
	let toolCallSeq = 0;
	let ended = false;
	stream.push({ type: "start", partial });
	const emitToolCall = (
		name: string,
		args: Record<string, unknown>,
		id: string | undefined,
		execResolved: boolean,
		intent?: string,
	): void => {
		toolCallSeq += 1;
		const block: ToolCall = {
			type: "toolCall",
			id: id ?? `sim-call-${call}-${toolCallSeq}`,
			name,
			arguments: args,
			...(intent !== undefined ? { intent } : {}),
		};
		if (execResolved) (block as CursorExecResolvedCarrier)[kCursorExecResolved] = true;
		const index = content.length;
		content.push(block);
		stream.push({ type: "toolcall_start", contentIndex: index, partial });
		stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(args), partial });
		stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial });
	};

	const turn: ScriptedTurn = {
		stream,
		call,
		context,
		model,
		signal: options?.signal,
		toolChoice: options?.toolChoice,
		options,
		cacheRouting: {
			sessionId: options?.sessionId,
			promptCacheKey: options?.promptCacheKey,
		},
		text(value) {
			assertScriptedPayloadIsNotALoop("text", value);
			const index = content.length;
			content.push({ type: "text", text: value });
			stream.push({ type: "text_start", contentIndex: index, partial });
			stream.push({ type: "text_delta", contentIndex: index, delta: value, partial });
			stream.push({ type: "text_end", contentIndex: index, content: value, partial });
		},
		thinking(value, signature) {
			assertScriptedPayloadIsNotALoop("thinking", value);
			const index = content.length;
			content.push({
				type: "thinking",
				thinking: value,
				...(signature === undefined ? {} : { thinkingSignature: signature }),
			});
			stream.push({ type: "thinking_start", contentIndex: index, partial });
			stream.push({ type: "thinking_delta", contentIndex: index, delta: value, partial });
			stream.push({ type: "thinking_end", contentIndex: index, content: value, partial });
		},
		openThinking(partialValue) {
			assertScriptedPayloadIsNotALoop("thinking", partialValue);
			const index = content.length;
			content.push({ type: "thinking", thinking: partialValue });
			stream.push({ type: "thinking_start", contentIndex: index, partial });
			stream.push({ type: "thinking_delta", contentIndex: index, delta: partialValue, partial });
		},
		toolCall(name, args, id, intent) {
			emitToolCall(name, args, id, false, intent);
		},
		execResolvedToolCall(name, args, id, intent) {
			emitToolCall(name, args, id, true, intent);
		},
		openToolCall(name, partialArgs, id, intent) {
			toolCallSeq += 1;
			const block: ToolCall = {
				type: "toolCall",
				id: id ?? `sim-open-${call}-${toolCallSeq}`,
				name,
				arguments: {},
				...(intent !== undefined ? { intent } : {}),
			};
			const index = content.length;
			content.push(block);
			stream.push({ type: "toolcall_start", contentIndex: index, partial });
			stream.push({ type: "toolcall_delta", contentIndex: index, delta: partialArgs, partial });
		},
		usage(counts) {
			const input = counts.input ?? 0;
			const output = counts.output ?? 0;
			const cacheRead = counts.cacheRead ?? 0;
			const cacheWrite = counts.cacheWrite ?? 0;
			const rate = SIM_COST_PER_TOKEN;
			partial.usage = {
				input,
				output,
				cacheRead,
				cacheWrite,
				totalTokens: input + output + cacheRead + cacheWrite,
				cost: {
					input: input * rate,
					output: output * rate,
					cacheRead: cacheRead * rate,
					cacheWrite: cacheWrite * rate,
					total: (input + output + cacheRead + cacheWrite) * rate,
				},
			};
		},
		finish(reason) {
			if (ended) return;
			ended = true;
			const hasToolCall = content.some(block => block.type === "toolCall");
			const stopReason = reason ?? (hasToolCall ? "toolUse" : "stop");
			partial.stopReason = stopReason;
			stream.push({ type: "done", reason: stopReason, message: partial });
		},
		fail(message, errorId) {
			if (ended) return;
			ended = true;
			const errored = baseMessage(model, []);
			errored.stopReason = "error";
			errored.errorMessage = message;
			if (errorId !== undefined) errored.errorId = errorId;
			stream.push({ type: "error", reason: "error", error: errored });
		},
		async trackLocalWork(work) {
			await stream.trackLocalWork(work);
		},
		onLocalWorkProbe(callback) {
			stream.onProbe = callback;
		},
	};

	try {
		await script(turn);
	} catch (error) {
		if (!ended) stream.fail(error);
	}
}

export function installScript(script: ProviderScript): void {
	activeScript = script;
}

export function resetScript(): void {
	activeScript = undefined;
	callCount = 0;
}

export function scriptTurns(...turns: ProviderScript[]): ProviderScript {
	return async turn => {
		const step = turns[Math.min(turn.call, turns.length) - 1];
		if (!step) throw new Error("simulation: empty turn script");
		await step(turn);
	};
}

export function simulatedModel(id = "sim-model", options?: SimulatedModelOptions): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: options?.api ?? SIM_API,
		provider: options?.provider ?? "amazon-bedrock",
		baseUrl: "https://simulation.invalid",
		reasoning: options?.reasoning ?? false,
		...(options?.efforts ? { thinking: { mode: "effort" as const, efforts: options.efforts } } : {}),
		input: options?.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options?.contextWindow ?? 200_000,
		maxTokens: 32_768,
	});
}

export interface SimulatedModelOptions {
	api?: Api;
	provider?: string;
	contextWindow?: number;
	reasoning?: boolean;
	efforts?: readonly Effort[];
	vision?: boolean;
}

const ANY_OBJECT = type("object");

export function simTool(
	name: string,
	execute: (toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
	overrides?: Partial<AgentTool>,
): AgentTool {
	return {
		name,
		label: name,
		description: `Simulated ${name} tool`,
		parameters: ANY_OBJECT,
		execute: async (toolCallId, params, signal) =>
			(await execute(toolCallId, params as Record<string, unknown>, signal)) as never,
		...overrides,
	} as AgentTool;
}

export function bulkTool(name = "work", lines = 900): AgentTool {
	let call = 0;
	return simTool(name, async () => {
		call += 1;
		return { content: [{ type: "text", text: `worked. ${"tool output line. ".repeat(lines)}call ${call}.` }] };
	});
}

export interface SimulationOptions {
	script: ProviderScript;
	tools?: AgentTool[];
	settings?: Record<string, unknown>;
	modelId?: string;
	model?: SimulatedModelOptions;
	providerConcurrency?: boolean;
	ttsrManager?: TtsrManager;
	persist?: boolean;
	modelsConfig?: Record<string, unknown>;
}

export interface SimulationRequest {
	call: number;
	provider: string;
	model: string;
	tools: number;
	serviceTier?: ServiceTier;
}

export interface Simulation {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly modelRegistry: ModelRegistry;
	readonly events: AgentSessionEvent[];
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Array<Extract<AgentSessionEvent, { type: T }>>;
	providerCalls(): number;
	sessionRequests(): SimulationRequest[];
	sessionFile(): string | undefined;
	reopen(sessionFile?: string): Promise<Simulation>;
	dispose(): Promise<void>;
}

function simulationSettings(overrides: Record<string, unknown> | undefined): Settings {
	return Settings.isolated({
		"compaction.enabled": false,
		"providers.streamIdleTimeoutSeconds": SIM_IDLE_BUDGET_SECONDS,
		"providers.streamFirstEventTimeoutSeconds": SIM_FIRST_EVENT_BUDGET_SECONDS,
		"retry.maxRetries": 2,
		"retry.baseDelayMs": 1,
		"retry.maxDelayMs": 2,
		...overrides,
	});
}

interface SimulationScope {
	tempDir: TempDir;
	authStorage: AuthStorage;
	storage: MemorySessionStorage;
	settings: Settings;
	modelRegistry: ModelRegistry;
	tools: AgentTool[];
	toolRegistry: Map<string, AgentTool>;
	options: SimulationOptions;
}

function buildSimulation(scope: SimulationScope, ownsScope: boolean): Simulation {
	const { options, settings, tools } = scope;
	const sessionManager = options.persist
		? SessionManager.create(scope.tempDir.path(), `${scope.tempDir.path()}/sessions`, scope.storage)
		: SessionManager.inMemory(scope.tempDir.path(), scope.storage);

	const baseStreamFn = createSettingsAwareStreamFn(settings);
	const sharedStreamFn = options.providerConcurrency
		? wrapStreamFnWithProviderConcurrency(settings, baseStreamFn)
		: baseStreamFn;
	const requests: SimulationRequest[] = [];
	const recordingStreamFn: typeof sharedStreamFn = (model, context, streamOptions) => {
		requests.push({
			call: requests.length + 1,
			provider: model.provider,
			model: model.id,
			tools: context.tools?.length ?? 0,
			serviceTier: streamOptions?.serviceTier,
		});
		return sharedStreamFn(model, context, streamOptions);
	};
	let host: AgentSession | undefined;
	const agent = new Agent({
		getApiKey: () => "simulation-key",
		initialState: {
			model: simulatedModel(options.modelId, options.model),
			systemPrompt: ["Simulation"],
			tools,
			messages: [],
		},
		convertToLlm,
		getToolChoice: () => host?.nextToolChoiceDirective(),
		streamFn: recordingStreamFn,
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: scope.modelRegistry,
		toolRegistry: scope.toolRegistry,
		sideStreamFn: recordingStreamFn,
		serviceTierByFamily: buildServiceTierByFamily(
			settings.get("tier.openai"),
			settings.get("tier.anthropic"),
			settings.get("tier.google"),
		),
		...(options.ttsrManager ? { ttsrManager: options.ttsrManager } : {}),
	});
	host = session;
	const events: AgentSessionEvent[] = [];
	session.subscribe(event => {
		events.push(event);
	});

	return {
		session,
		sessionManager,
		modelRegistry: scope.modelRegistry,
		events,
		sessionRequests() {
			return [...requests];
		},
		eventsOfType(type) {
			return events.filter(event => event.type === type) as Array<Extract<AgentSessionEvent, { type: typeof type }>>;
		},
		providerCalls: () => callCount,
		sessionFile: () => sessionManager.getSessionFile(),
		async reopen(sessionFile) {
			if (!options.persist) throw new Error("reopen needs `persist: true`: nothing was written to read back");
			const target = sessionFile ?? sessionManager.getSessionFile();
			if (!target) throw new Error("the simulation stored no session file");
			await sessionManager.flush();
			const reopened = buildSimulation(scope, false);
			if (!(await reopened.session.switchSession(target))) {
				await reopened.dispose();
				throw new Error(`reopening ${target} was refused`);
			}
			return reopened;
		},
		async dispose() {
			await session.dispose();
			if (!ownsScope) return;
			scope.authStorage.close();
			scope.tempDir.removeSync();
			resetScript();
		},
	};
}

export async function createSimulation(options: SimulationOptions): Promise<Simulation> {
	resetScript();
	installScript(options.script);
	const tempDir = TempDir.createSync("@pi-simulation-");
	const authStorage = await AuthStorage.create(`${tempDir.path()}/auth.db`);
	authStorage.setRuntimeApiKey("amazon-bedrock", "simulation-key");
	if (options.model?.provider) {
		authStorage.setRuntimeApiKey(options.model.provider, "simulation-key");
	}
	const modelsConfigFile = `${tempDir.path()}/models.yml`;
	if (options.modelsConfig) {
		await fs.writeFile(modelsConfigFile, JSON.stringify(options.modelsConfig, null, 2), "utf8");
	}
	const tools = options.tools ?? [];
	return buildSimulation(
		{
			tempDir,
			authStorage,
			storage: new MemorySessionStorage(),
			settings: simulationSettings(options.settings),
			modelRegistry: new ModelRegistry(authStorage, modelsConfigFile),
			tools,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			options,
		},
		true,
	);
}

export function whenSessionEvent(
	session: AgentSession,
	predicate: (event: AgentSessionEvent) => boolean,
): Promise<AgentSessionEvent> {
	const { promise, resolve } = Promise.withResolvers<AgentSessionEvent>();
	const unsubscribe = session.subscribe(event => {
		if (!predicate(event)) return;
		unsubscribe();
		resolve(event);
	});
	return promise;
}

export function lastAssistantText(session: AgentSession): string {
	const last = session.messages.at(-1);
	if (last?.role !== "assistant") return "";
	return last.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
}

export function toolResultTexts(session: AgentSession): string[] {
	const texts: string[] = [];
	for (const message of session.messages) {
		if (message.role !== "toolResult") continue;
		for (const block of message.content) {
			if (block.type === "text") texts.push(block.text);
		}
	}
	return texts;
}
