/**
 * A refusal from any provider names the thing the operator has to fix.
 *
 * WHY THIS SUITE EXISTS. A refusal is the one provider failure whose remedy
 * belongs to the person at the keyboard: `401` means the credential is wrong,
 * `429` means wait, `404` means the route or the model id, `400` means the
 * request. Everything else in this product's provider surface is machinery's
 * business. Two sibling suites cover the neighbouring halves and neither can
 * see this one: `no-api-outlives-the-budget-its-caller-declared.test.ts` proves
 * a turn ENDS and says so in its own header that it "proves termination and the
 * observed failure class, not the wording of the message a user reads", and
 * `provider-error-detail-names-a-reason.test.ts` owns the bound on an
 * interpolated body but drives only two of the fourteen paths, naming "a NEW
 * call site that formats a provider body by hand" as its hole. A path that
 * renders every status as "request failed" satisfies both and tells nobody
 * anything.
 *
 * THE CLASS IT CLOSES. "A provider refusal reaches the operator without naming
 * its class" — a message that drops the status, collapses four different
 * remedies into one wording, or ends at a colon because the body was empty. It
 * closes it for every API in the union at once, from the registry at run time,
 * so a fifteenth API is RED here until someone records what its refusals say.
 *
 * A second invariant rides along on every arm, because this is the only place
 * that has a credential and a rendered message in the same frame: the message
 * never echoes the api key. A provider that interpolates its request headers
 * into an error puts the operator's key in the transcript, the log file and the
 * HTML export.
 *
 * WHAT IT DOES NOT CATCH. It reads the class out of the message, not the exact
 * sentence, so a rewording that keeps the class is invisible here and should
 * be — the pinned tables below say which class, and the classifier says what
 * counts as naming it. It does not judge whether the remedy is CORRECT for the
 * status the server sent (a provider that calls every refusal a rate limit
 * would be pinned as such and read as deliberate). It says nothing about a
 * refusal mid-stream, after frames have already arrived: that is a decoder
 * question, and the decoder suites own it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { BUILTIN_API_IDS } from "@veyyon/ai/api-registry";
import type { StreamOptions } from "@veyyon/ai/types";
import {
	API_PROBES,
	callStream,
	DEAD_ENDPOINT_URL,
	DEFAULT_PROBE_API_KEY,
	modelFor,
	pinProbeEnv,
	probeContext,
	restoreProbeEnv,
} from "./helpers/api-probes";
import { fetchThatRefuses, type RefusingHttp2Server, startRefusingHttp2Server } from "./helpers/refusing-transport";

/**
 * What the operator is being told to do about it. One value per refusal class,
 * plus `deadline` — the caller's own budget ended the phase before the
 * provider's bounded retry ladder reached its answer, which is a true report of
 * a different event — and the two ways a surface fails this suite outright: it
 * named no class at all, or it never arrived.
 */
type Surface =
	| "credentials"
	| "rate-limit"
	| "not-found"
	| "bad-request"
	| "deadline"
	| "unclassified"
	| "outran-the-bound";

/**
 * The budget the probes declare. Generous enough that a provider which retries
 * a refusal a couple of times still surfaces the refusal rather than a timeout,
 * because a timeout wording would be a true report of a different event and
 * would tell us nothing about the refusal.
 */
const DECLARED_BUDGET_MS = 5_000;

/**
 * The same, for the arm a provider is entitled to retry. Devin's rate-limit
 * ladder is three attempts at 1s, 2s and 4s, all inside its own 90s ceiling,
 * and a caller that declared less than the ladder costs gets a truthful
 * deadline instead of the refusal — a different event, and the budget suite's
 * subject rather than this one's. The shipped default is 100s, so the number
 * here is the one a real caller has.
 */
const RETRYABLE_BUDGET_MS = 20_000;

/**
 * When a refusal has taken so long that a hang is the better explanation.
 * Per-arm, because a refusal carrying a server-directed wait is the one arm
 * whose whole question is how long the caller sits on it: the probes declare a
 * `maxRetryDelayMs` of 1ms against a `retry-after` of 120s, so a provider that
 * substituted its own ceiling for the caller's cannot fit under this.
 */
const BOUND_MS = 20_000;
const SERVER_DIRECTED_WAIT_BOUND_MS = 30_000;

interface Refusal {
	/** Short name, used in the pinned tables and in a failure diff. */
	arm: string;
	status: number;
	body: string;
	headers?: Record<string, string>;
	/** Defaults to {@link BOUND_MS}. */
	boundMs?: number;
	/** Defaults to {@link DECLARED_BUDGET_MS}. */
	declaredBudgetMs?: number;
}

/**
 * The four refusals with four different remedies. Bodies are the shape every
 * dialect under test actually sends — `{"error":{"message":...}}` — because the
 * subject is what a provider does with a body it CAN read; an unreadable body
 * is the sibling suite's `(no detail)` bound.
 */
const REFUSALS: Refusal[] = [
	{ arm: "401", status: 401, body: '{"error":{"message":"invalid x-api-key","type":"authentication_error"}}' },
	{ arm: "404", status: 404, body: '{"error":{"message":"model not found","type":"not_found_error"}}' },
	{
		arm: "429",
		status: 429,
		body: '{"error":{"message":"rate limit exceeded","type":"rate_limit_error"}}',
		// A server-directed wait, with the caller capping how long it will sit on
		// one: the pair is what turns a two-minute sleep into a surfaced number.
		headers: { "retry-after": "120" },
		boundMs: SERVER_DIRECTED_WAIT_BOUND_MS,
		declaredBudgetMs: RETRYABLE_BUDGET_MS,
	},
	{
		arm: "400",
		status: 400,
		body: '{"error":{"message":"max_tokens must be positive","type":"invalid_request_error"}}',
	},
];

/**
 * Which remedy a message names. Read as a ladder because a provider may name
 * both the status and the class, and the class is the more specific answer:
 * "429 rate limit" is a rate limit, not a bad request that happens to contain a
 * digit. A status number on its own counts — it is a thing the operator can
 * look up — but only after every class word has had its turn.
 */
function classify(text: string): Surface {
	// First, because a provider whose bounded ladder outlived the caller's budget
	// reports the deadline truthfully and must not be read as a refusal class it
	// never named.
	if (/timed out|timeout|first event/i.test(text)) return "deadline";
	if (/rate.?limit|too many requests|quota|retry.?after|429/i.test(text)) return "rate-limit";
	// `\btoken\b` and not `token`: "max_tokens must be positive" is a rejected
	// request, and a substring match read it as a credential problem.
	if (/unauthor|forbidden|authenticat|permission|api.?key|credential|\btoken\b|\b401\b|\b403\b/i.test(text)) {
		return "credentials";
	}
	// "Unable to find a namespace, set GITLAB_DUO_NAMESPACE_ID" is a not-found
	// statement with its remedy attached, which is the whole point of the class.
	if (/not.?found|unable to find|no such|unknown model|\b404\b/i.test(text)) return "not-found";
	if (/bad request|invalid request|invalid.?argument|must be|\b400\b/i.test(text)) return "bad-request";
	return "unclassified";
}

/** What one arm observed for one API. */
interface Observation {
	surface: Surface;
	/** True when the rendered message contains the api key the probe presented. */
	echoedTheKey: boolean;
	/** True when the message ends at a colon or in whitespace, i.e. a body went missing. */
	endedAtNothing: boolean;
}

let refusingHttp2 = new Map<string, RefusingHttp2Server>();

beforeAll(async () => {
	// Cursor speaks HTTP/2 directly and ignores `options.fetch`, so its refusal
	// has to come off a real socket. One server per arm, started once.
	for (const refusal of REFUSALS) {
		refusingHttp2.set(refusal.arm, await startRefusingHttp2Server(refusal.status, refusal.body));
	}
});

afterAll(async () => {
	for (const server of refusingHttp2.values()) await server.close();
	refusingHttp2 = new Map();
});

afterEach(() => {
	restoreProbeEnv();
});

async function observe(api: string, refusal: Refusal): Promise<Observation> {
	const apiKey = API_PROBES[api].apiKey ?? DEFAULT_PROBE_API_KEY;
	const transport = fetchThatRefuses(refusal.status, refusal.body, refusal.headers);
	const baseUrl = API_PROBES[api].http2
		? (refusingHttp2.get(refusal.arm)?.baseUrl ?? DEAD_ENDPOINT_URL)
		: DEAD_ENDPOINT_URL;
	// The observation ends when the surface arrives; the TURN may not, because a
	// provider whose bounded ladder is mid-retry keeps going and then rejects
	// into nobody's hands. A caller that stops reading stops the turn, which is
	// what this signal says, and it is also what keeps a stray rejection from
	// arriving in the middle of the next api's probe.
	const stopReading = new AbortController();
	const options: StreamOptions = {
		apiKey,
		fetch: transport,
		signal: stopReading.signal,
		streamFirstEventTimeoutMs: refusal.declaredBudgetMs ?? DECLARED_BUDGET_MS,
		streamIdleTimeoutMs: refusal.declaredBudgetMs ?? DECLARED_BUDGET_MS,
		// Cap the server-directed wait so a `retry-after: 120` surfaces the
		// number instead of sleeping on it.
		maxRetryDelayMs: 1,
	};

	const settle = async (): Promise<string> => {
		try {
			const events = callStream(modelFor(api, baseUrl), probeContext, options);
			for await (const _event of events) {
				// Drained on purpose: a refusal may arrive as an error event, as a
				// rejected result, or as a thrown call, and all three are the same
				// question. Nothing here reads the frames.
			}
			const message = await events.result();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				return message.errorMessage ?? `stopReason:${message.stopReason}`;
			}
			return "COMPLETED";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	};

	// A real timer, deliberately: the transport is a real socket and the claim
	// includes that a refusal arrives at all. Each bound is well above a
	// refusal's real cost, so neither races.
	const overrun = Promise.withResolvers<string>();
	const timer = setTimeout(() => overrun.resolve("OVERRAN"), refusal.boundMs ?? BOUND_MS);
	try {
		const detail = await Promise.race([settle(), overrun.promise]);
		return {
			surface: detail === "OVERRAN" ? "outran-the-bound" : classify(detail),
			echoedTheKey: detail.includes(apiKey),
			endedAtNothing: /[:\s]$/.test(detail) || detail.length === 0,
		};
	} finally {
		clearTimeout(timer);
		stopReading.abort();
	}
}

/**
 * The apis this suite claims to have decided about, spelled out rather than
 * enumerated. Pinned by exact equality against the union below, so a fifteenth
 * api is RED here until someone records what its refusals say.
 */
const DECIDED_APIS = [
	"openai-completions",
	"openai-responses",
	"openrouter",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"ollama-chat",
	"cursor-agent",
	"gitlab-duo-agent",
	"devin-agent",
] as const;

/** One class across every api, for an arm where all fourteen agree. */
function everyApiNames(surface: Surface): Record<string, Surface> {
	const table: Record<string, Surface> = {};
	for (const api of DECIDED_APIS) table[api] = surface;
	return table;
}

/**
 * The remedy each API names, per refusal. A cell that is not the status's own
 * class is a decision somebody made about that dialect, recorded here with its
 * reason, never left to read as drift.
 */
const EXPECTED: Record<string, Record<string, Surface>> = {
	"401": everyApiNames("credentials"),
	"404": everyApiNames("not-found"),
	// Uniform, and that is the finding: every dialect names a rate limit as one,
	// including the two that get there by different roads — Devin exhausts its
	// own three-rung ladder first (a Connect trailer carries no `retry-after`, so
	// it parses the server's English) and GitLab Duo ends its namespace handshake
	// on the 429 rather than walking every candidate and blaming configuration.
	"429": everyApiNames("rate-limit"),
	"400": {
		...everyApiNames("bad-request"),
		// GitLab Duo reaches a model through a namespace handshake, and a 400 is
		// not about the caller's credential or their rate: it is this candidate
		// answering badly, so the handshake tries the next one and concludes with
		// the remedy for having found none — "set GITLAB_DUO_NAMESPACE_ID". That
		// is a not-found statement with its own remedy attached, which is the
		// right answer for a namespace nothing could be reached through.
		"gitlab-duo-agent": "not-found",
	},
};

describe("every provider refusal names what to do about it", () => {
	it("has a probe for every API in the union", () => {
		expect(Object.keys(API_PROBES).sort()).toEqual([...BUILTIN_API_IDS].sort());
		expect([...DECIDED_APIS].sort()).toEqual([...BUILTIN_API_IDS].sort());
	});

	for (const refusal of REFUSALS) {
		it(`names the remedy for ${refusal.arm} on every api`, async () => {
			pinProbeEnv();
			const observed: Record<string, Observation> = {};
			const expected: Record<string, Observation> = {};
			for (const api of BUILTIN_API_IDS) {
				observed[api] = await observe(api, refusal);
				expected[api] = {
					surface: EXPECTED[refusal.arm][api],
					echoedTheKey: false,
					endedAtNothing: false,
				};
			}
			expect(observed).toEqual(expected);
		}, 120_000);
	}
});
