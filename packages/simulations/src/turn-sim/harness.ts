/**
 * Deterministic, offline turn simulations.
 *
 * Every other AgentSession suite in this tree hands `Agent` a bespoke
 * `streamFn`, which skips the whole provider transport: the lazy-stream
 * wrapper, its idle/first-event watchdog, the loop guard, the retry
 * classifier. Those are exactly the layers that decide whether a wedged turn
 * ends or hangs, so a suite that bypasses them can only ever simulate a
 * provider that behaves.
 *
 * This harness drives the real path instead:
 *
 *   AgentSession -> Agent -> createSettingsAwareStreamFn(settings)
 *     -> streamSimple -> stream() -> loop guard -> streamBedrock
 *     -> createLazyStream/forwardStream (idle watchdog)
 *     -> the scripted module installed here
 *
 * `bedrock-converse-stream` is the seam because it is the only builtin lazy
 * provider that (a) exposes a module override for tests
 * (`setBedrockProviderModule`) and (b) takes the no-API-key branch of
 * `streamSimple`, so nothing reaches for a credential or the network.
 *
 * Determinism rules this file exists to enforce:
 *  - No wall-clock sleeps anywhere. Scripts advance on promises the test
 *    resolves, and the only real timers are the product's own watchdogs.
 *  - Those watchdogs run on budgets the simulation configures through the
 *    shipped settings (`providers.streamIdleTimeoutSeconds`,
 *    `providers.streamFirstEventTimeoutSeconds`), not on their 100s/120s
 *    production defaults.
 *  - A scenario whose failure mode is "never terminates" is asserted by
 *    awaiting the turn. A hang fails the test by timing out; there is no
 *    assertion that can be satisfied by a stuck session.
 */
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, ToolCall, ToolChoice } from "@veyyon/ai";
import { setBedrockProviderModule } from "@veyyon/ai/providers/register-builtins";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";
import { emptyUsage } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { TtsrManager } from "@veyyon/coding-agent/export/ttsr";
import { AgentSession, type AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { createSettingsAwareStreamFn } from "@veyyon/coding-agent/session/settings-stream-fn";
import { wrapStreamFnWithProviderConcurrency } from "@veyyon/coding-agent/task/provider-concurrency";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

const SIM_API = "bedrock-converse-stream" as const;

/**
 * Watchdog budgets every simulation runs under, in seconds (the unit the
 * shipped setting takes). 0.3s is long enough that a healthy scripted stream
 * on a loaded container never trips it (its events are microtask-adjacent) and
 * short enough that a genuinely silent provider is caught inside a test
 * timeout.
 */
export const SIM_IDLE_BUDGET_SECONDS = 0.3;
export const SIM_FIRST_EVENT_BUDGET_SECONDS = 0.3;

/**
 * Price every simulated token at the same rate. A scenario asserting cost then
 * states `tokens * SIM_COST_PER_TOKEN` rather than reproducing a price table,
 * and a rate this large keeps the products exact in floating point.
 */
export const SIM_COST_PER_TOKEN = 0.001;

/** Handle a script uses to emit provider events for one turn. */
export interface ScriptedTurn {
	/** The live provider stream. Push raw events for shapes the helpers omit. */
	readonly stream: AssistantMessageEventStream;
	/** 1-based index of this provider call within the simulation. */
	readonly call: number;
	/**
	 * The model this call was routed to. A session can switch models between
	 * turns, or in the middle of one, and this is the only place a scenario can
	 * see which model actually served a request rather than which one the session
	 * says it holds now.
	 */
	readonly model: Model<Api>;
	/** The context the agent sent, so a script can react to conversation state. */
	readonly context: Context;
	/** The provider-side abort signal, i.e. what a user cancel reaches. */
	readonly signal: AbortSignal | undefined;
	/**
	 * What the loop demanded of this call, when it demanded anything: `required`
	 * forces some tool, a name forces that one. A forced choice is queued by one
	 * turn and spent by the next, so this is the only way a scenario can see that
	 * a reminder's demand reached the provider, or that it leaked onto a later
	 * turn it was never meant for.
	 */
	readonly toolChoice: ToolChoice | undefined;
	/**
	 * The pair providers route prompt caching on: they use
	 * `promptCacheKey ?? sessionId`. Every side request the session makes for the
	 * same conversation (compaction, a summary, an advisor) is supposed to send
	 * what the live turns sent, so this is the only place a scenario can see a
	 * request that would cold-miss the cache the live turns paid to populate.
	 */
	readonly cacheRouting: { readonly sessionId: string | undefined; readonly promptCacheKey: string | undefined };
	/** Emit a complete text block. */
	text(value: string): void;
	/**
	 * Emit a complete reasoning block. A `signature` is what a provider hands
	 * back to prove the block is replayable verbatim; a block without one is
	 * reasoning the session may not send back unchanged.
	 */
	thinking(value: string, signature?: string): void;
	/** Emit `thinking_start` + a delta and never close it: reasoning cut short. */
	openThinking(partialValue: string): void;
	/** Emit a complete tool call block. */
	toolCall(name: string, args: Record<string, unknown>, id?: string): void;
	/** Emit `toolcall_start` + a partial argument delta and never close it. */
	openToolCall(name: string, partialArgs: string, id?: string): void;
	/**
	 * Report what this request cost. Providers stream usage and the turn's stored
	 * assistant message carries it; a simulation that never sets it leaves every
	 * token count at zero, which is what makes a spend or budget assertion
	 * meaningless. Cost is derived from the token counts at a flat rate so a
	 * scenario states one number per field.
	 */
	usage(counts: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): void;
	/**
	 * Terminate the turn normally. The reasons a provider can END a stream with
	 * are these three; `aborted` and `error` arrive on other events, so they are
	 * not spellable here.
	 */
	finish(reason?: "stop" | "toolUse" | "length"): void;
	/** Terminate the turn with a provider error the retry classifier will see. */
	fail(message: string): void;
	/** Report local work in flight, the way a server-driven tool bridge does. */
	trackLocalWork(work: Promise<unknown>): Promise<void>;
	/**
	 * Called every time the watchdog consults this stream's local-work state at
	 * an expired deadline. The only causal hook a simulation has for "the idle
	 * budget has genuinely been exceeded", so scenarios never guess durations.
	 */
	onLocalWorkProbe(callback: (probeCount: number) => void): void;
}

/** One provider call, scripted. Return when the turn's events are all queued. */
export type ProviderScript = (turn: ScriptedTurn) => void | Promise<void>;

/**
 * The stream the scripted module returns.
 *
 * `forwardStream` only consults `hasPendingLocalWork` when a deadline has
 * ALREADY expired, so overriding the getter gives a simulation a causal signal
 * that the watchdog budget was genuinely exceeded. Without it a local-work
 * scenario would have to guess a duration, which is the flake this lane exists
 * to eliminate.
 */
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

// Installed once at module load. The override is a stable dispatcher: tests
// swap the script, never the module, so nothing races the lazy loader's cache.
setBedrockProviderModule({
	streamBedrock: (model, context, options) => {
		const script = activeScript;
		callCount += 1;
		const call = callCount;
		const stream = new SimulatedProviderStream();
		if (!script) {
			queueMicrotask(() => stream.fail(new Error("simulation: no provider script installed")));
			return stream;
		}
		void runScript(script, stream, model, context, options as SimpleStreamOptions, call);
		return stream;
	},
});

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

	const turn: ScriptedTurn = {
		stream,
		call,
		context,
		model,
		signal: options?.signal,
		toolChoice: options?.toolChoice,
		cacheRouting: {
			sessionId: options?.sessionId,
			promptCacheKey: options?.promptCacheKey,
		},
		text(value) {
			const index = content.length;
			content.push({ type: "text", text: value });
			stream.push({ type: "text_start", contentIndex: index, partial });
			stream.push({ type: "text_delta", contentIndex: index, delta: value, partial });
			stream.push({ type: "text_end", contentIndex: index, content: value, partial });
		},
		thinking(value, signature) {
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
			const index = content.length;
			content.push({ type: "thinking", thinking: partialValue });
			stream.push({ type: "thinking_start", contentIndex: index, partial });
			stream.push({ type: "thinking_delta", contentIndex: index, delta: partialValue, partial });
		},
		toolCall(name, args, id) {
			toolCallSeq += 1;
			const block: ToolCall = {
				type: "toolCall",
				id: id ?? `sim-call-${call}-${toolCallSeq}`,
				name,
				arguments: args,
			};
			const index = content.length;
			content.push(block);
			stream.push({ type: "toolcall_start", contentIndex: index, partial });
			stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(args), partial });
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial });
		},
		openToolCall(name, partialArgs, id) {
			toolCallSeq += 1;
			const block: ToolCall = { type: "toolCall", id: id ?? `sim-open-${call}-${toolCallSeq}`, name, arguments: {} };
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
			// One flat rate per token so a scenario can state an expected cost as a
			// count times the rate instead of carrying a price table.
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
		fail(message) {
			if (ended) return;
			ended = true;
			const errored = baseMessage(model, []);
			errored.stopReason = "error";
			errored.errorMessage = message;
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

/** Install the script the next provider calls will run. */
export function installScript(script: ProviderScript): void {
	activeScript = script;
}

/** Drop the script and reset the call counter. Call from `afterEach`. */
export function resetScript(): void {
	activeScript = undefined;
	callCount = 0;
}

/**
 * A script built from a fixed list of per-call behaviours. Calls past the end
 * of the list reuse the last entry, which keeps a runaway loop scripted rather
 * than crashing on an exhausted iterator.
 */
export function scriptTurns(...turns: ProviderScript[]): ProviderScript {
	return async turn => {
		const step = turns[Math.min(turn.call, turns.length) - 1];
		if (!step) throw new Error("simulation: empty turn script");
		await step(turn);
	};
}

/** Build a simulated model. `id` matters: the loop guard keys off it. */
export function simulatedModel(id = "sim-model", options?: SimulatedModelOptions): Model<typeof SIM_API> {
	return buildModel({
		id,
		name: id,
		api: SIM_API,
		provider: options?.provider ?? "amazon-bedrock",
		baseUrl: "https://simulation.invalid",
		reasoning: options?.reasoning ?? false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options?.contextWindow ?? 200_000,
		maxTokens: 32_768,
	});
}

export interface SimulatedModelOptions {
	/**
	 * Provider id. Keep the bedrock default unless a scenario needs another
	 * provider's settings surface (e.g. `ollama-cloud` is the one provider with
	 * a `maxConcurrency` semaphore). The scripted transport keys off the API,
	 * so any provider id still routes to the script.
	 */
	provider?: string;
	/** Shrink the window when a scenario needs compaction to engage. */
	contextWindow?: number;
	/**
	 * Declare the model as a reasoning model. The capability is what the session
	 * consults before it offers a thinking level, so a scenario that scripts
	 * reasoning blocks sets it rather than relying on the provider accepting
	 * blocks from a model that claims it cannot produce them.
	 */
	reasoning?: boolean;
}

const ANY_OBJECT = type("object");

/** Define a tool for a simulation. Defaults keep the declaration to one line. */
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

export interface SimulationOptions {
	script: ProviderScript;
	tools?: AgentTool[];
	settings?: Record<string, unknown>;
	modelId?: string;
	/** Model options (provider id, context window) for the simulated model. */
	model?: SimulatedModelOptions;
	/**
	 * Mirror the production wiring in sdk.ts: the settings-aware stream fn
	 * wrapped in the per-provider concurrency limiter. Off by default because
	 * only providers with a `maxConcurrency` setting (ollama-cloud) get a
	 * semaphore; pair with `model: { provider: "ollama-cloud" }`.
	 */
	providerConcurrency?: boolean;
	/** Stream-matched rule engine, when a scenario needs rules to fire. */
	ttsrManager?: TtsrManager;
}

export interface Simulation {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly modelRegistry: ModelRegistry;
	readonly events: AgentSessionEvent[];
	/** Events of one type, in order. */
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Array<Extract<AgentSessionEvent, { type: T }>>;
	/** Number of provider calls the simulation has served. */
	providerCalls(): number;
	dispose(): Promise<void>;
}

/**
 * Settings shared by every simulation. Compaction is off (it would fire a
 * second, unscripted provider call), retries are fast and capped (the product
 * default is 10 attempts at 500ms base backoff, which is a wall-clock sleep by
 * another name), and the watchdog budgets are the ones above.
 */
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

export async function createSimulation(options: SimulationOptions): Promise<Simulation> {
	installScript(options.script);
	const tempDir = TempDir.createSync("@pi-simulation-");
	const authStorage = await AuthStorage.create(`${tempDir.path()}/auth.db`);
	// The session refuses to prompt a provider it holds no credential for, so
	// the simulation registers a runtime key. Nothing reads it: the scripted
	// module replaces the transport before any request is shaped.
	authStorage.setRuntimeApiKey("amazon-bedrock", "simulation-key");
	if (options.model?.provider) {
		authStorage.setRuntimeApiKey(options.model.provider, "simulation-key");
	}
	const modelRegistry = new ModelRegistry(authStorage, `${tempDir.path()}/models.yml`);
	const settings = simulationSettings(options.settings);
	const sessionManager = SessionManager.inMemory(tempDir.path());

	// The session keeps its own registry of every tool it can run, and several
	// production paths ask it rather than the agent state: plan-mode convergence
	// refuses to force a decision unless `ask` and `resolve` are both registered,
	// and a renamed tool is resolved through it. A simulation whose registry was
	// empty could not reach those paths at all, so the same list the agent gets is
	// registered here, keyed by name exactly as production does.
	const tools = options.tools ?? [];
	const toolRegistry = new Map(tools.map(tool => [tool.name, tool]));

	const baseStreamFn = createSettingsAwareStreamFn(settings);
	// The loop asks the HOST for the turn's tool-choice directive; the session is
	// what answers, and it is built after the agent, so the callback reads a
	// binding assigned below. This is the same shape production uses (sdk.ts), and
	// without it a forced choice a settle reminder queues is queued into nothing:
	// the demand is spent by the loop, never reaches the provider, and a
	// simulation would report a reminder working when it does not.
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
		streamFn: options.providerConcurrency
			? wrapStreamFnWithProviderConcurrency(settings, baseStreamFn)
			: baseStreamFn,
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry,
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
		modelRegistry,
		events,
		eventsOfType(type) {
			return events.filter(event => event.type === type) as Array<Extract<AgentSessionEvent, { type: typeof type }>>;
		},
		providerCalls: () => callCount,
		async dispose() {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
			resetScript();
		},
	};
}

/**
 * Await a condition the session drives, without a sleep.
 *
 * Every hook a simulation needs is an emitted `AgentSessionEvent`, so this
 * subscribes and re-checks on each event instead of polling a clock. If the
 * condition never holds the returned promise never settles, and the test times
 * out. That is deliberate: a stuck session must fail, not pass late.
 */
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

/** Text of the last assistant message, or "" when the tail is not assistant. */
export function lastAssistantText(session: AgentSession): string {
	const last = session.messages.at(-1);
	if (last?.role !== "assistant") return "";
	return last.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
}

/** Every tool-result text the session recorded, in order. */
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
