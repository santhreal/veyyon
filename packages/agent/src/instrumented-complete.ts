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

export const ONESHOT_KINDS = [
	"compaction_summary",
	"compaction_turn_prefix",
	"handoff",
	"branch_summary",
	"inspect_image",
	"eval_completion",
	"guided_goal_setup",
] as const;

export type OneshotKind = (typeof ONESHOT_KINDS)[number] | (string & {});

export interface InstrumentedChatSpanOptions {
	readonly telemetry: AgentTelemetry | undefined;
	readonly parent?: Span;
	readonly stepNumber?: number;
	readonly oneshotKind?: OneshotKind;
	readonly attributes?: Attributes;
	readonly completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
}

function sideConversationId(options: SimpleStreamOptions, oneshotKind: string | undefined): string | undefined {
	if (options.conversationId !== undefined) return options.conversationId;
	if (options.sessionId === undefined) return undefined;
	const kind = oneshotKind && oneshotKind.length > 0 ? oneshotKind : "oneshot";
	return `${options.sessionId}#${kind}`;
}

export async function instrumentedCompleteSimple<TApi extends Api>(
	model: Model<TApi>,
	ctx: Context,
	options: SimpleStreamOptions,
	span: InstrumentedChatSpanOptions,
): Promise<AssistantMessage> {
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
				conversationId: sideConversationId(options, oneshotKind),
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
