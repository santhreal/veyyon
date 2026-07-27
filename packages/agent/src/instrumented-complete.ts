/**
 * The one telemetry helper that makes a completion, kept out of the module that only describes one.
 *
 * WHY IT IS ITS OWN FILE. `telemetry.ts` is span vocabulary: attribute names, span lifecycles,
 * status mapping, the run collector. Everything in it is a description of work someone else does,
 * and it is imported by modules that never call a model. `instrumentedCompleteSimple` is the
 * exception: it RUNS a completion, so it names `completeSimple`, and that one import pulled the
 * whole streaming engine into every consumer of a span attribute. Measured at 281 modules of
 * `telemetry.ts`'s 366, and it propagated: `compaction/branch-summarization.ts` paid 190 for the
 * telemetry import alone.
 *
 * The split is by what a module DOES, not by size: describing a call and making one are different
 * jobs, and only one of them needs a provider.
 *
 * There is deliberately no re-export from `telemetry.ts`. The name is public through the package
 * entry point, which is where every consumer outside this package already takes it from, and a
 * re-export here would close an import cycle between the two files for no caller's benefit.
 */

import type { Attributes, Span } from "@opentelemetry/api";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@veyyon/ai";
import { completeSimple } from "@veyyon/ai/stream";
import {
	type AgentTelemetry,
	failChatSpan,
	finishChatSpan,
	PiGenAIAttr,
	runInActiveSpan,
	startChatSpan,
} from "./telemetry";
import { EventLoopKeepalive } from "./utils/yield";

/**
 * Options accepted by {@link instrumentedCompleteSimple}. Mirrors the
 * `streamAssistantResponse` chat-span lifecycle for oneshot LLM calls
 * (compaction summaries, handoff document, branch summary, inspect_image).
 */
export interface InstrumentedChatSpanOptions {
	readonly telemetry: AgentTelemetry | undefined;
	/** Optional explicit parent span. Defaults to `context.active()`. */
	readonly parent?: Span;
	/** Step index recorded on the span; defaults to `-1` for non-loop calls. */
	readonly stepNumber?: number;
	/**
	 * Tag stamped onto `pi.gen_ai.oneshot.kind`. Values used by the agent:
	 * `compaction_summary`, `compaction_short_summary`, `compaction_turn_prefix`,
	 * `handoff`, `branch_summary`, `inspect_image`. Free-form to allow callers
	 * outside this package to add new kinds without bumping the helper.
	 */
	readonly oneshotKind?: string;
	/** Extra span attributes applied verbatim. */
	readonly attributes?: Attributes;
	/**
	 * Override for the underlying {@link completeSimple} call. Defaults to
	 * `completeSimple` from `@veyyon/ai`. Use to retain a test injection
	 * seam while still going through the chat-span lifecycle.
	 */
	readonly completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
}

/**
 * Wrap a {@link completeSimple} round-trip with the same chat-span lifecycle
 * the agent loop uses for streamed turns: `startChatSpan` → run inside the
 * active span → `finishChatSpan` on success, `failChatSpan` on throw.
 *
 * Short-circuits when `telemetry` is `undefined` so cost / overhead stays at
 * zero for installations without an OTEL SDK.
 */
export async function instrumentedCompleteSimple<TApi extends Api>(
	model: Model<TApi>,
	ctx: Context,
	options: SimpleStreamOptions,
	span: InstrumentedChatSpanOptions,
): Promise<AssistantMessage> {
	// Oneshot LLM calls (handoff, compaction/branch summaries) run outside the
	// agent `#runLoop`, which is where the EventLoopKeepalive normally lives.
	// Without it, Bun's JSC loop stops servicing timers while parked on the
	// long-lived completion promise, freezing any host spinner (e.g. the
	// `/handoff` Loader) until an unrelated I/O event (a terminal resize)
	// pokes the loop. Keep the loop healthy for the duration of the call.
	using _keepalive = new EventLoopKeepalive();
	const { telemetry, parent, oneshotKind } = span;
	const stepNumber = span.stepNumber ?? -1;
	const reasoning = options.reasoning;
	const chatSpan = startChatSpan(telemetry, model, {
		parent,
		stepNumber,
		request: {
			maxTokens: options.maxTokens,
			temperature: options.temperature,
			topP: options.topP,
			topK: options.topK,
			presencePenalty: options.presencePenalty,
			serviceTier: options.serviceTier,
			reasoningEffort: typeof reasoning === "string" ? reasoning : undefined,
			toolChoice: options.toolChoice,
			tools: ctx.tools,
			systemPrompt: ctx.systemPrompt,
			messages: ctx.messages,
		},
	});
	if (chatSpan) {
		if (oneshotKind) chatSpan.setAttribute(PiGenAIAttr.OneshotKind, oneshotKind);
		if (span.attributes) chatSpan.setAttributes(span.attributes);
	}

	// Wrap the user-supplied onResponse so we always capture response headers
	// for the cost / gateway hooks without stealing them from the caller.
	let capturedHeaders: Readonly<Record<string, string>> | undefined;
	const userOnResponse = options.onResponse;
	const captureOnResponse: NonNullable<SimpleStreamOptions["onResponse"]> = (response, modelInfo) => {
		capturedHeaders = response.headers;
		return userOnResponse?.(response, modelInfo);
	};

	try {
		return await runInActiveSpan(chatSpan, async () => {
			const complete = span.completeImpl ?? completeSimple;
			const message = await complete(model, ctx, {
				...options,
				onResponse: captureOnResponse,
			});
			await finishChatSpan(telemetry, chatSpan, message, {
				stepNumber,
				serviceTier: options.serviceTier,
				responseHeaders: capturedHeaders,
				baseUrl: model.baseUrl,
			});
			return message;
		});
	} catch (err) {
		failChatSpan(telemetry, chatSpan, {
			errorObject: err,
			responseHeaders: capturedHeaders,
			baseUrl: model.baseUrl,
		});
		throw err;
	}
}
