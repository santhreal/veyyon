interface HostClassSpec {
	readonly providers?: readonly string[];
	readonly providerPrefixes?: readonly string[];
	readonly urlMarkers: readonly string[];
}

export const KNOWN_HOSTS = {
	openai: { providers: ["openai"], urlMarkers: ["api.openai.com"] },
	azureOpenAI: {
		providers: ["azure"],
		urlMarkers: [".openai.azure.com", "azure.com/openai", "models.inference.ai.azure.com"],
	},
	codexBackend: { providers: ["openai-codex"], urlMarkers: ["chatgpt.com/backend-api"] },
	openrouter: { providers: ["openrouter"], urlMarkers: ["openrouter.ai"] },
	huggingfaceRouter: { providers: ["huggingface"], urlMarkers: ["router.huggingface.co"] },
	vercelAIGateway: { providers: ["vercel-ai-gateway"], urlMarkers: ["ai-gateway.vercel.sh"] },
	githubCopilot: { providers: ["github-copilot"], urlMarkers: ["githubcopilot.com", "copilot-api."] },
	anthropic: { providers: ["anthropic"], urlMarkers: ["api.anthropic.com"] },
	deepseekDirect: { providers: ["deepseek"], urlMarkers: ["api.deepseek.com"] },
	deepseekFamily: { providers: ["deepseek"], urlMarkers: ["deepseek.com"] },
	cerebras: { providers: ["cerebras"], urlMarkers: ["cerebras.ai"] },
	zai: { providers: ["zai"], urlMarkers: ["api.z.ai"] },
	zhipu: { providers: ["zhipu-coding-plan"], urlMarkers: ["open.bigmodel.cn"] },
	kilo: { providers: ["kilo"], urlMarkers: ["api.kilo.ai"] },
	alibabaDashscope: { providers: ["alibaba-coding-plan"], urlMarkers: ["dashscope"] },
	umans: { providers: ["umans"], urlMarkers: ["api.code.umans.ai"] },
	xiaomi: { providers: ["xiaomi"], providerPrefixes: ["xiaomi-token-plan-"], urlMarkers: ["xiaomimimo.com"] },
	xai: { providers: ["xai"], urlMarkers: ["api.x.ai"] },
	mistral: { providers: ["mistral"], urlMarkers: ["mistral.ai"] },
	together: { providers: ["together"], urlMarkers: ["api.together.xyz"] },
	baseten: { providers: ["baseten"], urlMarkers: ["baseten.co"] },
	fireworks: { urlMarkers: ["fireworks.ai"] },
	groq: { providers: ["groq"], urlMarkers: ["api.groq.com"] },
	minimax: {
		providers: ["minimax", "minimax-code", "minimax-code-cn"],
		urlMarkers: ["api.minimax.io", "api.minimaxi.com"],
	},
	qwenPortal: { providers: ["qwen-portal"], urlMarkers: ["portal.qwen.ai"] },
	nvidia: { providers: ["nvidia"], urlMarkers: ["integrate.api.nvidia.com"] },
	moonshotNative: { providers: ["moonshot", "kimi-code"], urlMarkers: ["api.moonshot.ai", "api.kimi.com"] },
	opencode: { providers: ["opencode-go", "opencode-zen"], urlMarkers: ["opencode.ai"] },
	zenmux: { providers: ["zenmux"], urlMarkers: ["zenmux.ai"] },
	chutes: { urlMarkers: ["chutes.ai"] },
} as const satisfies Record<string, HostClassSpec>;

export type KnownHost = keyof typeof KNOWN_HOSTS;

export function hostMatchesUrl(baseUrl: string | undefined, host: KnownHost): boolean {
	if (!baseUrl) return false;
	const spec: HostClassSpec = KNOWN_HOSTS[host];
	for (const marker of spec.urlMarkers) {
		if (includesAsciiCaseInsensitive(baseUrl, marker)) return true;
	}
	return false;
}

export function hasLocalLoopbackBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "0.0.0.0" ||
		hostname === "::1" ||
		hostname === "[::1]"
	) {
		return true;
	}
	if (/^10\./.test(hostname)) return true;
	if (/^192\.168\./.test(hostname)) return true;
	if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true;
	if (hostname.endsWith(".local")) return true;
	return false;
}

export function baseUrlSchemeError(baseUrl: string): string | null {
	let parsed: URL | undefined;
	try {
		parsed = new URL(baseUrl);
	} catch {
		parsed = undefined;
	}
	if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0) {
		return null;
	}
	if (!baseUrl.includes("://")) {
		return `"${baseUrl}" is missing a scheme. Write it as "http://${baseUrl}" for a local server, or "https://${baseUrl}" for a remote one.`;
	}
	return `"${baseUrl}" is not a usable endpoint. A model baseUrl must be an absolute URL beginning with "http://" or "https://".`;
}

export function modelMatchesHost(model: { provider: string; baseUrl: string }, host: KnownHost): boolean {
	const spec: HostClassSpec = KNOWN_HOSTS[host];
	if (spec.providers) {
		for (const provider of spec.providers) {
			if (model.provider === provider) return true;
		}
	}
	if (spec.providerPrefixes) {
		for (const prefix of spec.providerPrefixes) {
			if (model.provider.startsWith(prefix)) return true;
		}
	}
	return hostMatchesUrl(model.baseUrl, host);
}

function includesAsciiCaseInsensitive(value: string, lowerNeedle: string): boolean {
	const needleLength = lowerNeedle.length;
	const end = value.length - needleLength;
	for (let start = 0; start <= end; start++) {
		let offset = 0;
		for (; offset < needleLength; offset++) {
			if ((value.charCodeAt(start + offset) | 0x20) !== lowerNeedle.charCodeAt(offset)) break;
		}
		if (offset === needleLength) return true;
	}
	return false;
}

export function isVertexExpressOpenAIUrl(baseUrl: string): boolean {
	return baseUrl.includes("/endpoints/openapi");
}

export function isVertexRawPredictUrl(baseUrl: string): boolean {
	return baseUrl.includes(":streamRawPredict") || baseUrl.includes(":rawPredict");
}

export function isDashscopeCompatibleModeUrl(baseUrl: string): boolean {
	const normalized = baseUrl.toLowerCase();
	return (
		normalized.includes("dashscope") && normalized.includes("aliyuncs.com") && normalized.includes("/compatible-mode")
	);
}
