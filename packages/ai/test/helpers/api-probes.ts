/**
 * How a test reaches every API in the union, in one place.
 *
 * A sweep over `BUILTIN_API_IDS` is only as good as its ability to actually
 * reach each provider's transport: several read structure out of the api key
 * (Gemini CLI's OAuth identity arrives AS the key, as JSON), several resolve
 * credentials from the environment before they stream (Bedrock walks the AWS
 * chain, Vertex takes an access token), and two ignore `options.fetch` and
 * speak HTTP/2 directly. Getting that wrong does not fail a sweep — it makes
 * one pass without exercising anything, which is worse.
 *
 * So the probe table has one owner. Two suites ask two different questions of
 * the same fourteen paths: whether a turn ends inside the caller's declared
 * budget (`no-api-outlives-the-budget-its-caller-declared.test.ts`) and whether
 * a refusal names something the operator can act on
 * (`every-provider-refusal-names-what-to-do-about-it.test.ts`). Neither owns
 * the table, so neither can drift from the other.
 */
import { stream } from "@veyyon/ai/stream";
import type { Api, AssistantMessageEventStream, Context, Model, StreamOptions } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { $env } from "@veyyon/utils/env";

export interface ApiProbe {
	/** Catalog provider id, which providers read for routing and env keys. */
	provider: string;
	/** Model id, which several providers read for per-family behaviour. */
	modelId: string;
	/** True when the provider speaks HTTP/2 directly and ignores `options.fetch`. */
	http2: boolean;
	/**
	 * API key for providers that read structure out of it. Without one the probe
	 * stops at credential parsing and never reaches the transport, which is a
	 * hole in a sweep rather than a pass.
	 */
	apiKey?: string;
}

/**
 * One probe per API. Every consumer pins these keys by exact equality against
 * `BUILTIN_API_IDS`, so adding an API to the union turns those suites red until
 * someone decides how its transport is reached.
 */
export const API_PROBES: Record<string, ApiProbe> = {
	"openai-completions": { provider: "openai", modelId: "gpt-4o-mini", http2: false },
	"openai-responses": { provider: "openai", modelId: "gpt-5-mini", http2: false },
	openrouter: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4.6", http2: false },
	"openai-codex-responses": { provider: "openai-codex", modelId: "gpt-5.1-codex", http2: false },
	"azure-openai-responses": { provider: "azure", modelId: "gpt-5.1", http2: false },
	"anthropic-messages": { provider: "anthropic", modelId: "claude-sonnet-4-6", http2: false },
	"bedrock-converse-stream": { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6", http2: false },
	"google-generative-ai": { provider: "google", modelId: "gemini-3-flash", http2: false },
	"google-gemini-cli": {
		provider: "google-gemini-cli",
		modelId: "gemini-3.1-pro-preview",
		http2: false,
		// Cloud Code Assist credentials arrive AS the api key, as JSON.
		apiKey: JSON.stringify({ token: "probe-token", projectId: "probe-project", expiresAt: 4_000_000_000_000 }),
	},
	"google-vertex": { provider: "google-vertex", modelId: "gemini-3.1-pro-preview", http2: false },
	"ollama-chat": { provider: "ollama", modelId: "qwen3-coder", http2: false },
	"cursor-agent": { provider: "cursor", modelId: "claude-4.6-opus", http2: true },
	"gitlab-duo-agent": { provider: "gitlab-duo-agent", modelId: "claude_sonnet_4_6_vertex", http2: false },
	"devin-agent": { provider: "devin", modelId: "swe-1-6", http2: false },
};

/** The key a probe presents when its own `apiKey` says nothing structural. */
export const DEFAULT_PROBE_API_KEY = "probe-key";

/**
 * Where the `fetch`-based probes point. Port 9 (discard) is reserved and nothing
 * on it can answer, so a provider that ignores `options.fetch` and reaches the
 * network is a hang rather than a silent pass against a real endpoint.
 */
export const DEAD_ENDPOINT_URL = "http://127.0.0.1:9/v1";

/** Environment the probes pin so no provider reads an operator's real setup. */
const PINNED_ENV: Record<string, string> = {
	// Bedrock resolves credentials before it streams; env is the first link of
	// the AWS chain, so pinning it keeps the probe off ~/.aws and off IMDS.
	AWS_ACCESS_KEY_ID: "AKIAPROBEPROBEPROBE",
	AWS_SECRET_ACCESS_KEY: "probe-secret",
	AWS_REGION: "us-east-1",
	// Vertex takes an explicit access token ahead of every ADC path.
	GOOGLE_CLOUD_ACCESS_TOKEN: "probe-token",
	// Gemini CLI reads its OAuth identity out of the api key, not the env.
};

/**
 * Watchdog knobs an operator may legitimately set. The contract under test is
 * always what the CALLER's option does, so the probes run with the env layer
 * cleared.
 */
const CLEARED_ENV = [
	"VEYYON_STREAM_IDLE_TIMEOUT_MS",
	"VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS",
	"VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS",
	"VEYYON_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
] as const;

const savedEnv = new Map<string, string | undefined>();

function pinEnv(key: string, value: string | undefined): void {
	if (!savedEnv.has(key)) savedEnv.set(key, $env[key]);
	if (value === undefined) delete ($env as Record<string, string | undefined>)[key];
	else $env[key] = value;
}

/** Pin the probe environment. Pair with {@link restoreProbeEnv} in `afterEach`. */
export function pinProbeEnv(): void {
	for (const [key, value] of Object.entries(PINNED_ENV)) pinEnv(key, value);
	for (const key of CLEARED_ENV) pinEnv(key, undefined);
}

/** Put back every variable a probe pinned, including the ones it deleted. */
export function restoreProbeEnv(): void {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete ($env as Record<string, string | undefined>)[key];
		else $env[key] = value;
	}
	savedEnv.clear();
}

export const probeContext: Context = { messages: [{ role: "user", content: "probe", timestamp: 1 }] };

/**
 * `stream()` is generic over the API, and these probes deliberately hold the
 * whole union at once. One cast at one site, rather than fourteen call sites
 * that each re-narrow the same options object.
 */
type StreamCall = (model: Model<Api>, context: Context, options: StreamOptions) => AssistantMessageEventStream;
export const callStream = stream as unknown as StreamCall;

export function modelFor(api: string, baseUrl: string): Model<Api> {
	const probe = API_PROBES[api];
	return buildModel({
		id: probe.modelId,
		name: probe.modelId,
		api: api as Api,
		provider: probe.provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	}) as Model<Api>;
}
