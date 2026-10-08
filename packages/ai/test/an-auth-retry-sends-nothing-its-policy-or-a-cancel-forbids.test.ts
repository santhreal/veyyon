import { describe, expect, it } from "bun:test";
import type { OAuthAccess, OAuthAccessSource } from "@veyyon/ai";
import {
	createAuthRetryKeyState,
	isAuthRetryableError,
	resolveNextAuthRetryKey,
	withAuth,
	withOAuthAccess,
} from "@veyyon/ai";

/**
 * WHY: `withAuth` and `withOAuthAccess` walk one retry policy. A 401 refreshes the current
 * credential once, then switches to one sibling. A usage limit rotates straight through siblings,
 * and a credential reached that way gets its own refresh on a later 401. No bearer is sent twice,
 * no rotation lands on a credential identity already sent, rotation is handed the bearer, the
 * credential id and the error of the attempt that just failed, and the caller's classifier decides
 * which failures retry. Each scenario pins the full trace of resolves, refreshes, rotations and
 * attempts, so a step that is skipped, repeated, reordered or handed the wrong credential or error
 * changes the trace.
 *
 * The cancellation class: every scenario is replayed once per traced event with the caller's abort
 * landing inside that event. The trace must end at that event and the operation must settle with
 * the caller's reason, so an await point that misses its abort check shows up as one more request.
 * `resolveNextAuthRetryKey` is swept the same way, since the streaming driver in `stream.ts` attempts
 * whatever key it returns.
 *
 * Not caught here: the streaming driver's own loop, which settles a cancel with the captured
 * failure rather than the reason; the attempt ceiling, pinned in `auth-retry.test.ts`; and the
 * wording of the warning logged when a retry gives up, pinned in `auth-retry-giveup-loud.test.ts`.
 */

type Failure = "401" | "usage" | "418";
type Outcome = Failure | "ok";

const FAILURES: Record<Failure, { message: string; status: number }> = {
	"401": { message: "401 authentication_error", status: 401 },
	usage: { message: "You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min.", status: 429 },
	"418": { message: "418 I'm a teapot", status: 418 },
};

/** An attempt failure tagged with its kind and the credential that drew it, e.g. `401@a1`. */
class ScriptedFailure extends Error {
	readonly status: number;
	readonly tag: string;

	constructor(failure: Failure, credential: string) {
		super(FAILURES[failure].message);
		this.status = FAILURES[failure].status;
		this.tag = `${failure}@${credential}`;
	}
}

function label(error: unknown): string {
	return error instanceof ScriptedFailure ? error.tag : String(error);
}

/** Records each call a driver makes, and aborts the caller's signal inside event number `abortAt`. */
class Recorder {
	readonly trace: string[] = [];
	readonly reason = new Error("caller cancelled");
	readonly #controller = new AbortController();
	readonly #abortAt: number | undefined;

	constructor(abortAt?: number) {
		this.#abortAt = abortAt;
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	record(event: string): void {
		if (this.trace.length === this.#abortAt) this.#controller.abort(this.reason);
		this.trace.push(event);
	}
}

interface ScenarioSpec {
	name: string;
	/** What an attempt with each credential does. */
	outcomes: Readonly<Record<string, Outcome>>;
	/** The caller's classifier retries a 418, which the default classifier throws. */
	retries418?: boolean;
	trace: readonly string[];
	/** `ok:<credential>`, or `error:<tag>` of the failure the operation rejects with. */
	settles: string;
}

interface Credential {
	token: string;
	id?: number;
}

interface OAuthSpec extends ScenarioSpec {
	initial: Credential;
	/** Successive results of a forced refresh. */
	refreshes?: ReadonlyArray<Credential | "throws">;
	/** Successive results of a rotation: the sibling the session moves to, a decline, or a failure. */
	rotations?: ReadonlyArray<Credential | "declines" | "throws">;
}

interface KeySpec extends ScenarioSpec {
	initial: string;
	/** Successive answers to every resolve after the initial one. */
	resolves?: ReadonlyArray<string | undefined | "throws">;
}

interface Scenario {
	name: string;
	trace: readonly string[];
	settles: string;
	/** The last traced event is an attempt whose own result settles the operation. */
	settledByLastAttempt: boolean;
	run(recorder: Recorder): Promise<string>;
}

function classifier(spec: ScenarioSpec): ((error: unknown) => boolean) | undefined {
	if (!spec.retries418) return undefined;
	return error => (error instanceof ScriptedFailure && error.status === 418) || isAuthRetryableError(error);
}

function attempt(spec: ScenarioSpec, recorder: Recorder, credential: string): string {
	recorder.record(`attempt ${credential}`);
	const outcome = spec.outcomes[credential];
	if (outcome === undefined) throw new Error(`no outcome scripted for ${credential}`);
	if (outcome === "ok") return `ok:${credential}`;
	throw new ScriptedFailure(outcome, credential);
}

function settledByLastAttempt(spec: ScenarioSpec): boolean {
	const last = spec.trace.at(-1) ?? "";
	if (!last.startsWith("attempt ")) return false;
	const outcome = spec.outcomes[last.slice("attempt ".length)];
	return outcome === "ok" || (outcome === "418" && !spec.retries418);
}

function toAccess(credential: Credential): OAuthAccess {
	return credential.id === undefined
		? { accessToken: credential.token }
		: { accessToken: credential.token, credentialId: credential.id };
}

function oauthScenario(spec: OAuthSpec): Scenario {
	return {
		name: `withOAuthAccess: ${spec.name}`,
		trace: spec.trace,
		settles: spec.settles,
		settledByLastAttempt: settledByLastAttempt(spec),
		run(recorder) {
			const refreshes = [...(spec.refreshes ?? [])];
			const rotations = [...(spec.rotations ?? [])];
			let current = spec.initial;
			const storage: OAuthAccessSource = {
				async getOAuthAccess(_provider, _sessionId, options) {
					if (!options?.forceRefresh) {
						recorder.record("get");
						return toAccess(current);
					}
					recorder.record("refresh");
					const refreshed = refreshes.shift();
					if (refreshed === "throws") throw new Error("refresh failed");
					if (refreshed === undefined) return undefined;
					current = refreshed;
					return toAccess(refreshed);
				},
				async rotateSessionCredential(_provider, _sessionId, options) {
					recorder.record(
						`rotate from ${options?.apiKey}#${options?.credentialId ?? "-"} after ${label(options?.error)}`,
					);
					const rotated = rotations.shift();
					if (rotated === "throws") throw new Error("rotation failed");
					if (rotated === undefined || rotated === "declines") return false;
					current = rotated;
					return true;
				},
			};
			return withOAuthAccess(storage, "prov", async access => attempt(spec, recorder, access.accessToken), {
				signal: recorder.signal,
				isAuthError: classifier(spec),
			});
		},
	};
}

function keyScenario(spec: KeySpec): Scenario {
	return {
		name: `withAuth: ${spec.name}`,
		trace: spec.trace,
		settles: spec.settles,
		settledByLastAttempt: settledByLastAttempt(spec),
		run(recorder) {
			const resolves = [...(spec.resolves ?? [])];
			return withAuth(
				ctx => {
					if (ctx.error === undefined) {
						recorder.record("resolve initial");
						return spec.initial;
					}
					const step = ctx.lastChance ? "rotate" : "refresh";
					recorder.record(`resolve ${step} after ${label(ctx.error)} from ${ctx.previousKey}`);
					const next = resolves.shift();
					if (next === "throws") throw new Error("resolver failed");
					return next;
				},
				async key => attempt(spec, recorder, key),
				{ signal: recorder.signal, isAuthError: classifier(spec) },
			);
		},
	};
}

const SCENARIOS: readonly Scenario[] = [
	oauthScenario({
		name: "a 401 refreshes the credential once, then switches to one sibling",
		initial: { token: "a1", id: 1 },
		refreshes: [{ token: "a2", id: 1 }],
		rotations: [
			{ token: "b1", id: 2 },
			{ token: "c1", id: 3 },
		],
		outcomes: { a1: "401", a2: "401", b1: "401", c1: "ok" },
		trace: ["get", "attempt a1", "refresh", "attempt a2", "rotate from a2#1 after 401@a2", "get", "attempt b1"],
		settles: "error:401@b1",
	}),
	oauthScenario({
		name: "a usage limit rotates straight to a sibling, and on until rotation declines",
		initial: { token: "a1", id: 1 },
		rotations: [{ token: "b1", id: 2 }, { token: "c1", id: 3 }, "declines"],
		outcomes: { a1: "usage", b1: "usage", c1: "usage" },
		trace: [
			"get",
			"attempt a1",
			"rotate from a1#1 after usage@a1",
			"get",
			"attempt b1",
			"rotate from b1#2 after usage@b1",
			"get",
			"attempt c1",
			"rotate from c1#3 after usage@c1",
		],
		settles: "error:usage@c1",
	}),
	oauthScenario({
		name: "a credential reached by a usage rotation gets its own refresh on a 401",
		initial: { token: "a1", id: 1 },
		refreshes: [
			{ token: "a2", id: 1 },
			{ token: "b2", id: 2 },
		],
		rotations: [{ token: "b1", id: 2 }],
		outcomes: { a1: "401", a2: "usage", b1: "401", b2: "ok" },
		trace: [
			"get",
			"attempt a1",
			"refresh",
			"attempt a2",
			"rotate from a2#1 after usage@a2",
			"get",
			"attempt b1",
			"refresh",
			"attempt b2",
		],
		settles: "ok:b2",
	}),
	oauthScenario({
		name: "a rotation onto a credential already sent ends the retry, whatever bearer it holds now",
		initial: { token: "a1", id: 1 },
		rotations: [{ token: "a3", id: 1 }],
		outcomes: { a1: "usage", a3: "ok" },
		trace: ["get", "attempt a1", "rotate from a1#1 after usage@a1", "get"],
		settles: "error:usage@a1",
	}),
	oauthScenario({
		name: "a rotation onto a bearer already sent ends the retry, whatever credential carries it",
		initial: { token: "a1", id: 1 },
		refreshes: [{ token: "a2", id: 1 }],
		rotations: [{ token: "a1", id: 2 }],
		outcomes: { a1: "401", a2: "usage" },
		trace: ["get", "attempt a1", "refresh", "attempt a2", "rotate from a2#1 after usage@a2", "get"],
		settles: "error:usage@a2",
	}),
	oauthScenario({
		name: "a refresh that hands back the bearer already sent falls through to the sibling switch",
		initial: { token: "a1", id: 1 },
		refreshes: [{ token: "a1", id: 1 }],
		rotations: [{ token: "b1", id: 2 }],
		outcomes: { a1: "401", b1: "ok" },
		trace: ["get", "attempt a1", "refresh", "rotate from a1#1 after 401@a1", "get", "attempt b1"],
		settles: "ok:b1",
	}),
	oauthScenario({
		name: "a refresh and a rotation that both fail end the retry with the auth failure",
		initial: { token: "a1", id: 1 },
		refreshes: ["throws"],
		rotations: ["throws"],
		outcomes: { a1: "401" },
		trace: ["get", "attempt a1", "refresh", "rotate from a1#1 after 401@a1"],
		settles: "error:401@a1",
	}),
	oauthScenario({
		name: "credentials without an id are told apart by bearer",
		initial: { token: "a1" },
		rotations: [{ token: "b1" }, { token: "a1" }],
		outcomes: { a1: "usage", b1: "usage" },
		trace: [
			"get",
			"attempt a1",
			"rotate from a1#- after usage@a1",
			"get",
			"attempt b1",
			"rotate from b1#- after usage@b1",
			"get",
		],
		settles: "error:usage@b1",
	}),
	oauthScenario({
		name: "a failure the default classifier does not retry is thrown from the first attempt",
		initial: { token: "a1", id: 1 },
		refreshes: [{ token: "a2", id: 1 }],
		outcomes: { a1: "418", a2: "ok" },
		trace: ["get", "attempt a1"],
		settles: "error:418@a1",
	}),
	oauthScenario({
		name: "a failure the default classifier does not retry is thrown from a retried attempt",
		initial: { token: "a1", id: 1 },
		refreshes: [{ token: "a2", id: 1 }],
		rotations: [{ token: "b1", id: 2 }],
		outcomes: { a1: "401", a2: "418", b1: "ok" },
		trace: ["get", "attempt a1", "refresh", "attempt a2"],
		settles: "error:418@a2",
	}),
	oauthScenario({
		name: "a failure the caller's classifier retries walks the policy",
		initial: { token: "a1", id: 1 },
		refreshes: [{ token: "a2", id: 1 }],
		outcomes: { a1: "418", a2: "ok" },
		retries418: true,
		trace: ["get", "attempt a1", "refresh", "attempt a2"],
		settles: "ok:a2",
	}),
	keyScenario({
		name: "a 401 refreshes the key once, then switches to one sibling",
		initial: "k0",
		resolves: ["k1", "k2", "k3"],
		outcomes: { k0: "401", k1: "401", k2: "401", k3: "ok" },
		trace: [
			"resolve initial",
			"attempt k0",
			"resolve refresh after 401@k0 from k0",
			"attempt k1",
			"resolve rotate after 401@k1 from k1",
			"attempt k2",
		],
		settles: "error:401@k2",
	}),
	keyScenario({
		name: "a usage limit rotates straight to a sibling, and on until the resolver declines",
		initial: "k0",
		resolves: ["k1", "k2", undefined],
		outcomes: { k0: "usage", k1: "usage", k2: "usage" },
		trace: [
			"resolve initial",
			"attempt k0",
			"resolve rotate after usage@k0 from k0",
			"attempt k1",
			"resolve rotate after usage@k1 from k1",
			"attempt k2",
			"resolve rotate after usage@k2 from k2",
		],
		settles: "error:usage@k2",
	}),
	keyScenario({
		name: "a key reached by a usage rotation gets its own refresh on a 401",
		initial: "k0",
		resolves: ["k1", "k2", "k3"],
		outcomes: { k0: "401", k1: "usage", k2: "401", k3: "ok" },
		trace: [
			"resolve initial",
			"attempt k0",
			"resolve refresh after 401@k0 from k0",
			"attempt k1",
			"resolve rotate after usage@k1 from k1",
			"attempt k2",
			"resolve refresh after 401@k2 from k2",
			"attempt k3",
		],
		settles: "ok:k3",
	}),
	keyScenario({
		name: "a resolver that hands back a key already sent ends the rotation",
		initial: "k0",
		resolves: ["k0"],
		outcomes: { k0: "usage" },
		trace: ["resolve initial", "attempt k0", "resolve rotate after usage@k0 from k0"],
		settles: "error:usage@k0",
	}),
	keyScenario({
		name: "a refresh that hands back the key already sent falls through to the switch",
		initial: "k0",
		resolves: ["k0", "k1"],
		outcomes: { k0: "401", k1: "ok" },
		trace: [
			"resolve initial",
			"attempt k0",
			"resolve refresh after 401@k0 from k0",
			"resolve rotate after 401@k0 from k0",
			"attempt k1",
		],
		settles: "ok:k1",
	}),
	keyScenario({
		name: "a resolver that throws ends the retry with the auth failure",
		initial: "k0",
		resolves: ["throws", "throws"],
		outcomes: { k0: "401" },
		trace: [
			"resolve initial",
			"attempt k0",
			"resolve refresh after 401@k0 from k0",
			"resolve rotate after 401@k0 from k0",
		],
		settles: "error:401@k0",
	}),
	keyScenario({
		name: "a failure the default classifier does not retry is thrown from the first attempt",
		initial: "k0",
		resolves: ["k1"],
		outcomes: { k0: "418", k1: "ok" },
		trace: ["resolve initial", "attempt k0"],
		settles: "error:418@k0",
	}),
	keyScenario({
		name: "a failure the default classifier does not retry is thrown from a retried attempt",
		initial: "k0",
		resolves: ["k1", "k2"],
		outcomes: { k0: "401", k1: "418", k2: "ok" },
		trace: ["resolve initial", "attempt k0", "resolve refresh after 401@k0 from k0", "attempt k1"],
		settles: "error:418@k1",
	}),
	keyScenario({
		name: "a failure the caller's classifier retries walks the policy",
		initial: "k0",
		resolves: ["k1"],
		outcomes: { k0: "418", k1: "ok" },
		retries418: true,
		trace: ["resolve initial", "attempt k0", "resolve refresh after 418@k0 from k0", "attempt k1"],
		settles: "ok:k1",
	}),
];

async function settle(scenario: Scenario, recorder: Recorder): Promise<string> {
	try {
		return await scenario.run(recorder);
	} catch (error) {
		return error === recorder.reason ? "cancelled" : `error:${label(error)}`;
	}
}

for (const scenario of SCENARIOS) {
	describe(scenario.name, () => {
		it("takes each step of the policy in order", async () => {
			const recorder = new Recorder();
			const settled = await settle(scenario, recorder);
			expect({ trace: recorder.trace, settled }).toEqual({ trace: [...scenario.trace], settled: scenario.settles });
		});

		it("sends nothing after a cancel that lands inside any step", async () => {
			const last = scenario.trace.length - 1;
			for (let abortAt = 0; abortAt <= last; abortAt++) {
				const recorder = new Recorder(abortAt);
				const settled = await settle(scenario, recorder);
				expect({ abortAt, trace: recorder.trace, settled }).toEqual({
					abortAt,
					trace: scenario.trace.slice(0, abortAt + 1),
					settled: abortAt === last && scenario.settledByLastAttempt ? scenario.settles : "cancelled",
				});
			}
		});
	});
}

describe("resolveNextAuthRetryKey, which the streaming driver attempts with", () => {
	const CASES: ReadonlyArray<{ failure: Failure; answers: readonly string[]; trace: readonly string[] }> = [
		// The refresh hands back the key already sent, so the step falls through to the switch.
		{ failure: "401", answers: ["k0", "k1"], trace: ["resolve refresh", "resolve rotate"] },
		{ failure: "usage", answers: ["k1"], trace: ["resolve rotate"] },
	];

	for (const { failure, answers, trace } of CASES) {
		it(`returns no key once the caller aborts inside any resolve after a ${failure}`, async () => {
			const run = async (abortAt?: number): Promise<{ key: string | undefined; trace: string[] }> => {
				const recorder = new Recorder(abortAt);
				const queue = [...answers];
				const key = await resolveNextAuthRetryKey(
					createAuthRetryKeyState("k0"),
					ctx => {
						recorder.record(`resolve ${ctx.lastChance ? "rotate" : "refresh"}`);
						return queue.shift();
					},
					new ScriptedFailure(failure, "k0"),
					recorder.signal,
				);
				return { key, trace: recorder.trace };
			};

			expect(await run()).toEqual({ key: "k1", trace: [...trace] });
			for (let abortAt = 0; abortAt < trace.length; abortAt++) {
				expect(await run(abortAt)).toEqual({ key: undefined, trace: trace.slice(0, abortAt + 1) });
			}
		});
	}
});
