/**
 * The watchdog budget each class of lazy provider stream runs under.
 *
 * This suite exists because of a live report that grok, cursor and devin were
 * "very slow and constantly error out" in veyyon while behaving perfectly in
 * their own harnesses, surfacing as:
 *
 *     Provider stream stalled while waiting for the next event
 *
 * The cause was entirely in the budget these streams were handed.
 * `cursor-agent` and `devin-agent` were the only two lazy providers registered
 * with no `LazyStreamLimits` at all, so they inherited the generic 100s
 * first-event / 120s idle defaults meant for token streams. Both are backends
 * that run their own agent loop remotely and emit nothing to us while the agent
 * plans, edits and runs commands, which routinely outlasts two minutes. The
 * watchdog then aborted a healthy session. Their own harnesses impose no such
 * budget, which is exactly why the same model looked fine there.
 *
 * `resolveLazyStreamBudget` is asserted directly rather than through a live
 * stream because the failure is a deadline: observing it end to end means
 * waiting out ten real minutes, and a test that cannot afford to do that would
 * quietly stop defending the numbers.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	AGENTIC_BACKEND_LAZY_STREAM_LIMITS,
	type LazyStreamLimits,
	resolveLazyStreamBudget,
} from "@veyyon/ai/providers/register-builtins";
import { $env } from "@veyyon/utils/env";

/** The generic defaults in `idle-iterator.ts` — what an unlimited provider inherits. */
const GENERIC_FIRST_EVENT_MS = 100_000;
const GENERIC_IDLE_MS = 120_000;

const ENV_KEYS = [
	"VEYYON_STREAM_IDLE_TIMEOUT_MS",
	"VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS",
	"VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS",
] as const;

const savedEnv = new Map<string, string | undefined>();

function setEnv(key: (typeof ENV_KEYS)[number], value: string): void {
	if (!savedEnv.has(key)) savedEnv.set(key, $env[key]);
	($env as Record<string, string | undefined>)[key] = value;
}

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete ($env as Record<string, string | undefined>)[key];
		else ($env as Record<string, string | undefined>)[key] = value;
	}
	savedEnv.clear();
});

describe("lazy provider stream budget", () => {
	describe("agentic backends (cursor-agent, devin-agent)", () => {
		/**
		 * The fix itself. A remote agent that thinks and runs tools for several
		 * minutes without emitting must not be read as a stalled provider, so the
		 * idle budget has to clear the generic 120s by a wide margin. If this
		 * regresses to the generic default, the original bug is back verbatim.
		 */
		it("waits minutes, not two minutes, before calling silence a stall", () => {
			const budget = resolveLazyStreamBudget({}, AGENTIC_BACKEND_LAZY_STREAM_LIMITS);

			expect(budget.idleTimeoutMs).toBe(600_000);
			expect(budget.idleTimeoutMs!).toBeGreaterThan(GENERIC_IDLE_MS);
		});

		/**
		 * The first event is the other half of the report: a cold agent start
		 * spends a long time on the remote side before the first token reaches
		 * us, and the generic budget killed the turn before it began.
		 *
		 * The resolved value is 600s rather than the 300s floor the limits name,
		 * because `getStreamFirstEventTimeoutMs` takes `max(fallback, idle)` — a
		 * stream is never given less time to start than it is given to continue.
		 * The 300s floor is not dead config; it is what survives when an operator
		 * lowers idle, which the next test pins.
		 */
		it("allows a long cold start before the first event", () => {
			const budget = resolveLazyStreamBudget({}, AGENTIC_BACKEND_LAZY_STREAM_LIMITS);

			expect(budget.firstItemTimeoutMs).toBe(600_000);
			expect(budget.firstItemTimeoutMs!).toBeGreaterThan(GENERIC_FIRST_EVENT_MS);
		});

		/**
		 * A cold agent start is slow for reasons that have nothing to do with
		 * steady-state silence, so the 300s first-event floor must hold even when
		 * an operator tightens the idle budget well below it. Without the floor,
		 * lowering idle to seconds would also cut the cold start to seconds and
		 * reproduce the original report on the very first event.
		 */
		it("keeps the cold-start floor when an operator tightens idle", () => {
			setEnv("VEYYON_STREAM_IDLE_TIMEOUT_MS", "5000");

			const budget = resolveLazyStreamBudget({}, AGENTIC_BACKEND_LAZY_STREAM_LIMITS);

			expect(budget.idleTimeoutMs).toBe(5000);
			expect(budget.firstItemTimeoutMs).toBe(300_000);
		});

		/**
		 * Widening the budget must not become "no budget". `devin.ts` is a bare
		 * Connect frame reader with no timeout of its own, so a genuinely dead
		 * socket has nothing but this watchdog to end it. Both deadlines stay
		 * finite and armed.
		 */
		it("still arms both watchdogs, so a dead socket cannot hang forever", () => {
			const budget = resolveLazyStreamBudget({}, AGENTIC_BACKEND_LAZY_STREAM_LIMITS);

			expect(budget.idleTimeoutMs).toBeDefined();
			expect(Number.isFinite(budget.idleTimeoutMs!)).toBe(true);
			expect(budget.firstItemTimeoutMs).toBeGreaterThan(0);
			expect(Number.isFinite(budget.firstItemTimeoutMs!)).toBe(true);
		});

		/**
		 * The widened numbers are a default, not a policy. An operator who wants
		 * the old aggression back sets the env var and gets it, with no code
		 * change and no rebuild.
		 */
		it("yields to an operator env override", () => {
			setEnv("VEYYON_STREAM_IDLE_TIMEOUT_MS", "5000");

			const budget = resolveLazyStreamBudget({}, AGENTIC_BACKEND_LAZY_STREAM_LIMITS);

			expect(budget.idleTimeoutMs).toBe(5000);
		});

		/**
		 * `VEYYON_STREAM_IDLE_TIMEOUT_MS=0` is the documented way to disable the
		 * idle watchdog. Handing a provider a wider default must not silently
		 * re-arm a watchdog the operator turned off.
		 */
		it("honors an env value of 0 as watchdog disabled", () => {
			setEnv("VEYYON_STREAM_IDLE_TIMEOUT_MS", "0");

			const budget = resolveLazyStreamBudget({}, AGENTIC_BACKEND_LAZY_STREAM_LIMITS);

			expect(budget.idleTimeoutMs).toBeUndefined();
		});

		/**
		 * A per-call option is the most specific signal there is and outranks
		 * both the widened default and the env var.
		 */
		it("yields to an explicit caller option over env and default alike", () => {
			setEnv("VEYYON_STREAM_IDLE_TIMEOUT_MS", "5000");

			const budget = resolveLazyStreamBudget(
				{ streamIdleTimeoutMs: 777, streamFirstEventTimeoutMs: 888 },
				AGENTIC_BACKEND_LAZY_STREAM_LIMITS,
			);

			expect(budget.idleTimeoutMs).toBe(777);
			expect(budget.firstItemTimeoutMs).toBe(888);
		});
	});

	describe("providers that own their watchdog", () => {
		/**
		 * Every OpenAI-family and Anthropic provider wraps its own transport
		 * timeouts. The lazy wrapper must stay out of the way entirely rather
		 * than race them with a second, differently-tuned deadline and a generic
		 * error message that hides the provider's own diagnosis.
		 */
		it("arms neither watchdog", () => {
			const budget = resolveLazyStreamBudget({}, { providerHandlesStreamTimeouts: true });

			expect(budget.idleTimeoutMs).toBeUndefined();
			expect(budget.firstItemTimeoutMs).toBe(0);
		});

		/**
		 * The exemption is unconditional: a stray env var must not reintroduce
		 * the double watchdog this flag exists to prevent.
		 */
		it("stays disarmed even when the env vars are set", () => {
			setEnv("VEYYON_STREAM_IDLE_TIMEOUT_MS", "5000");
			setEnv("VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS", "5000");

			const budget = resolveLazyStreamBudget({}, { providerHandlesStreamTimeouts: true });

			expect(budget.idleTimeoutMs).toBeUndefined();
			expect(budget.firstItemTimeoutMs).toBe(0);
		});
	});

	describe("providers with no limits", () => {
		/**
		 * Pins the generic defaults that the agentic backends used to inherit.
		 * This is the negative control for the whole fix: it documents the exact
		 * budget that was aborting cursor and devin turns, and it is what the
		 * agentic numbers above are asserted to exceed.
		 */
		it("inherits the generic token-stream defaults", () => {
			const budget = resolveLazyStreamBudget({}, undefined);

			expect(budget.idleTimeoutMs).toBe(GENERIC_IDLE_MS);
			// Floored up to idle by `max(fallback, idle)`, the same rule the
			// agentic case follows; the 100s constant only shows through when a
			// caller or env var pushes idle below it.
			expect(budget.firstItemTimeoutMs).toBe(GENERIC_IDLE_MS);
		});

		/**
		 * The 100s generic cold-start default is reachable, not vestigial: it is
		 * what an unlimited provider gets once idle drops beneath it.
		 */
		it("falls back to the 100s cold-start default once idle drops below it", () => {
			setEnv("VEYYON_STREAM_IDLE_TIMEOUT_MS", "5000");

			const budget = resolveLazyStreamBudget({}, undefined);

			expect(budget.firstItemTimeoutMs).toBe(GENERIC_FIRST_EVENT_MS);
		});
	});

	describe("partial limits", () => {
		/**
		 * A provider that widens only the first-event floor (the Gemini CLI
		 * case) must keep the generic idle budget rather than have it silently
		 * dragged along.
		 */
		it("widening only the first event leaves idle at the generic default", () => {
			const limits: LazyStreamLimits = { defaultFirstEventTimeoutMs: 300_000 };

			const budget = resolveLazyStreamBudget({}, limits);

			expect(budget.firstItemTimeoutMs).toBe(300_000);
			expect(budget.idleTimeoutMs).toBe(GENERIC_IDLE_MS);
		});
	});
});
