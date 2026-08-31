/**
 * The one module that knows every usage backend.
 *
 * Importing this module IS the wiring: it fills the registry in `usage/registry.ts` at module scope,
 * and until something imports it the registry refuses to answer rather than reporting no usage for
 * everything. That refusal is deliberate — see `assertPopulated` there.
 *
 * The eleven imports below are why this file exists separately from `auth-storage.ts`. They pull the
 * provider transports and, through `usage/claude`, the streaming engine; keeping them here means the
 * credential store does not pay for them, and that a new backend is added in one place instead of
 * two.
 */

import type { Provider } from "../types";
import type { CredentialRankingStrategy, UsageProvider } from "../usage";
import { claudeRankingStrategy, claudeUsageProvider } from "./claude";
import { cursorUsageProvider } from "./cursor";
import { googleGeminiCliUsageProvider } from "./gemini";
import { githubCopilotUsageProvider } from "./github-copilot";
import { antigravityRankingStrategy, antigravityUsageProvider } from "./google-antigravity";
import { kimiUsageProvider } from "./kimi";
import { ollamaCloudUsageProvider, ollamaUsageProvider } from "./ollama";
import { codexRankingStrategy, openaiCodexUsageProvider } from "./openai-codex";
import { opencodeGoUsageProvider } from "./opencode-go";
import { registerUsageProviders } from "./registry";
import { zaiRankingStrategy, zaiUsageProvider } from "./zai";

/** Every provider that reports usage, in the order the credential store used to list them. */
export const DEFAULT_USAGE_PROVIDERS: readonly UsageProvider[] = [
	openaiCodexUsageProvider,
	kimiUsageProvider,
	antigravityUsageProvider,
	googleGeminiCliUsageProvider,
	ollamaUsageProvider,
	ollamaCloudUsageProvider,
	claudeUsageProvider,
	zaiUsageProvider,
	opencodeGoUsageProvider,
	githubCopilotUsageProvider,
	cursorUsageProvider,
];

/** The four providers whose credentials rank by their own rules rather than the default ones. */
export const DEFAULT_RANKING_STRATEGIES: readonly (readonly [Provider, CredentialRankingStrategy])[] = [
	["openai-codex", codexRankingStrategy],
	["anthropic", claudeRankingStrategy],
	["google-antigravity", antigravityRankingStrategy],
	["zai", zaiRankingStrategy],
];

registerUsageProviders({ providers: DEFAULT_USAGE_PROVIDERS, rankingStrategies: DEFAULT_RANKING_STRATEGIES });
