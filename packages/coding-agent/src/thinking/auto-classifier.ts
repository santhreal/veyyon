/**
 * Per-prompt difficulty classifier for the `auto` thinking level.
 *
 * Picks a coding-difficulty bucket for a user prompt and maps it to a concrete
 * {@link Effort}, clamped into the active model's supported range (never below
 * {@link Effort.Low}). Two backends, selected by `providers.autoThinkingModel`:
 *
 * - `online` (default): the `autoThinking` helper model classifies into `low|medium|high|xhigh`.
 * - a local key: an on-device memory model classifies into the coarser
 *   `trivial|moderate|hard` scheme (3-class is more reliable than 4-way ordinal
 *   on sub-2B models), mapped to `low|high|xhigh`.
 *
 * Throws on any failure (no model, no key, unparseable output, abort/timeout);
 * the caller falls back to a concrete level and continues the turn.
 */
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { ApiKeyResolver, Context, Model } from "@veyyon/ai";
import { completeSimple } from "@veyyon/ai/stream";
import { assistantText } from "@veyyon/ai/utils/message-text";
import { Effort } from "@veyyon/catalog/effort";
import { REASONING_SAFE_MAX_TOKENS } from "@veyyon/kernel/session/classifier-tokens";
import type { SideCompleteImpl } from "@veyyon/kernel/session/side-complete";
import { prompt } from "@veyyon/utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { thinkingPrompts } from "../prompts/thinking/rows";
import { withAtomicSecretPlaceholders } from "../secrets/placeholder";
import {
	helperMaxTokens,
	helperReasoningOptions,
	helperSettingPath,
	resolveHelperModel,
} from "../task/helper-settings";
import { preprocessTinyMessage } from "../tiny/message-preproc";
import {
	isTinyMemoryLocalModelKey,
	isTinyMemoryReasoningModelKey,
	ONLINE_AUTO_THINKING_MODEL_KEY,
} from "../tiny/models";
import { tinyTitleClient } from "../tiny/title-client";
import { clampAutoThinkingEffort } from ".";

const DIFFICULTY_SYSTEM_PROMPT = prompt.render(thinkingPrompts["thinking/difficulty"].text);

/** Local classifiers occasionally need more room for chat-template boilerplate. */
const LOCAL_ANSWER_MAX_TOKENS = 16;

export interface ClassifyDifficultyDeps {
	settings: Settings;
	registry: ModelRegistry;
	model: Model;
	sessionId?: string;
	signal?: AbortSignal;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	/** Final confidentiality boundary for text sent to an online classifier. */
	obfuscateProviderText?: (text: string) => string;
	/**
	 * Transport for the online classification. Absent means a bare
	 * `completeSimple`: no watchdog and outside every cap, on a request that runs
	 * once per prompt while the operator waits for the turn to start.
	 */
	completeImpl?: SideCompleteImpl;
}

/**
 * Classify `promptText` and return a concrete effort clamped to `deps.model`,
 * or `undefined` when the model has no controllable effort surface (auto has
 * nothing to pick — the caller leaves the prior reasoning level in place).
 * @throws when the backend cannot produce a usable classification.
 */
export async function classifyDifficulty(
	promptText: string,
	deps: ClassifyDifficultyDeps,
): Promise<Effort | undefined> {
	const backend = deps.settings.get("providers.autoThinkingModel");
	const effort =
		backend === ONLINE_AUTO_THINKING_MODEL_KEY
			? await classifyOnline(promptText, deps)
			: await classifyLocal(preprocessTinyMessage(promptText), backend, deps);
	return clampAutoThinkingEffort(deps.model, effort);
}

async function classifyOnline(input: string, deps: ClassifyDifficultyDeps): Promise<Effort> {
	// An unset `autoThinking` helper runs the live main model (the classification prompt is tiny).
	const selection = resolveHelperModel(deps.settings, "autoThinking", deps.registry.getAvailable(), deps.model);
	const model = selection?.model;
	if (!model) {
		throw new Error(
			`auto-thinking: ${helperSettingPath("autoThinking", "model")} matches no available model for classification`,
		);
	}
	const apiKey = await deps.registry.getApiKey(model, deps.sessionId);
	if (!apiKey) {
		throw new Error(`auto-thinking: no API key for ${model.provider}/${model.id}`);
	}
	// Resolve metadata after getApiKey so the session-sticky credential is recorded first.
	const metadata = deps.metadataResolver?.(model.provider);
	// The session's effort is `auto` while this runs, which is the level being chosen, so a helper
	// that names no effort classifies with reasoning off rather than at a previous turn's level.
	const reasoning = helperReasoningOptions(model, selection?.thinkingLevel, ThinkingLevel.Off);
	const maxTokens = helperMaxTokens(reasoning, REASONING_SAFE_MAX_TOKENS);
	const requestContext: Context = { systemPrompt: [], messages: [] };
	const refreshProviderContext = (): void => {
		const sanitize = deps.obfuscateProviderText ?? ((text: string) => text);
		// Exact secret replacement must precede lossy tiny-message preprocessing:
		// otherwise middle truncation can leave a no-longer-matchable secret prefix.
		const providerInput = withAtomicSecretPlaceholders(sanitize(input), preprocessTinyMessage);
		requestContext.systemPrompt = [sanitize(DIFFICULTY_SYSTEM_PROMPT)];
		requestContext.messages = [
			{
				role: "user",
				content: providerInput,
				timestamp: Date.now(),
			},
		];
	};
	refreshProviderContext();
	const resolveApiKey = deps.registry.resolver(model, deps.sessionId);
	const resolveAttemptApiKey: ApiKeyResolver = async options => {
		const key = await resolveApiKey(options);
		// Rebuild from raw input after every credential refresh so each physical
		// auth retry sees the current runtime rather than a stale transformed copy.
		refreshProviderContext();
		return key;
	};

	const complete = deps.completeImpl ?? completeSimple;
	const response = await complete(model, requestContext, {
		apiKey: resolveAttemptApiKey,
		maxTokens,
		...reasoning,
		metadata,
		signal: deps.signal,
	});

	if (response.stopReason === "error") {
		throw new Error("auto-thinking: online classification failed");
	}

	const text = assistantText(response, " ").trim();
	const effort = parseDifficultyLevel(text);
	if (!effort) {
		throw new Error("auto-thinking: online classification returned an unusable response");
	}
	return effort;
}

async function classifyLocal(input: string, modelKey: string, deps: ClassifyDifficultyDeps): Promise<Effort> {
	if (!isTinyMemoryLocalModelKey(modelKey)) {
		throw new Error(`auto-thinking: unsupported local classifier model: ${modelKey}`);
	}
	const maxTokens = isTinyMemoryReasoningModelKey(modelKey)
		? Math.max(LOCAL_ANSWER_MAX_TOKENS, REASONING_SAFE_MAX_TOKENS)
		: LOCAL_ANSWER_MAX_TOKENS;
	const builtPrompt = prompt.render(thinkingPrompts["thinking/difficulty-local"].text, { prompt: input });
	const text = await tinyTitleClient.complete(modelKey, builtPrompt, {
		maxTokens,
		signal: deps.signal,
	});
	if (!text) {
		throw new Error("auto-thinking: local classification returned no output");
	}
	const effort = parseDifficultyBucket(text);
	if (!effort) {
		throw new Error("auto-thinking: local classification returned an unusable response");
	}
	return effort;
}

/** Map the online 4-way level keyword to an {@link Effort}; earliest match wins. */
export function parseDifficultyLevel(text: string): Effort | undefined {
	const lower = text.toLowerCase();
	const candidates: Array<[number, Effort]> = [];
	// `xhigh` must be probed as its own token: `\bhigh\b` cannot match the "high"
	// inside "xhigh" (no word boundary between `x` and `h`), so the two never collide.
	const xhigh = lower.search(/x[\s_-]?high/);
	if (xhigh >= 0) candidates.push([xhigh, Effort.XHigh]);
	const high = lower.search(/\bhigh\b/);
	if (high >= 0) candidates.push([high, Effort.High]);
	const medium = lower.search(/\bmed(?:ium)?\b/);
	if (medium >= 0) candidates.push([medium, Effort.Medium]);
	const low = lower.search(/\blow\b/);
	if (low >= 0) candidates.push([low, Effort.Low]);
	return earliest(candidates);
}

/** Map the local 3-way bucket keyword to an {@link Effort}; earliest match wins. */
export function parseDifficultyBucket(text: string): Effort | undefined {
	const lower = text.toLowerCase();
	const candidates: Array<[number, Effort]> = [];
	const trivial = lower.search(/\btrivial\b/);
	if (trivial >= 0) candidates.push([trivial, Effort.Low]);
	const moderate = lower.search(/\bmoderate\b/);
	if (moderate >= 0) candidates.push([moderate, Effort.High]);
	const hard = lower.search(/\bhard\b/);
	if (hard >= 0) candidates.push([hard, Effort.XHigh]);
	return earliest(candidates);
}

function earliest(candidates: Array<[number, Effort]>): Effort | undefined {
	if (candidates.length === 0) return undefined;
	let best = candidates[0];
	for (const candidate of candidates) {
		if (candidate[0] < best[0]) best = candidate;
	}
	return best[1];
}
