/**
 * A `200` whose body closes before the dialect's terminal marker is not a
 * finished turn, on any api.
 *
 * WHY THIS SUITE EXISTS. Every dialect under test ends a turn with a marker of
 * its own: `finish_reason` and `[DONE]` on the completions dialect,
 * `response.completed` on the responses dialect, `message_stop` on Anthropic,
 * `finishReason` on Google, `done: true` on Ollama, `turn_ended` on Cursor. A
 * server that accepted the request, answered `200`, and then closed the body
 * without one has produced a transport-clean EOF that carries no turn, and the
 * decoder is the only thing standing between that and an assistant message the
 * session persists as an answer. The consequence is not a visible error: the
 * model reads its own truncated output back as history on the next turn, so a
 * cut sentence becomes a permanent part of the conversation, and the compaction
 * anchor trusts the partial token counts that came with it. `openai-completions`
 * (a semantic EOF, classified by accumulated shape) and `anthropic-messages` (a
 * mid-delta cut, rejected) each own a suite for their own end-of-stream rule.
 * This one asks the question the other thirteen were never asked together: when
 * nothing at all arrived before the EOF, does the dialect say so, and does it
 * say so in bounded time.
 *
 * THE CLASS. Three ways to fail, and the sweep separates them: report a
 * finished turn (the silent one, and the reason this suite exists), never
 * settle at all (the reported "hangs until Esc" signature), or settle with a
 * message that names nothing an operator can act on. The verdict for each api
 * is pinned by exact equality, so a dialect that starts accepting an empty
 * stream as an answer turns this red rather than shipping a blank turn.
 *
 * WHAT IT DOES NOT CATCH. The bytes are dialect-agnostic (see
 * `helpers/truncated-transport.ts`): zero bytes, and an SSE comment frame. It
 * therefore proves the end-of-stream decision for a stream that carried NO
 * turn, and not the harder judgement each dialect makes about a stream that
 * carried a complete answer and then stopped short of its marker. That case is
 * per-dialect by nature — the shape being classified is the dialect's own — and
 * writing fourteen hand-made bodies would prove what the author believes each
 * wire format looks like. It is covered where a report justified it:
 * `openai-stream-terminal-close.test.ts` for the completions dialect,
 * `anthropic-stream-envelope.test.ts` for the Anthropic envelope, and
 * `openai-responses-stream-terminal.test.ts` for the responses dialect. A
 * fifteenth api is red here until someone records its verdict, but a
 * fifteenth *dialect body* is not something this sweep can ask for.
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
import {
	fetchThatEndsEarly,
	startTruncatingHttp2Server,
	type TruncatingHttp2Server,
} from "./helpers/truncated-transport";

/**
 * What the caller was told about the cut stream. `incomplete` is the answer
 * this suite wants: the failure names a truncated, incomplete or unreadable
 * response. `deadline` is a truthful report of a different event — the caller's
 * own budget ended the phase first — and `configuration` is another: a
 * handshake that runs BEFORE the stream never reached the decoder, so what it
 * names is the setting it could not resolve. Both are recorded rather than
 * accepted silently. The last three are the failures: a finished turn built out
 * of nothing, a message that names no cause, and a turn that never settled.
 */
type Verdict = "incomplete" | "deadline" | "configuration" | "finished" | "unclassified" | "outran-the-bound";

/**
 * The budget the probes declare. A cut body is instant, so this is only the
 * ceiling on a provider that retries the empty response a few times; every
 * ladder under test fits inside it.
 */
const DECLARED_BUDGET_MS = 5_000;

/**
 * When a cut stream has taken so long that a hang is the better explanation.
 * Well above the declared budget times the longest retry ladder any probe can
 * run against an instant EOF, so the two cannot race.
 */
const BOUND_MS = 30_000;

interface Cut {
	/** Short name, used in the pinned tables and in a failure diff. */
	arm: string;
	/** Bytes the server writes before closing. */
	body: string;
}

/**
 * Two cuts, both dialect-agnostic. `nothing` is a body that closes with zero
 * bytes written, which is what a proxy that dies between headers and payload
 * produces. `comment` writes an SSE keepalive first, so bytes DID arrive and
 * the first-event watchdog is satisfied: whatever happens next is the decoder's
 * own end-of-stream decision and not a timeout wearing its clothes.
 */
const CUTS: Cut[] = [
	{ arm: "nothing", body: "" },
	{ arm: "comment", body: ": keepalive\n\n" },
];

/**
 * Which class a message names. A ladder, because a provider may name both the
 * event and its cause, and the cause is the more specific answer.
 */
function classify(text: string): Verdict {
	if (text === "COMPLETED") return "finished";
	// First: a provider whose own ladder outlived the caller's budget reports the
	// deadline truthfully, and reading that as a truncation would credit it with
	// a judgement it never made.
	if (/timed out|timeout|first event|aborted|abort/i.test(text)) return "deadline";
	// A handshake that precedes the stream — GitLab Duo resolves a namespace
	// before it can reach a model — never sees the cut body, and what it reports
	// is the setting it could not resolve. A true statement about a different
	// step, so it is its own verdict rather than a truncation or a hole.
	if (/unable to find|set [A-Z_]+ to|namespace/i.test(text)) return "configuration";
	if (
		/truncat|incomplete|closed before|ended before|ended without|premature|unexpected end|empty|no (response|content|candidates|turn|message)|without a (finish|terminal|turn)/i.test(
			text,
		)
	) {
		return "incomplete";
	}
	// Bytes the dialect could not read are the same finding in its own words: the
	// decoder reached the end of what arrived and could not build a turn out of
	// it. Each dialect names its own format, so the format names are here.
	if (/parse|malformed|invalid json|json|protocol|frame|decode|protobuf|gzip|eventstream/i.test(text)) {
		return "incomplete";
	}
	return "unclassified";
}

/** What one arm observed for one API. */
interface Observation {
	verdict: Verdict;
	/** A message that ends in punctuation and nothing else names no cause. */
	endedAtNothing: boolean;
}

let truncatingHttp2 = new Map<string, TruncatingHttp2Server>();

beforeAll(async () => {
	truncatingHttp2 = new Map();
	for (const cut of CUTS) {
		truncatingHttp2.set(cut.arm, await startTruncatingHttp2Server(cut.body));
	}
});

afterAll(async () => {
	for (const server of truncatingHttp2.values()) await server.close();
	truncatingHttp2.clear();
});

afterEach(() => {
	restoreProbeEnv();
});

async function observe(api: string, cut: Cut): Promise<Observation> {
	const apiKey = API_PROBES[api].apiKey ?? DEFAULT_PROBE_API_KEY;
	const baseUrl = API_PROBES[api].http2
		? (truncatingHttp2.get(cut.arm)?.baseUrl ?? DEAD_ENDPOINT_URL)
		: DEAD_ENDPOINT_URL;
	const stopReading = new AbortController();
	const options: StreamOptions = {
		apiKey,
		fetch: fetchThatEndsEarly(cut.body),
		signal: stopReading.signal,
		streamFirstEventTimeoutMs: DECLARED_BUDGET_MS,
		streamIdleTimeoutMs: DECLARED_BUDGET_MS,
		maxRetryDelayMs: 1,
	};

	const settle = async (): Promise<string> => {
		try {
			const events = callStream(modelFor(api, baseUrl), probeContext, options);
			for await (const _event of events) {
				// Drained on purpose: the question is how the turn ENDS, and a cut
				// stream may end as an error event, a rejected result, or a throw.
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

	// A real timer, deliberately: the transport is a real socket and half the
	// claim is that the turn settles at all. The bound is well above the cost of
	// any ladder a probe can run against an instant EOF, so neither races.
	const overrun = Promise.withResolvers<string>();
	const timer = setTimeout(() => overrun.resolve("OVERRAN"), BOUND_MS);
	try {
		const detail = await Promise.race([settle(), overrun.promise]);
		return {
			verdict: detail === "OVERRAN" ? "outran-the-bound" : classify(detail),
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
 * api is RED here until someone records what its cut streams do.
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

/** One verdict across every api, for an arm where all fourteen agree. */
function everyApiReports(verdict: Verdict): Record<string, Verdict> {
	const table: Record<string, Verdict> = {};
	for (const api of DECIDED_APIS) table[api] = verdict;
	return table;
}

/**
 * The verdict each api reaches, per cut. A cell that is not `incomplete` is a
 * decision somebody made about that dialect, recorded here with its reason.
 * `finished` may never appear: an empty stream is not an answer on any dialect,
 * and a cell that turns into one is the defect this suite exists to catch.
 */
const EXPECTED: Record<string, Record<string, Verdict>> = {
	nothing: {
		...everyApiReports("incomplete"),
		// GitLab Duo never reaches the decoder: its namespace handshake reads an
		// empty body from every candidate, walks all of them, and ends with the
		// remedy for a namespace it could not resolve. That is a true statement
		// about the step it failed at, and the arm below records the same thing,
		// so a change to either turns this red.
		"gitlab-duo-agent": "configuration",
	},
	comment: {
		...everyApiReports("incomplete"),
		"gitlab-duo-agent": "configuration",
	},
};

describe("a stream that stops mid-turn is never reported as a finished one", () => {
	it("has a probe for every API in the union", () => {
		expect(Object.keys(API_PROBES).sort()).toEqual([...BUILTIN_API_IDS].sort());
		expect([...DECIDED_APIS].sort()).toEqual([...BUILTIN_API_IDS].sort());
	});

	for (const cut of CUTS) {
		it(`reports a cut stream as unfinished on every api (${cut.arm})`, async () => {
			pinProbeEnv();
			const observed: Record<string, Observation> = {};
			const expected: Record<string, Observation> = {};
			for (const api of BUILTIN_API_IDS) {
				observed[api] = await observe(api, cut);
				expected[api] = { verdict: EXPECTED[cut.arm][api], endedAtNothing: false };
			}
			expect(observed).toEqual(expected);
		}, 120_000);
	}
});
