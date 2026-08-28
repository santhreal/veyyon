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

export const DEFAULT_RANKING_STRATEGIES: readonly (readonly [Provider, CredentialRankingStrategy])[] = [
	["openai-codex", codexRankingStrategy],
	["anthropic", claudeRankingStrategy],
	["google-antigravity", antigravityRankingStrategy],
	["zai", zaiRankingStrategy],
];

registerUsageProviders({ providers: DEFAULT_USAGE_PROVIDERS, rankingStrategies: DEFAULT_RANKING_STRATEGIES });
