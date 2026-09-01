const DEFAULT_MODEL_PROVIDER_ORDER = [
	"openai-codex",
	"anthropic",
	"openai",
	"google-gemini-cli",
	"google",
	"google-vertex",
	"kimi-code",
	"moonshot",
	"qwen-portal",
	"zai",
	"xai-oauth",
	"xai",
	"mistral",
	"deepseek",
	"groq",

	"fireworks",
	"cerebras",
	"baseten",
	"openrouter",
	"aimlapi",
	"together",

	"alibaba-coding-plan",
	"umans",
	"google-antigravity",
	"opencode-zen",
	"gitlab-duo",
	"opencode-go",
	"kilo",
	"vercel-ai-gateway",
	"cloudflare-ai-gateway",
	"nanogpt",
	"github-copilot",
] as const;

function addProviderRank(rank: Map<string, number>, provider: string): void {
	const normalized = provider.trim().toLowerCase();
	if (!normalized || rank.has(normalized)) return;
	rank.set(normalized, rank.size);
}

export function buildModelProviderPriorityRank(configuredProviderOrder?: readonly string[]): Map<string, number> {
	const rank = new Map<string, number>();
	for (const provider of configuredProviderOrder ?? []) {
		addProviderRank(rank, provider);
	}
	for (const provider of DEFAULT_MODEL_PROVIDER_ORDER) {
		addProviderRank(rank, provider);
	}
	return rank;
}
