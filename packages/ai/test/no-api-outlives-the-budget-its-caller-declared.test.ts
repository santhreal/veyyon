/**
 * No API keeps a turn alive longer than the budget its caller declared.
 *
 * WHY THIS SUITE EXISTS. Every stall report against this product has the same
 * shape: the endpoint accepted the request, said nothing, and the turn sat
 * there. Provider code is where that gets decided, and the decision is spread
 * across a pre-response fence (`armPreResponseTimeout`), an iterator watchdog
 * (`iterateWithIdleTimeout` in the lazy-stream forwarder), and per-provider
 * scoped deadlines. `provider-stream-budget-coverage.test.ts` locks the
 * *declared* budget of each lazy registration by parsing the registration
 * table; it cannot see whether the wiring underneath honors it, and it cannot
 * see a provider that never reaches the forwarder at all.
 *
 * This suite is the behavioural half. For every API in the union it drives the
 * real `stream()` dispatcher against a transport that goes silent in the two
 * ways that matter (no headers at all, and headers followed by an open body
 * that never carries a frame), and asserts the turn reaches a terminal failure
 * inside the caller's declared budget plus slack.
 *
 * THE CLASS IT CLOSES. "A provider path spends longer than the caller's
 * declared first-event budget before it gives up" — including paths that spend
 * it *before* the transport, in credential resolution, project discovery or
 * token exchange, which no watchdog over the response stream can see.
 *
 * WHAT IT DOES NOT CATCH. It proves termination and the observed failure
 * class, not the wording of the message a user reads, and not the *lower*
 * bound: a provider that gives up too eagerly on a healthy-but-slow endpoint
 * looks identical here. Sibling suites own that direction
 * (`lazy-stream-budget.test.ts` for the agentic floors, and the per-provider
 * timeout suites). Transports that neither use `fetch` nor HTTP/2 (the GitLab
 * Duo WebSocket, once its REST setup succeeds) are exercised only up to the
 * point where they leave `fetch`.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { BUILTIN_API_IDS } from "@veyyon/ai/api-registry";
import { stream } from "@veyyon/ai/stream";
import type { Api, AssistantMessageEventStream, Context, Model, StreamOptions } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { $env } from "@veyyon/utils/env";
import {
	type CountingFetch,
	fetchThatNeverAnswers,
	fetchThatStallsMidStream,
	type SilentHttp2Server,
	startSilentHttp2Server,
} from "./helpers/silent-transport";

/**
 * The budget a caller declares for these probes. Small on purpose: the contract
 * is "the provider honors what the caller asked for", so the number only has to
 * be far enough below the slack that an unhonored budget cannot hide in it.
 */
const DECLARED_BUDGET_MS = 500;

/**
 * How long past the declared budget a turn may take to surface. Covers lazy
 * module loading, retry backoff and the abort round-trip. A provider that
 * ignores the declared budget and falls back to its own 30s or 100s default
 * cannot fit here, which is the point.
 */
const SLACK_MS = 4_500;

const BOUND_MS = DECLARED_BUDGET_MS + SLACK_MS;

/**
 * Where the `fetch`-based probes point. Port 9 (discard) is reserved and nothing
 * on it can answer, so a provider that ignores `options.fetch` and reaches the
 * network is a hang rather than a silent pass against a real endpoint.
 */
const DEAD_ENDPOINT_URL = "http://127.0.0.1:9/v1";

/** What a probe observed when the turn ended. The pinned value per API. */
type Outcome =
	| "first-event-timeout"
	| "idle-timeout"
	| "aborted"
	| "credentials"
	| "transport"
	| "unclassified"
	| "completed";

interface Probe {
	/** Catalog provider id, which providers read for routing and env keys. */
	provider: string;
	/** Model id, which several providers read for per-family behaviour. */
	modelId: string;
	/** True when the provider speaks HTTP/2 directly and ignores `options.fetch`. */
	http2: boolean;
	/**
	 * API key for providers that read structure out of it. Without one the probe
	 * stops at credential parsing and never reaches the transport, which is a
	 * hole in the sweep rather than a pass.
	 */
	apiKey?: string;
}

/**
 * One probe per API. Pinned by exact equality against `BUILTIN_API_IDS` below,
 * so adding an API to the union turns this suite red until someone decides how
 * its transport is reached.
 */
const PROBES: Record<string, Probe> = {
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
 * what the CALLER's option does, so the probes run with the env layer cleared.
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

const context: Context = { messages: [{ role: "user", content: "probe", timestamp: 1 }] };

/**
 * `stream()` is generic over the API, and these probes deliberately hold the
 * whole union at once. One cast at one site, rather than fourteen call sites
 * that each re-narrow the same options object.
 */
type StreamCall = (model: Model<Api>, context: Context, options: StreamOptions) => AssistantMessageEventStream;
const callStream = stream as unknown as StreamCall;

function modelFor(api: string, probe: Probe, baseUrl: string): Model<Api> {
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

function classify(text: string): Outcome {
	if (/first event|first_event/i.test(text)) return "first-event-timeout";
	if (/stalled while waiting for the next event|idle/i.test(text)) return "idle-timeout";
	if (/abort|timed out|timeout/i.test(text)) return "aborted";
	if (/api key|apikey|credential|token|unauthor|authenticat|permission/i.test(text)) return "credentials";
	if (/econnrefused|fetch failed|socket|network|connect|http2|stream closed|protocol/i.test(text)) return "transport";
	return "unclassified";
}

interface ProbeResult {
	outcome: Outcome;
	elapsedMs: number;
	detail: string;
	fetchCalls: number;
}

/**
 * Drive one turn to its terminal state, or to the bound. A `stream()` that
 * throws synchronously, an event stream that ends with `stopReason: "error"`,
 * and a rejected `result()` are all terminal — the invariant is that one of
 * them happens in time, not which one.
 */
async function probeOnce(api: string, transport: CountingFetch, baseUrl: string): Promise<ProbeResult> {
	const started = Date.now();
	const options: StreamOptions = {
		apiKey: PROBES[api].apiKey ?? "probe-key",
		fetch: transport,
		streamFirstEventTimeoutMs: DECLARED_BUDGET_MS,
		streamIdleTimeoutMs: DECLARED_BUDGET_MS,
	};

	const settle = async (): Promise<string> => {
		try {
			const events = callStream(modelFor(api, PROBES[api], baseUrl), context, options);
			let seen = 0;
			for await (const _event of events) seen += 1;
			void seen;
			const message = await events.result();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				return message.errorMessage ?? `stopReason:${message.stopReason}`;
			}
			return "COMPLETED";
		} catch (error) {
			return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		}
	};

	// A real timer, deliberately: the subject is a real transport on a real
	// socket, and the claim is wall-clock termination. Fake timers cannot drive
	// a socket, and swapping the clock would prove the watchdog fires against a
	// clock nobody ships. The bound is generous so it never races; a provider
	// that misses it missed by an order of magnitude, not by scheduling noise.
	const overrun = Promise.withResolvers<string>();
	const timer = setTimeout(() => overrun.resolve("OVERRAN"), BOUND_MS);
	try {
		const detail = await Promise.race([settle(), overrun.promise]);
		return {
			outcome: detail === "OVERRAN" ? "unclassified" : detail === "COMPLETED" ? "completed" : classify(detail),
			elapsedMs: Date.now() - started,
			detail: detail.slice(0, 160),
			fetchCalls: transport.calls,
		};
	} finally {
		clearTimeout(timer);
	}
}

let silentHttp2: SilentHttp2Server;
let respondingHttp2: SilentHttp2Server;

beforeAll(async () => {
	silentHttp2 = await startSilentHttp2Server({ respond: false });
	respondingHttp2 = await startSilentHttp2Server({ respond: true });
});

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete ($env as Record<string, string | undefined>)[key];
		else $env[key] = value;
	}
	savedEnv.clear();
});

function pinProbeEnv(): void {
	for (const [key, value] of Object.entries(PINNED_ENV)) pinEnv(key, value);
	for (const key of CLEARED_ENV) pinEnv(key, undefined);
}

/**
 * The failure class each API surfaces when the endpoint accepts and never
 * answers, pinned so a change of class is visible rather than silent.
 *
 * `first-event-timeout` is the iterator watchdog naming the phase. `aborted` is
 * a provider whose own pre-response fence fired first and reports the abort
 * instead: Bedrock's SDK-level abort, Codex's per-attempt fence, and GitLab
 * Duo's setup deadline, which surfaces through its namespace-resolution error.
 * Both are correct terminations inside the caller's budget; which one wins is a
 * property of where the deadline sits, and moving one is a decision, not drift.
 */
const NO_ANSWER_OUTCOMES: Record<string, Outcome> = {
	"openai-completions": "first-event-timeout",
	"openai-responses": "first-event-timeout",
	openrouter: "first-event-timeout",
	"openai-codex-responses": "aborted",
	"azure-openai-responses": "first-event-timeout",
	"anthropic-messages": "first-event-timeout",
	"bedrock-converse-stream": "aborted",
	"google-generative-ai": "first-event-timeout",
	"google-gemini-cli": "first-event-timeout",
	"google-vertex": "first-event-timeout",
	"ollama-chat": "first-event-timeout",
	"cursor-agent": "first-event-timeout",
	"gitlab-duo-agent": "aborted",
	"devin-agent": "first-event-timeout",
};

/**
 * The same table for headers-then-silence. Every pre-response fence is cleared
 * by design here, so the watchdog over the stream is what remains and the whole
 * union converges on one class.
 */
const STALLED_BODY_OUTCOMES: Record<string, Outcome> = {
	...NO_ANSWER_OUTCOMES,
	"openai-codex-responses": "first-event-timeout",
	"bedrock-converse-stream": "first-event-timeout",
};

/** What one arm observed per API: the class, whether it stayed inside the bound, and whether the transport was reached at all. */
interface ArmObservation {
	outcome: Outcome;
	withinBound: boolean;
	reachedTransport: boolean;
}

describe("no API outlives the budget its caller declared", () => {
	it("has a probe for every API in the union", () => {
		expect(Object.keys(PROBES).sort()).toEqual([...BUILTIN_API_IDS].sort());
	});

	it("ends every turn when the endpoint never answers", async () => {
		pinProbeEnv();
		const observed: Record<string, ArmObservation> = {};
		const expected: Record<string, ArmObservation> = {};
		for (const api of BUILTIN_API_IDS) {
			const probe = PROBES[api];
			const transport = fetchThatNeverAnswers();
			const acceptedBefore = silentHttp2.accepted;
			const result = await probeOnce(api, transport, probe.http2 ? silentHttp2.baseUrl : DEAD_ENDPOINT_URL);
			observed[api] = {
				outcome: result.outcome,
				withinBound: result.elapsedMs <= BOUND_MS,
				reachedTransport: probe.http2 ? silentHttp2.accepted > acceptedBefore : result.fetchCalls > 0,
			};
			expected[api] = { outcome: NO_ANSWER_OUTCOMES[api], withinBound: true, reachedTransport: true };
		}
		expect(observed).toEqual(expected);
	}, 120_000);

	it("ends every turn when the endpoint answers and then goes silent", async () => {
		pinProbeEnv();
		const observed: Record<string, ArmObservation> = {};
		const expected: Record<string, ArmObservation> = {};
		for (const api of BUILTIN_API_IDS) {
			const probe = PROBES[api];
			const transport = fetchThatStallsMidStream();
			const acceptedBefore = respondingHttp2.accepted;
			const result = await probeOnce(api, transport, probe.http2 ? respondingHttp2.baseUrl : DEAD_ENDPOINT_URL);
			observed[api] = {
				outcome: result.outcome,
				withinBound: result.elapsedMs <= BOUND_MS,
				reachedTransport: probe.http2 ? respondingHttp2.accepted > acceptedBefore : result.fetchCalls > 0,
			};
			expected[api] = { outcome: STALLED_BODY_OUTCOMES[api], withinBound: true, reachedTransport: true };
		}
		expect(observed).toEqual(expected);
	}, 120_000);
});
