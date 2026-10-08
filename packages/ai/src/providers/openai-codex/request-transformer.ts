import { Effort } from "@veyyon/catalog/effort";
import {
	statesOpenAIWireGeneration,
	supportsAllTurnsReasoningContext,
	supportsCodexReasoningSummary,
} from "@veyyon/catalog/identity";
import { requireSupportedEffort } from "@veyyon/catalog/model-thinking";
import type { Model } from "../../types";
import { mapOpenAIReasoningEffort, repairResponsesToolPairs } from "../openai-shared";

/** Reasoning replay scope for the Codex Responses API (`reasoning.context`). */
export type CodexReasoningContext = "auto" | "current_turn" | "all_turns";

/** User-facing effort levels accepted by Codex request options. */
type CodexCallerEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Caller literal → catalog `Effort` bridge (the enum is nominal). */
const EFFORT_BY_NAME: Record<CodexCallerEffort, Effort> = {
	minimal: Effort.Minimal,
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

export interface ReasoningConfig {
	effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	summary?: "auto" | "concise" | "detailed";
	context?: CodexReasoningContext;
	/** Pro reasoning serving mode (gpt-5.6+ catalog pro aliases). */
	mode?: "pro";
}

export interface CodexRequestOptions {
	/** User-facing effort; maps 1:1 onto the wire tier of the same name. */
	reasoningEffort?: CodexCallerEffort | "none";
	reasoningSummary?: ReasoningConfig["summary"] | null;
	/** Explicit `reasoning.context` override; defaults to `all_turns` when unset. Gated to gpt-5.4+ Codex models (older ids reject it, so it is suppressed and `context` omitted). Note that under Responses Lite (`responsesLite`), the server strictly requires `reasoning.context` to be `all_turns`, which overrides this option and forces `all_turns`. */
	reasoningContext?: CodexReasoningContext;
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
	/**
	 * Responses Lite transport override; defaults to the model's
	 * `useResponsesLite`. Lite moves instructions/tools into input items,
	 * strips image detail, and disables parallel tool calling (codex-rs
	 * `use_responses_lite`).
	 */
	responsesLite?: boolean;
}

export interface InputItem {
	id?: string | null;
	type?: string | null;
	role?: string;
	content?: unknown;
	call_id?: string | null;
	name?: string;
	output?: unknown;
	arguments?: unknown;
	/** `additional_tools` developer item payload (Responses Lite). */
	tools?: unknown;
}

export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	input?: InputItem[];
	tools?: unknown;
	tool_choice?: unknown;
	/** Concurrent reasoning-summary delivery (codex-rs `StreamOptions`). */
	stream_options?: { reasoning_summary_delivery: "sequential_cutoff" };
	// Sampling controls (temperature/top_p/top_k/min_p/presence_penalty/
	// repetition_penalty/frequency_penalty/stop) are intentionally absent: the
	// Codex backend rejects every one with a 400 `Unsupported parameter`, so
	// the transformer never sets them (#3117).
	reasoning?: Partial<ReasoningConfig>;
	text?: {
		verbosity?: "low" | "medium" | "high";
	};
	include?: string[];
	prompt_cache_key?: string;
	prompt_cache_retention?: "in_memory" | "24h";
	client_metadata?: Record<string, string>;
	max_output_tokens?: number;
	max_completion_tokens?: number;
	service_tier?: "auto" | "default" | "flex" | "scale" | "priority" | null;
	[key: string]: unknown;
}

/** The narrow view of a model both Codex reasoning-context rules read. */
type CodexReasoningContextModel = Pick<Model<"openai-codex-responses">, "id"> & { useResponsesLite?: boolean };

/**
 * Whether this model may be sent `reasoning.context: "all_turns"`.
 *
 * Two facts decide it, and this is the only place they meet. The version floor
 * reads a wire generation out of the id: pre-5.4 Codex ids (`gpt-5.1-codex`,
 * `gpt-5.3-codex`, `gpt-5.3-codex-spark`) reject `all_turns` with
 * `Unsupported value: 'all_turns' is not supported with this model`, and that
 * refusal is authoritative for any id that states a generation.
 *
 * A codename states none. The catalog ships two of those marked for the
 * Responses Lite transport (`codex-auto-review`, `gpt-daybreak-blue-latest`),
 * and that transport's server contract REQUIRES `all_turns`, so for an id the
 * floor cannot read, the lite flag is the evidence.
 */
export function acceptsAllTurnsReasoningContext(model: CodexReasoningContextModel): boolean {
	if (supportsAllTurnsReasoningContext(model.id)) return true;
	return !statesOpenAIWireGeneration(model.id) && model.useResponsesLite === true;
}

/**
 * Resolves whether a Codex request uses the Responses Lite transport.
 *
 * This is the single authority for lite enablement across every Codex request
 * builder: the HTTP SSE body, the WebSocket frame and its upgrade headers,
 * prewarming, server-side compaction, and web search.
 *
 * The lite transport requires `reasoning.context: "all_turns"` on the wire, so
 * a model that cannot be sent that value ({@link acceptsAllTurnsReasoningContext})
 * is structurally ineligible: the marker header, the client metadata and the
 * lite body shape are all suppressed and the request goes out on the regular
 * Responses transport, whatever the catalog flag or the caller asked for. The
 * two rules therefore cannot disagree about one request, which is what sent a
 * lite-marked request with no `context` and earned
 * `X-OpenAI-Internal-Codex-Responses-Lite requires reasoning.context to be all_turns`.
 */
export function resolveCodexResponsesLite(model: CodexReasoningContextModel, requested?: boolean): boolean {
	if (!acceptsAllTurnsReasoningContext(model)) {
		return false;
	}
	return requested ?? model.useResponsesLite === true;
}

/**
 * Clamp a user-facing effort to the model's ladder, then remap to the wire
 * tier. User efforts map 1:1 onto wire tiers; the effort map only covers
 * host quirks where a wire tier genuinely does not exist (e.g. `minimal→none`).
 * A mapped value outside the Codex wire vocabulary is a broken compat/model
 * effort map — fail loudly rather than silently sending a different tier.
 */
function mapCodexWireEffort(
	model: Model<"openai-codex-responses">,
	effort: CodexCallerEffort,
): ReasoningConfig["effort"] {
	const mapped = mapOpenAIReasoningEffort(model, model.compat, requireSupportedEffort(model, EFFORT_BY_NAME[effort]));
	switch (mapped) {
		case "none":
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return mapped;
		default:
			throw new Error(
				`Effort map for ${model.provider}/${model.id} produced invalid Codex reasoning effort "${mapped}"`,
			);
	}
}

function getReasoningConfig(
	model: Model<"openai-codex-responses">,
	effort: NonNullable<CodexRequestOptions["reasoningEffort"]>,
	options: CodexRequestOptions,
): ReasoningConfig {
	const config: ReasoningConfig = {
		effort: effort === "none" ? "none" : mapCodexWireEffort(model, effort),
	};
	// `reasoning.summary` is accepted only from gpt-5.4 onward; earlier Codex ids
	// (gpt-5.1-codex, gpt-5.3-codex, gpt-5.3-codex-spark) reject it with
	// "Unsupported parameter: 'reasoning.summary' is not supported with this model".
	// Mirrors the all_turns gate: an explicit summary is suppressed on unsupported
	// ids, letting the server skip the human-readable summary stream.
	if (options.reasoningSummary !== null && supportsCodexReasoningSummary(model.id)) {
		config.summary = options.reasoningSummary ?? "detailed";
	}
	return config;
}

/** The input without `item_reference` items and with every item's `id` dropped, in one pass. */
function filterInput(input: readonly InputItem[]): InputItem[] {
	const out: InputItem[] = [];
	for (const item of input) {
		if (item.type === "item_reference") continue;
		if (item.id == null) {
			out.push(item);
			continue;
		}
		const { id: _id, ...rest } = item;
		out.push(rest);
	}
	return out;
}

/** Clears `detail` on every `input_image` part of one message content or tool output array. */
function stripPartDetails(collection: unknown): void {
	if (!Array.isArray(collection)) return;
	for (const part of collection) {
		if (!part || typeof part !== "object" || !("type" in part) || part.type !== "input_image") continue;
		if ("detail" in part) part.detail = undefined;
	}
}

/**
 * Responses Lite requests must not pin image detail levels: codex-rs strips
 * `detail` from every input image (message content and tool outputs) before
 * sending, letting the server choose.
 */
function stripImageDetails(input: unknown[]): void {
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		if ("content" in item) stripPartDetails(item.content);
		if ("output" in item) stripPartDetails(item.output);
	}
}

/**
 * Structural view of a Responses-style body mutated by the Lite rewrite.
 * Loose (`unknown`) property types let the turn transformer (`RequestBody`)
 * and the agent's remote-compaction payloads reuse one shaper.
 */
export interface CodexLiteShapedBody {
	instructions?: unknown;
	tools?: unknown;
	input?: unknown;
	parallel_tool_calls?: unknown;
	reasoning?: { context?: string } & Record<string, unknown>;
}

/**
 * Applies the Responses Lite body contract in place (codex-rs
 * `build_responses_request` with `use_responses_lite`): strips pinned image
 * detail, forces parallel tool calling off, moves tools into a leading
 * `additional_tools` developer item and the base instructions into a
 * developer message, then omits top-level `instructions`/`tools`. Shared by
 * normal turns and both remote-compaction paths — codex-rs routes the
 * compaction request through the same builder.
 *
 * `reasoning.context` is forced to `all_turns` here because the lite marker
 * header and that value are one contract: the backend answers a lite request
 * without it `X-OpenAI-Internal-Codex-Responses-Lite requires reasoning.context
 * to be all_turns`. Setting it in the shaper rather than in each caller is why
 * the compaction body cannot drift from the turn body again.
 *
 * The developer instruction block carries no `prompt_cache_breakpoint`: the
 * ChatGPT Codex backend rejects that field with `invalid_parameter` and fails
 * the turn, and codex-rs never sends it. Codex caching is keyed by
 * `prompt_cache_key` plus a byte-stable prefix, nothing else.
 */
export function applyCodexResponsesLiteShape(body: CodexLiteShapedBody): void {
	const input = Array.isArray(body.input) ? body.input : [];
	stripImageDetails(input);
	body.parallel_tool_calls = false;
	body.reasoning = { ...body.reasoning, context: "all_turns" };
	const prefix: InputItem[] = [
		{ type: "additional_tools", role: "developer", tools: Array.isArray(body.tools) ? body.tools : [] },
	];
	if (typeof body.instructions === "string" && body.instructions.length > 0) {
		prefix.push({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: body.instructions }],
		});
	}
	body.input = prefix.concat(input);
	delete body.instructions;
	delete body.tools;
}

/** The input with references and item ids dropped, every tool call paired, and the prompt's developer messages first. */
function prepareInput(body: RequestBody, developerMessages: readonly string[] | undefined): void {
	if (Array.isArray(body.input)) body.input = repairResponsesToolPairs(filterInput(body.input));
	if (developerMessages === undefined || developerMessages.length === 0) return;
	const input = Array.isArray(body.input) ? body.input : [];
	const prefix = developerMessages.map(
		(text): InputItem => ({ type: "message", role: "developer", content: [{ type: "input_text", text }] }),
	);
	body.input = prefix.concat(input);
}

/** The last non-blank `input_text` in `input`, read from its last item and that item's last part back. */
function lastInstructionText(input: readonly InputItem[]): string | undefined {
	for (let itemIndex = input.length - 1; itemIndex >= 0; itemIndex -= 1) {
		const content = input[itemIndex].content;
		if (!Array.isArray(content)) continue;
		for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
			const part: unknown = content[partIndex];
			if (!part || typeof part !== "object" || !("type" in part) || part.type !== "input_text") continue;
			if ("text" in part && typeof part.text === "string" && part.text.trim().length > 0) return part.text;
		}
	}
	return undefined;
}

/**
 * The instruction a request with only developer input repeats as a user message: the prompt's last non-blank
 * developer message, else the last non-blank `input_text` of the developer input, else non-blank `instructions`.
 */
function finalInstruction(
	body: RequestBody,
	input: readonly InputItem[],
	developerMessages: readonly string[] | undefined,
): string | undefined {
	const fromPrompt = developerMessages?.findLast(text => text.trim().length > 0);
	if (fromPrompt !== undefined) return fromPrompt;
	const fromInput = lastInstructionText(input);
	if (fromInput !== undefined) return fromInput;
	return typeof body.instructions === "string" && body.instructions.trim().length > 0 ? body.instructions : undefined;
}

/** Appends the final instruction as a user message when every input item is a developer message. */
function ensureVisibleInput(body: RequestBody, developerMessages: readonly string[] | undefined): void {
	const input = Array.isArray(body.input) ? body.input : [];
	if (input.some(item => item.role !== "developer")) return;
	const instruction = finalInstruction(body, input, developerMessages);
	if (instruction === undefined) return;
	body.input = [...input, { type: "message", role: "user", content: [{ type: "input_text", text: instruction }] }];
}

/** Sets `reasoning` from the requested effort, summary and replay context, or deletes it when neither applies. */
function applyReasoning(
	body: RequestBody,
	model: Model<"openai-codex-responses">,
	options: CodexRequestOptions,
	responsesLite: boolean,
): void {
	if (options.reasoningEffort === undefined && !responsesLite) {
		delete body.reasoning;
		return;
	}
	const reasoningConfig =
		options.reasoningEffort !== undefined ? getReasoningConfig(model, options.reasoningEffort, options) : {};
	const reasoning: Partial<ReasoningConfig> = { ...body.reasoning, ...reasoningConfig };
	body.reasoning = reasoning;
	// Default reasoning replay to `all_turns`, mirroring codex-rs; an
	// explicit `reasoningContext` overrides the default. A model that cannot
	// be sent `all_turns` ({@link acceptsAllTurnsReasoningContext}) has
	// `context` dropped instead, and the server applies its `current_turn`
	// default; that gate is authoritative, so even an explicit `all_turns`
	// override is suppressed there, while `current_turn` and `auto` are
	// universally supported and always pass through. Responses Lite forces
	// `all_turns` because its server contract requires it, and it is only
	// ever on for a model that accepts the value.
	const context = responsesLite ? "all_turns" : (options.reasoningContext ?? "all_turns");
	if (context === "all_turns" && !acceptsAllTurnsReasoningContext(model)) {
		delete reasoning.context;
	} else {
		reasoning.context = context;
	}
}

export async function transformRequestBody(
	body: RequestBody,
	model: Model<"openai-codex-responses">,
	options: CodexRequestOptions = {},
	prompt?: { developerMessages: string[] },
): Promise<RequestBody> {
	body.store = false;
	body.stream = true;

	prepareInput(body, prompt?.developerMessages);
	ensureVisibleInput(body, prompt?.developerMessages);

	const responsesLite = resolveCodexResponsesLite(model, options.responsesLite);
	if (responsesLite) {
		applyCodexResponsesLiteShape(body);
	}
	applyReasoning(body, model, options, responsesLite);
	// Catalog pro aliases (`gpt-5.6-*-pro`): applied after the effort branch so
	// the mode is sent even when no effort is set (the branch above deletes
	// `body.reasoning` in that case) — mode and effort are independent fields.
	if (model.reasoningMode) {
		body.reasoning = { ...body.reasoning, mode: model.reasoningMode };
	}

	// Concurrent reasoning summaries (codex-rs `concurrent_reasoning_summaries`
	// feature): `sequential_cutoff` lets the server stream output without
	// blocking on summary generation. Only meaningful when a summary is
	// requested; codex-rs additionally gates on its OpenAI provider check,
	// which is inherent here.
	if (body.reasoning?.summary !== undefined) {
		body.stream_options = { reasoning_summary_delivery: "sequential_cutoff" };
	} else {
		delete body.stream_options;
	}

	body.text = {
		...body.text,
		verbosity: options.textVerbosity || "medium",
	};

	const include = Array.isArray(options.include) ? options.include.slice() : [];
	include.push("reasoning.encrypted_content");
	body.include = Array.from(new Set(include));

	delete body.max_output_tokens;
	delete body.max_completion_tokens;

	return body;
}
