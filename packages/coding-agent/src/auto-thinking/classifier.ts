import { type ApiKeyResolver, type Context, completeSimple, type Model } from "@veyyon/ai";
import { assistantText } from "@veyyon/ai/utils/message-text";
import { Effort } from "@veyyon/catalog/effort";
import { prompt } from "@veyyon/utils";

import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelectionWithInherit } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { thinkingPrompts } from "../prompts/thinking/rows";
import { isSecretPlaceholder, PLACEHOLDER_RE } from "../secrets/placeholder";
import { REASONING_SAFE_MAX_TOKENS } from "../session/classifier-tokens";
import type { SideCompleteImpl } from "../session/side-complete";
import { clampAutoThinkingEffort } from "../thinking";
import { preprocessTinyMessage } from "../tiny/message-preproc";
import {
	isTinyMemoryLocalModelKey,
	isTinyMemoryReasoningModelKey,
	ONLINE_AUTO_THINKING_MODEL_KEY,
} from "../tiny/models";
import { tinyModelClient } from "../tiny/title-client";

const PLACEHOLDER_SHIELD_START = 0xe100;
const PLACEHOLDER_SHIELD_END = 0xf8ff;

function preprocessProviderInput(text: string): string {
	const unavailable = new Set(text);
	let nextCodePoint = PLACEHOLDER_SHIELD_START;
	const allocateShield = (): string => {
		while (nextCodePoint <= PLACEHOLDER_SHIELD_END) {
			const candidate = String.fromCharCode(nextCodePoint++);
			if (!unavailable.has(candidate)) {
				unavailable.add(candidate);
				return candidate;
			}
		}
		throw new Error("Too many distinct secret placeholders to preprocess safely.");
	};
	const padding = allocateShield();
	const shields = new Map<string, string>();
	const shielded = text.replace(PLACEHOLDER_RE, candidate => {
		if (!isSecretPlaceholder(candidate)) return candidate;
		let shield = shields.get(candidate);
		if (!shield) {
			shield = allocateShield();
			shields.set(candidate, shield);
		}
		return shield + padding.repeat(candidate.length - 1);
	});
	let processed = preprocessTinyMessage(shielded).split(padding).join("");
	for (const [placeholder, shield] of shields) {
		processed = processed.split(shield).join(placeholder);
	}
	return processed;
}

const DIFFICULTY_SYSTEM_PROMPT = prompt.render(thinkingPrompts["thinking/difficulty"].text);

const LOCAL_ANSWER_MAX_TOKENS = 16;

export interface ClassifyDifficultyDeps {
	settings: Settings;
	registry: ModelRegistry;
	model: Model;
	sessionId?: string;
	signal?: AbortSignal;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	obfuscateProviderText?: (text: string) => string;
	completeImpl?: SideCompleteImpl;
}

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
	const resolved = resolveRoleSelectionWithInherit(
		["tiny", "smol"],
		deps.settings,
		deps.registry.getAvailable(),
		deps.model,
	);
	const model = resolved?.model;
	if (!model) {
		throw new Error("auto-thinking: no tiny/smol model available for classification");
	}
	const apiKey = await deps.registry.getApiKey(model, deps.sessionId);
	if (!apiKey) {
		throw new Error(`auto-thinking: no API key for ${model.provider}/${model.id}`);
	}
	const metadata = deps.metadataResolver?.(model.provider);
	const maxTokens = REASONING_SAFE_MAX_TOKENS;
	const requestContext: Context = { systemPrompt: [], messages: [] };
	const refreshProviderContext = (): void => {
		const sanitize = deps.obfuscateProviderText ?? ((text: string) => text);
		const providerInput = preprocessProviderInput(sanitize(input));
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
		refreshProviderContext();
		return key;
	};

	const complete = deps.completeImpl ?? completeSimple;
	const response = await complete(model, requestContext, {
		apiKey: resolveAttemptApiKey,
		maxTokens,
		disableReasoning: true,
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
	const text = await tinyModelClient.complete(modelKey, builtPrompt, {
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

export function parseDifficultyLevel(text: string): Effort | undefined {
	const lower = text.toLowerCase();
	const candidates: Array<[number, Effort]> = [];
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
