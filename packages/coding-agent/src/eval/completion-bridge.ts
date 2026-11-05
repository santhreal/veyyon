/**
 * Host-side handler for the eval `completion()` helper.
 *
 * Both eval runtimes (JS worker + Python kernel) route helper→host calls
 * through {@link callSessionTool}. Reserving the synthetic tool name
 * {@link EVAL_COMPLETION_BRIDGE_NAME} lets a single host handler serve both
 * transports without registering an agent-visible tool: cell code calls
 * `completion(prompt, opts)`, the prelude forwards `{ prompt, model?, system?, schema? }`
 * through the bridge, and this module performs one stateless completion.
 *
 * The call is oneshot and toolless from the model's perspective — pure text
 * in, text (or, with `schema`, a structured object) out.
 */
import { instrumentedCompleteSimple, resolveTelemetry } from "@veyyon/agent-core";
import type { Api, Model, Tool } from "@veyyon/ai";
import { type } from "@veyyon/ai/utils/schema/arktype";
import { lazy } from "@veyyon/utils";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";
import {
	formatModelString,
	getModelMatchPreferences,
	resolveModelFromString,
	resolveModelSelectorValue,
} from "../config/model-resolver";
import { helperReasoningOptions, helperSettingPath, resolveHelperModel } from "../task/helper-settings";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/core/tool-errors";
import { withBridgeTimeoutPause } from "./bridge-timeout";
import type { EvalBridgeOptions } from "./types";

/** Synthetic bridge name reserved for the `completion()` helper across both runtimes. */
export const EVAL_COMPLETION_BRIDGE_NAME = "__completion__";

/** Synthetic tool the model is forced to call when a `schema` is supplied. */
const STRUCTURED_TOOL_NAME = "respond";

/** The `model` value that names the session's active model. */
const SESSION_MODEL_SELECTOR = "default";

const completionArgsSchema = lazy(() =>
	type({
		prompt: "string>0",
		"model?": "string>0",
		"system?": "string",
		"schema?": "Record<string,unknown>",
	}),
);

export interface EvalCompletionBridgeOptions extends EvalBridgeOptions {}

export interface EvalCompletionResult {
	text: string;
	details: { model: string; structured: boolean };
}

interface CompletionModel {
	model: Model<Api>;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/**
 * Resolve the model a `completion()` call runs and its effort. An omitted
 * `model` runs the completion helper, which is the session's model until
 * `agent.helpers.completion.model` names another, at the helper's effort or
 * else the session's. `"default"` runs the session's active model at the
 * session's effort. Any other value is a model selector, and only its `:level`
 * suffix sets the effort. Throws a {@link ToolError} naming what to fix when
 * nothing matches.
 */
function resolveCompletionModel(selector: string | undefined, session: ToolSession): CompletionModel {
	const available = session.modelRegistry?.getAvailable() ?? [];
	if (available.length === 0) {
		throw new ToolError("completion() found no available model. Configure credentials for a provider.");
	}
	const matchPreferences = getModelMatchPreferences(session.settings);
	const activePattern = session.getActiveModelString?.() ?? session.getModelString?.();
	const activeModel = activePattern ? resolveModelFromString(activePattern, available, matchPreferences) : undefined;
	if (selector === undefined) {
		const helper = resolveHelperModel(session.settings, "completion", available, activeModel);
		if (!helper) {
			throw new ToolError(
				`completion() could not resolve a model: ${helperSettingPath("completion", "model")} matches no available model. Fix it in Agents → Roster → Helpers, or pass \`model\`.`,
			);
		}
		return { model: helper.model, thinkingLevel: helper.thinkingLevel ?? session.thinkingLevel };
	}
	if (selector === SESSION_MODEL_SELECTOR) {
		if (!activeModel) throw new ToolError("completion() could not resolve the session's active model.");
		return { model: activeModel, thinkingLevel: session.thinkingLevel };
	}
	const resolved = resolveModelSelectorValue(selector, available, { settings: session.settings, matchPreferences });
	if (!resolved.model) {
		throw new ToolError(`completion() could not resolve model "${selector}": it matches no available model.`);
	}
	return {
		model: resolved.model,
		thinkingLevel: resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined,
	};
}

/**
 * Clone provider-bound JSON metadata while applying the current confidentiality
 * transform to every string value and object key.
 *
 * JSON Schema property names are references: the same transform is therefore
 * applied to both `properties` keys and the corresponding `required` strings.
 * If two distinct keys collapse to the same redacted name, forwarding either
 * schema would silently change its meaning, so the request fails closed.
 */
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

/**
 * Run a single stateless completion on behalf of an eval cell's `completion()` call.
 * Returns a `{ text, details }` value shaped like a {@link callSessionTool}
 * result so the existing bridge transport carries it to either runtime.
 */
export async function runEvalCompletion(
	args: unknown,
	options: EvalCompletionBridgeOptions,
): Promise<EvalCompletionResult> {
	const parsed = completionArgsSchema.value(args);
	if (parsed instanceof type.errors) {
		throw new ToolError(`completion() received invalid arguments: ${parsed.summary}`);
	}
	const { prompt, model: selector, system, schema } = parsed;
	const { model, thinkingLevel } = resolveCompletionModel(selector, options.session);

	const registry = options.session.modelRegistry;
	const apiKey = await registry?.getApiKey(model);
	if (!registry || !apiKey) {
		throw new ToolError(
			`completion() has no API key for ${formatModelString(model)}. Configure credentials for this provider or choose another model.`,
		);
	}

	// Dereference the session callback at invocation time: credential resolution
	// and auth retry may install a newer secret runtime while this request waits.
	const sanitizeLive = (text: string): string => options.session.obfuscateProviderText?.(text) ?? text;
	// Sanitize caller-controlled raw fields before provider adapters can perform
	// any lossy normalization. The per-payload pass below repeats this at the
	// final physical-send seam with the then-current runtime.
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

	// Some providers (notably openai-codex) require a non-empty `instructions`
	// field on every Responses request and 400 with "Instructions are required"
	// when it is missing. Fall back to a minimal default so `completion(prompt)` works
	// without forcing every caller to pass a `system` prompt.
	const systemPrompt = [providerSystem];

	// Suspend eval timeout accounting while the model request owns control. The
	// timeout clock restarts once the bridge returns to the cell runtime.
	// `onPayload` is invoked after each credential resolution and for every
	// auth retry, so a runtime swapped by a 401 protects the next wire body.
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
				...helperReasoningOptions(model, thinkingLevel, undefined),
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
		chars: resultText.length,
	});

	return {
		text: resultText,
		details: { model: formatModelString(model), structured: Boolean(schema) },
	};
}
