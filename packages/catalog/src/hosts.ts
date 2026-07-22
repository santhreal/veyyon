/**
 * Known model-endpoint host classification — the single vocabulary for the
 * `provider === id || baseUrl.includes(marker)` idiom that gates wire-level
 * behavior (compat detection, routing, header shaping, watchdog floors).
 *
 * Markers are case-insensitive substrings matched against the base URL, NOT
 * parsed hostnames: proxies regularly embed the upstream host in a path
 * segment, and the historical call sites all used substring semantics.
 * Callers that need strict hostname matching — where a substring false
 * positive is dangerous, e.g. the Anthropic official-endpoint OAuth gate —
 * parse the URL and compare the hostname themselves.
 */

interface HostClassSpec {
	/** Provider ids that imply this host class regardless of baseUrl. */
	readonly providers?: readonly string[];
	/** Provider-id prefixes that imply this host class (e.g. `xiaomi-token-plan-`). */
	readonly providerPrefixes?: readonly string[];
	/** Lowercase ASCII substrings matched case-insensitively against the base URL. */
	readonly urlMarkers: readonly string[];
	// Strict hostname matching is intentionally not modeled here: the one
	// auth-sensitive consumer (Anthropic official-endpoint) parses the URL
	// itself; every other call site is benign and uses substring matching.
}

export const KNOWN_HOSTS = {
	openai: { providers: ["openai"], urlMarkers: ["api.openai.com"] },
	azureOpenAI: {
		providers: ["azure"],
		urlMarkers: [".openai.azure.com", "azure.com/openai", "models.inference.ai.azure.com"],
	},
	openrouter: { providers: ["openrouter"], urlMarkers: ["openrouter.ai"] },
	/** Hugging Face Inference Providers router — fans out to third-party inference providers whose output caps differ per routed upstream. */
	huggingfaceRouter: { providers: ["huggingface"], urlMarkers: ["router.huggingface.co"] },
	vercelAIGateway: { providers: ["vercel-ai-gateway"], urlMarkers: ["ai-gateway.vercel.sh"] },
	githubCopilot: { providers: ["github-copilot"], urlMarkers: ["githubcopilot.com", "copilot-api."] },
	anthropic: { providers: ["anthropic"], urlMarkers: ["api.anthropic.com"] },
	/** DeepSeek's first-party API only — gates direct-API quirks (max_tokens field, thinking extraBody). */
	deepseekDirect: { providers: ["deepseek"], urlMarkers: ["api.deepseek.com"] },
	/** Any DeepSeek-operated host (first-party API, web-chat fronts). Wider than `deepseekDirect` on purpose. */
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
	/** URL-only on purpose: the `fireworks`/`firepass` providers route per-model and not every model is Fireworks-shaped. */
	fireworks: { urlMarkers: ["fireworks.ai"] },
	groq: { providers: ["groq"], urlMarkers: ["api.groq.com"] },
	minimax: {
		providers: ["minimax", "minimax-code", "minimax-code-cn"],
		urlMarkers: ["api.minimax.io", "api.minimaxi.com"],
	},
	qwenPortal: { providers: ["qwen-portal"], urlMarkers: ["portal.qwen.ai"] },
	/** NVIDIA NIM (`integrate.api.nvidia.com`). Qwen NIM endpoints take `chat_template_kwargs.enable_thinking`, never top-level `enable_thinking`. */
	nvidia: { providers: ["nvidia"], urlMarkers: ["integrate.api.nvidia.com"] },
	moonshotNative: { providers: ["moonshot", "kimi-code"], urlMarkers: ["api.moonshot.ai", "api.kimi.com"] },
	opencode: { providers: ["opencode-go", "opencode-zen"], urlMarkers: ["opencode.ai"] },
	/** ZenMux's Anthropic-compatible proxy (`zenmux.ai/api/anthropic`) forwards to signature-enforcing Anthropic. */
	zenmux: { providers: ["zenmux"], urlMarkers: ["zenmux.ai"] },
	chutes: { urlMarkers: ["chutes.ai"] },
} as const satisfies Record<string, HostClassSpec>;

export type KnownHost = keyof typeof KNOWN_HOSTS;

/** URL-only host check (for call sites that have no provider id, e.g. raw env config). */
export function hostMatchesUrl(baseUrl: string | undefined, host: KnownHost): boolean {
	if (!baseUrl) return false;
	const spec: HostClassSpec = KNOWN_HOSTS[host];
	for (const marker of spec.urlMarkers) {
		if (includesAsciiCaseInsensitive(baseUrl, marker)) return true;
	}
	return false;
}

/**
 * True when `baseUrl` points at a machine on the local network.
 *
 * This is how a llama.cpp, vLLM or sglang server registered under a
 * user-defined provider id in `models.yaml` is recognised as local, since it
 * matches no known host and no built-in provider id. Two behaviours key off it:
 * append-only context mode, which is what makes prefix KV-cache reuse possible,
 * and the OpenAI chat-completions compat record.
 *
 * It answers "is this host on my network", so it covers loopback, the RFC1918
 * private IPv4 ranges, and `.local` mDNS names, which is what a home-LAN box
 * running llama.cpp is usually reachable as. The match is on the parsed
 * hostname only, so ports and paths never affect it.
 *
 * There is exactly one copy of this on purpose: it decides whether a real
 * performance feature engages, and two copies would eventually disagree about
 * which hosts are local, giving the same server different behaviour depending
 * on which code path reached it first.
 */
export function hasLocalLoopbackBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		// An unparseable baseUrl is not a local host, and it is not this
		// predicate's business to report it: whatever tries to USE the URL fails
		// loudly on its own, and warning here would fire on every model lookup.
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

/**
 * Explain why a `baseUrl` is not a usable model endpoint, or `null` when it is.
 *
 * A model `baseUrl` becomes a request URL through `new URL(baseUrl)`, and it
 * flows through `hasLocalLoopbackBaseUrl`, which decides whether prefix
 * KV-cache reuse can engage. Both need an absolute http(s) URL, and a
 * scheme-less value is neither: `new URL("192.168.1.5:8080")` throws outright,
 * and `new URL("localhost:11434")` is worse, parsing to an empty hostname with
 * protocol `localhost:`, so the request goes nowhere and the loopback check
 * silently returns false. `localhost:11434` and `192.168.1.5:8080` are exactly
 * what a person hand-writing `models.yaml` types, so this is caught once at
 * config load with a correction rather than left to surface as an unreproducible
 * "it's slow" or an opaque request failure much later (Law 10).
 *
 * The check rejects rather than normalising: prepending `http://` to a public
 * host a user meant over https would be a silent downgrade to plaintext, which
 * is the kind of guess this must not make. The message hands back the two
 * schemes so the user chooses.
 */
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

/** Provider-or-URL host check — the canonical `provider === id || baseUrl.includes(marker)` idiom. */
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

// --- Endpoint-shape predicates (URL path/verb shapes, not vendor hosts) ---

/** Vertex AI express-mode OpenAI-compatible endpoint (`…/endpoints/openapi`). */
export function isVertexExpressOpenAIUrl(baseUrl: string): boolean {
	return baseUrl.includes("/endpoints/openapi");
}

/** Vertex AI Anthropic raw-predict endpoints (`:streamRawPredict` / `:rawPredict`). */
export function isVertexRawPredictUrl(baseUrl: string): boolean {
	return baseUrl.includes(":streamRawPredict") || baseUrl.includes(":rawPredict");
}

/** Azure OpenAI deployment-scoped path (`…/deployments/<name>/…`). */
export function isAzureDeploymentsUrl(baseUrl: string): boolean {
	return baseUrl.includes("/deployments/");
}

/** Alibaba DashScope consumer `compatible-mode` endpoint (rejects multimodal arrays for some text-only SKUs). */
export function isDashscopeCompatibleModeUrl(baseUrl: string): boolean {
	const normalized = baseUrl.toLowerCase();
	return (
		normalized.includes("dashscope") && normalized.includes("aliyuncs.com") && normalized.includes("/compatible-mode")
	);
}
