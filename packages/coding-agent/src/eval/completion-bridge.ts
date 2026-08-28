import { instrumentedCompleteSimple, resolveTelemetry } from "@veyyon/agent-core";
import type { Api, Model, Tool } from "@veyyon/ai";
import { Effort } from "@veyyon/catalog/effort";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
import { type } from "arktype";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";

import {
	expandRoleAlias,
	formatModelString,
	getModelMatchPreferences,
	resolveModelFromString,
} from "../config/model-resolver";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { withBridgeTimeoutPause } from "./bridge-timeout";
import type { JsStatusEvent } from "./js/shared/types";

export const EVAL_COMPLETION_BRIDGE_NAME = "__completion__";

const STRUCTURED_TOOL_NAME = "respond";

type CompletionTier = "smol" | "default" | "slow";

const TIER_TO_PATTERN: Record<CompletionTier, string> = {
	smol: "@smol",
	default: "@default",
	slow: "@slow",
};

const completionArgsSchema = type({
	prompt: "string>0",
	"model?": "'smol'|'default'|'slow'",
	"system?": "string",
	"schema?": "Record<string,unknown>",
});

export interface EvalCompletionBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalCompletionResult {
	text: string;
	details: { model: string; tier: CompletionTier; structured: boolean };
}

function resolveTierModel(tier: CompletionTier, session: ToolSession): Model<Api> | undefined {
	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) return undefined;
	const available = modelRegistry.getAvailable();
	if (available.length === 0) return undefined;

	const matchPreferences = getModelMatchPreferences(session.settings);
	const resolve = (pattern: string | undefined): Model<Api> | undefined => {
		if (!pattern) return undefined;
		const expanded = expandRoleAlias(pattern, session.settings);
		return resolveModelFromString(expanded, available, matchPreferences);
	};

	if (tier === "default") {
		const activePattern = session.getActiveModelString?.() ?? session.getModelString?.();
		return resolve(activePattern) ?? resolve(TIER_TO_PATTERN.default);
	}
	return resolve(TIER_TO_PATTERN[tier]);
}

function reasoningForTier(tier: CompletionTier, model: Model<Api>): Effort | undefined {
	if (tier !== "slow" || !model.reasoning) return undefined;
	const efforts = getSupportedEfforts(model);
	if (efforts.length === 0) return undefined;
	return efforts.includes(Effort.High) ? Effort.High : efforts[efforts.length - 1];
}

function sanitizeProviderJson(
	value: unknown,
	sanitize: (text: string) => string,
	ancestors = new WeakSet<object>(),
): unknown {
	if (typeof value === "string") return sanitize(value);
	if (value === null || typeof value !== "object") return value;
	if (ancestors.has(value)) {
		throw new ToolError("completion() could not safely sanitize provider metadata.");
	}

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map(item => sanitizeProviderJson(item, sanitize, ancestors));
		}

		const sanitized: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) {
			const sanitizedKey = sanitize(key);
			if (Object.hasOwn(sanitized, sanitizedKey)) {
				throw new ToolError("completion() could not safely sanitize provider metadata.");
			}
			Object.defineProperty(sanitized, sanitizedKey, {
				value: sanitizeProviderJson(nested, sanitize, ancestors),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		return sanitized;
	} finally {
		ancestors.delete(value);
	}
}

export async function runEvalCompletion(
	args: unknown,
	options: EvalCompletionBridgeOptions,
): Promise<EvalCompletionResult> {
	const parsed = completionArgsSchema(args);
	if (parsed instanceof type.errors) {
		throw new ToolError(`completion() received invalid arguments: ${parsed.summary}`);
	}
	const { prompt, model: modelTier, system, schema } = parsed;
	const finalTier: CompletionTier = modelTier ?? "default";

	const model = resolveTierModel(finalTier, options.session);
	if (!model) {
		throw new ToolError(
			`completion() could not resolve a model for the "${finalTier}" tier. Configure modelRoles.${finalTier === "default" ? "default" : finalTier} or ensure a provider is available.`,
		);
	}

	const registry = options.session.modelRegistry;
	const apiKey = await registry?.getApiKey(model);
	if (!registry || !apiKey) {
		throw new ToolError(
			`completion() has no API key for ${formatModelString(model)}. Configure credentials for this provider or choose another tier.`,
		);
	}

	const sanitizeLive = (text: string): string => options.session.obfuscateProviderText?.(text) ?? text;
	const providerPrompt = sanitizeLive(prompt);
	const providerSystem = sanitizeLive(system ?? "You are a helpful assistant.");
	const providerSchema = schema ? (sanitizeProviderJson(schema, sanitizeLive) as Record<string, unknown>) : undefined;

	const tools: Tool[] | undefined = providerSchema
		? [
				{
					name: STRUCTURED_TOOL_NAME,
					description: "Return your answer by calling this tool with the requested structured fields.",
					parameters: providerSchema,
					strict: false,
				},
			]
		: undefined;

	const telemetry = resolveTelemetry(options.session.getTelemetry?.(), options.session.getSessionId?.() ?? undefined);

	const systemPrompt = [providerSystem];

	const response = await withBridgeTimeoutPause(options.emitStatus, () =>
		instrumentedCompleteSimple(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: providerPrompt }], timestamp: Date.now() }],
				tools,
			},
			{
				apiKey: registry.resolver(model, options.session.getSessionId?.() ?? undefined),
				signal: options.signal,
				reasoning: reasoningForTier(finalTier, model),
				toolChoice: schema ? { type: "tool", name: STRUCTURED_TOOL_NAME } : undefined,
				onPayload: payload => sanitizeProviderJson(payload, sanitizeLive),
			},
			{ telemetry, oneshotKind: "eval_completion" },
		),
	);

	if (response.stopReason === "error") {
		throw new ToolError(response.errorMessage ?? "completion() request failed.");
	}
	if (response.stopReason === "aborted") {
		throw new ToolError("completion() request aborted.");
	}

	let resultText: string;
	if (schema) {
		const call = extractToolCall(response, STRUCTURED_TOOL_NAME);
		let value: unknown;
		if (call) {
			value = call.arguments;
		} else {
			const text = extractTextContent(response);
			if (!text) throw new ToolError("completion() returned no structured response.");
			try {
				value = parseJsonPayload(text);
			} catch {
				throw new ToolError("completion() did not return a structured response matching the schema.");
			}
		}
		resultText = JSON.stringify(value);
	} else {
		resultText = extractTextContent(response);
		if (!resultText) throw new ToolError("completion() returned no text output.");
	}

	options.emitStatus?.({
		op: "completion",
		model: formatModelString(model),
		tier: finalTier,
		chars: resultText.length,
	});

	return {
		text: resultText,
		details: { model: formatModelString(model), tier: finalTier, structured: Boolean(schema) },
	};
}
