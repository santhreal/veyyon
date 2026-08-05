/**
 * The pre-run credential verdict.
 *
 * WHY THIS SUITE EXISTS. Nothing checked the staged credential store before a
 * run, so a dead credential was discovered one container at a time: every trial
 * paid full container setup, failed to authenticate, and came back as a task
 * failure. The message the agent produced then blamed the model id rather than
 * the credential, and a burned 40-trial run was misread as an unservable model.
 * The response was an allowlist gate against a model that worked, later reverted.
 *
 * So the verdict's job is not only to catch a dead store, it is to be UNAMBIGUOUS
 * about which of three things happened. "One credential works", "every credential
 * that could be checked failed", and "nothing could be checked at all" are three
 * different claims, and reporting any of the last two as success is what let the
 * original failure hide.
 */
import { describe, expect, it } from "bun:test";
import {
	type CredentialProbe,
	decideAuthPreflight,
	describeAuthPreflightFailure,
	describeExhaustedPool,
	exhaustedPoolFor,
	modelVendor,
	spentQuotaShouldAbort,
} from "./auth-preflight";

const STAGED = "/bench/assets/auth-agent.db";

describe("decideAuthPreflight", () => {
	/** One usable credential is all the bench needs, and an operator running
	 * several accounts routinely has stale rows beside a live one. Demanding that
	 * every row pass would block runs that can actually succeed. */
	it("passes when a single credential serves a token, even beside failures", () => {
		const probes: CredentialProbe[] = [
			{ provider: "anthropic", ok: false, reason: "401" },
			{ provider: "google-antigravity", ok: true },
		];
		expect(decideAuthPreflight(probes)).toEqual({ kind: "ok", usable: 1 });
	});

	/** The count is reported so the operator can notice a pool that has quietly
	 * shrunk from four working accounts to one. */
	it("counts every usable credential, not just the first", () => {
		const probes: CredentialProbe[] = [
			{ provider: "a", ok: true },
			{ provider: "b", ok: true },
			{ provider: "c", ok: null },
		];
		expect(decideAuthPreflight(probes)).toEqual({ kind: "ok", usable: 2 });
	});

	/** An empty store is its own outcome. It is the state produced by staging a
	 * freshly created db, and it needs a different instruction (log in) than a
	 * store whose credentials have expired (log in AGAIN). */
	it("reports an empty store distinctly from a failing one", () => {
		expect(decideAuthPreflight([])).toEqual({ kind: "empty" });
	});

	/** THE regression. Every credential probed and every one failed, which is
	 * precisely the state that burned 40 trials while reporting a model error. */
	it("reports dead when every probed credential failed, carrying each reason", () => {
		const probes: CredentialProbe[] = [
			{ provider: "google-antigravity", ok: false, reason: "refresh token rejected" },
			{ provider: "anthropic", ok: false, reason: "401 Unauthorized" },
		];
		expect(decideAuthPreflight(probes)).toEqual({
			kind: "dead",
			failures: [
				{ provider: "google-antigravity", reason: "refresh token rejected" },
				{ provider: "anthropic", reason: "401 Unauthorized" },
			],
		});
	});

	/** The identity makes the message actionable when a pool holds several
	 * accounts on one provider: "anthropic failed" does not say which login to fix. */
	it("names the OAuth identity in a failure when one is known", () => {
		const verdict = decideAuthPreflight([{ provider: "anthropic", ok: false, reason: "401", email: "a@b.co" }]);
		expect(verdict).toEqual({ kind: "dead", failures: [{ provider: "anthropic (a@b.co)", reason: "401" }] });
	});

	/** A failure with no reason must still be reported as a failure. Dropping it
	 * for lack of a reason string would turn a dead store into an empty list and
	 * then into a pass. */
	it("keeps a reasonless failure rather than discarding it", () => {
		const verdict = decideAuthPreflight([{ provider: "anthropic", ok: false }]);
		expect(verdict).toEqual({ kind: "dead", failures: [{ provider: "anthropic", reason: "no reason reported" }] });
	});

	/**
	 * `ok: null` means the provider has no probe configured, so the credential is
	 * unverified, NOT verified-good. It gets its own outcome that the caller
	 * reports out loud before proceeding. Folding it into `ok` would be a silent
	 * fallback: the run would claim a credential check passed when none ran.
	 */
	it("reports unverifiable, not ok, when nothing could be probed", () => {
		const probes: CredentialProbe[] = [
			{ provider: "custom", ok: null },
			{ provider: "custom", ok: null },
			{ provider: "other", ok: null },
		];
		expect(decideAuthPreflight(probes)).toEqual({ kind: "unverifiable", providers: ["custom", "other"] });
	});

	/**
	 * A definite failure outranks an unverifiable row. Reporting `unverifiable`
	 * here would downgrade a known-broken store to merely unknown and let the run
	 * proceed into the failure the preflight exists to prevent.
	 */
	it("prefers a definite failure over an unverifiable sibling", () => {
		const probes: CredentialProbe[] = [
			{ provider: "custom", ok: null },
			{ provider: "anthropic", ok: false, reason: "401" },
		];
		expect(decideAuthPreflight(probes)).toEqual({
			kind: "dead",
			failures: [{ provider: "anthropic", reason: "401" }],
		});
	});
});

describe("describeAuthPreflightFailure", () => {
	/**
	 * The message must point at the credential. The previous failure path said
	 * `Model "<id>" not found` for a dead token, which is what sent a real
	 * investigation into model allowlists for a day.
	 */
	it("blames the credential and never the model", () => {
		const verdict = decideAuthPreflight([{ provider: "google-antigravity", ok: false, reason: "401" }]);
		const message = describeAuthPreflightFailure(verdict, STAGED);
		expect(message).toContain(STAGED);
		expect(message).toContain("cannot serve a token");
		expect(message).toContain("401");
		expect(message).not.toContain("--model");
		expect(message.toLowerCase()).not.toContain("not found");
		// It does steer away from the model id, because that is where the last
		// investigation went. It must do so without echoing the flag.
		expect(message).toContain("not at fault");
	});

	/** Every failing credential is listed. Printing only the first hides the
	 * second account an operator would otherwise fix in the same pass. */
	it("lists every failing credential", () => {
		const verdict = decideAuthPreflight([
			{ provider: "a", ok: false, reason: "expired" },
			{ provider: "b", ok: false, reason: "revoked" },
		]);
		const message = describeAuthPreflightFailure(verdict, STAGED);
		expect(message).toContain("a: expired");
		expect(message).toContain("b: revoked");
	});

	/** An empty store gets the first-login instruction, not the log-in-again one,
	 * and names the canonical path a login actually writes. */
	it("tells an operator with an empty store where a login lands", () => {
		const message = describeAuthPreflightFailure({ kind: "empty" }, STAGED);
		expect(message).toContain("no credentials");
		expect(message).toContain("~/.veyyon/shared-auth/agent.db");
	});

	/** The two proceeding verdicts have no failure to describe. An accidental
	 * message here would print an error before a run that is about to work. */
	it("produces nothing for verdicts that proceed", () => {
		expect(describeAuthPreflightFailure({ kind: "ok", usable: 1 }, STAGED)).toBe("");
		expect(describeAuthPreflightFailure({ kind: "unverifiable", providers: ["x"] }, STAGED)).toBe("");
	});
});

/**
 * The second question the preflight has to ask, and used not to.
 *
 * "Can a credential serve a token" stays TRUE after a quota pool empties, because
 * authentication and metering are different systems. Run
 * `2026-07-25T20-46-08-607Z` passed this preflight cleanly, scored ten trials,
 * then hit `RESOURCE_EXHAUSTED` and produced twenty-six consecutive zero-token
 * trials. The run.ts abort catches that mid-flight now; catching it here costs
 * nothing instead of an hour of container setup, and prevents a half-finished run
 * whose missing samples read as data.
 *
 * The subtlety worth testing is that a gateway meters each upstream vendor
 * SEPARATELY. On google-antigravity the `:google:` pool was at 100% used while
 * `:openai:` and `:anthropic:` sat untouched, so "this account has quota" is not a
 * question with one answer.
 */
describe("modelVendor — which upstream pool a model draws from", () => {
	/** The three vendors a gateway meters separately, in the spellings that actually appear. */
	it("maps each vendor's model families", () => {
		expect(modelVendor("google-antigravity/gemini-3.5-flash")).toBe("google");
		expect(modelVendor("google-antigravity/claude-sonnet-5")).toBe("anthropic");
		expect(modelVendor("google-antigravity/gpt-5.3-codex")).toBe("openai");
		expect(modelVendor("openai/o3-mini")).toBe("openai");
	});

	/** Case is not meaningful in a model id, and an id that arrives capitalised must still match. */
	it("ignores case", () => {
		expect(modelVendor("Google-Antigravity/Gemini-3.5-Flash")).toBe("google");
	});

	/**
	 * AN UNKNOWN MODEL RETURNS NULL RATHER THAN A GUESS. A wrong guess here refuses
	 * a run that would have succeeded, which is worse than not checking at all, so
	 * the caller treats null as "could not check" and says so out loud instead of
	 * proceeding quietly.
	 */
	it("returns null for a model it cannot place, rather than guessing", () => {
		expect(modelVendor("some-vendor/mystery-model-v2")).toBeNull();
		expect(modelVendor("")).toBeNull();
	});
});

describe("exhaustedPoolFor — refusing a run whose pool is already spent", () => {
	/** Built in the provider's own nesting: `report.limits[].window.resetsAt`, not a flattened convenience shape. */
	const antigravity = (
		...pools: { id: string; status: string; window?: { resetsAt: number } }[]
	): CredentialProbe[] => [
		{ provider: "google-antigravity", ok: true, email: "someone@example.com", report: { limits: pools } },
	];

	/**
	 * THE REAL SHAPE that motivated this: three daily pools on one credential, one
	 * spent and two full. The spent one must be found for a Gemini model and the
	 * full ones must not mask it.
	 */
	it("finds the spent pool for the vendor the model draws from", () => {
		const probes = antigravity(
			{ id: "google-antigravity:google:default:daily", status: "exhausted", window: { resetsAt: 1785023411000 } },
			{ id: "google-antigravity:openai:default:daily", status: "ok" },
			{ id: "google-antigravity:anthropic:default:daily", status: "ok" },
		);
		expect(exhaustedPoolFor(probes, "google-antigravity/gemini-3.5-flash")).toEqual({
			pool: "google-antigravity:google:default:daily",
			resetsAt: 1785023411000,
		});
	});

	/**
	 * THE TWIN, and the reason a per-vendor check is worth the trouble. The same
	 * credential with the same spent Gemini pool must let a Claude or GPT run
	 * proceed, because those pools are untouched. A check that answered "this
	 * account is out of quota" would block two runs that can succeed.
	 */
	it("lets another vendor's model through on the same credential", () => {
		const probes = antigravity(
			{ id: "google-antigravity:google:default:daily", status: "exhausted", window: { resetsAt: 1785023411000 } },
			{ id: "google-antigravity:openai:default:daily", status: "ok" },
			{ id: "google-antigravity:anthropic:default:daily", status: "ok" },
		);
		expect(exhaustedPoolFor(probes, "google-antigravity/claude-sonnet-5")).toBeNull();
		expect(exhaustedPoolFor(probes, "google-antigravity/gpt-5.3-codex")).toBeNull();
	});

	/**
	 * A spent pool on a DIFFERENT provider is not this run's problem. An operator
	 * routinely has several credentials, and refusing on an unrelated one would
	 * block runs for a provider that is fine.
	 */
	it("ignores a spent pool belonging to another provider", () => {
		const probes: CredentialProbe[] = [
			{
				provider: "openai-codex",
				ok: true,
				report: { limits: [{ id: "openai-codex:primary", status: "exhausted" }] },
			},
			...antigravity({ id: "google-antigravity:google:default:daily", status: "ok" }),
		];
		expect(exhaustedPoolFor(probes, "google-antigravity/gemini-3.5-flash")).toBeNull();
	});

	/**
	 * NOT CHECKED IS NOT FINE, and both are reported as null here on purpose: the
	 * caller distinguishes them by asking `modelVendor` and says out loud when the
	 * pool could not be checked. Silently treating an unprobeable provider as
	 * healthy is the exact silence this preflight exists to remove.
	 */
	it("returns null when there is nothing to check", () => {
		expect(exhaustedPoolFor([], "google-antigravity/gemini-3.5-flash")).toBeNull();
		expect(exhaustedPoolFor(antigravity(), "google-antigravity/gemini-3.5-flash")).toBeNull();
		expect(
			exhaustedPoolFor(antigravity({ id: "google-antigravity:google:default:daily", status: "ok" }), "x/mystery"),
		).toBeNull();
	});

	/** A pool with no reported reset time still refuses; the operator just loses the "come back at" hint. */
	it("refuses without a reset time when the provider named none", () => {
		const probes = antigravity({ id: "google-antigravity:google:default:daily", status: "exhausted" });
		expect(exhaustedPoolFor(probes, "google-antigravity/gemini-3.5-flash")).toEqual({
			pool: "google-antigravity:google:default:daily",
		});
	});
});

describe("describeExhaustedPool — the message names the way out", () => {
	/**
	 * The reset time is the only actionable part. An operator told merely that
	 * quota ran out reruns straight into the same wall; one told when it refills
	 * either waits or switches vendor, and both routes are named.
	 */
	it("names the pool, the refill time, and the other-vendor escape", () => {
		const text = describeExhaustedPool(
			{ pool: "google-antigravity:google:default:daily", resetsAt: 1785023411000 },
			"google-antigravity/gemini-3.5-flash",
		);
		expect(text).toContain("google-antigravity:google:default:daily");
		expect(text).toContain("2026-07-25T23:50:11.000Z");
		expect(text).toContain("--model");
		expect(text).toContain("meters each upstream vendor separately");
	});

	/**
	 * It must NOT blame the model id, for the same reason `describeAuthPreflightFailure`
	 * does not: the previous generation of this failure sent a real investigation
	 * after an "unservable model" that worked fine, and produced an allowlist gate
	 * that had to be reverted.
	 */
	it("says plainly that the model id is not at fault", () => {
		const text = describeExhaustedPool({ pool: "p" }, "google-antigravity/gemini-3.5-flash");
		expect(text).toContain("The model id and the arm allowlists are not at fault");
		expect(text).not.toContain("It refills at");
	});
});

/**
 * The shape lock, and the reason it exists as its own suite.
 *
 * The first version of the quota check read `probe.limits[].resetsAt`. That
 * type-checked, every hand-written fixture agreed with it, all its tests passed,
 * and it matched NOTHING on real data: the provider nests them as
 * `probe.report.limits[].window.resetsAt`. So the check silently never fired, on
 * exactly the credential state it was written for, and the only way it surfaced
 * was running it against a live store and noticing it said "has quota" about a
 * pool reported as exhausted.
 *
 * This suite is the guard against that whole class. It asserts the payload
 * literally as `checkCredentials()` emits it, so a fixture can no longer drift
 * into a convenient shape that only the tests believe in.
 */
describe("exhaustedPoolFor reads the shape checkCredentials actually returns", () => {
	/**
	 * Verbatim from a live probe of the staged auth DB on 2026-07-25, trimmed to the
	 * fields this module reads. Copied rather than constructed, because the point is
	 * to be told when reality moves.
	 */
	const LIVE_PROBE = {
		id: 2,
		provider: "google-antigravity",
		type: "oauth",
		ok: true,
		email: "contact@santh.dev",
		report: {
			provider: "google-antigravity",
			limits: [
				{
					id: "google-antigravity:google:default:daily",
					label: "Usage (Google)",
					window: { id: "daily", label: "Daily", durationMs: 86_400_000, resetsAt: 1785023411000 },
					amount: { unit: "percent", remaining: 0, used: 100, limit: 100 },
					status: "exhausted",
				},
				{
					id: "google-antigravity:anthropic:default:daily",
					label: "Usage (Anthropic)",
					window: { id: "daily", label: "Daily", durationMs: 86_400_000, resetsAt: 1785034721000 },
					amount: { unit: "percent", remaining: 100, used: 0, limit: 100 },
					status: "ok",
				},
			],
		},
	} as unknown as CredentialProbe;

	/**
	 * THE REGRESSION. Against the real payload the spent Gemini pool must be found.
	 * The broken version returned null here while passing every other test in this
	 * file, which is why this assertion is the one that matters.
	 */
	it("finds the spent pool in a verbatim live probe", () => {
		expect(exhaustedPoolFor([LIVE_PROBE], "google-antigravity/gemini-3.5-flash")).toEqual({
			pool: "google-antigravity:google:default:daily",
			resetsAt: 1785023411000,
		});
	});

	/** And still lets the untouched Anthropic pool through, on the same live payload. */
	it("lets the healthy vendor through on the same live probe", () => {
		expect(exhaustedPoolFor([LIVE_PROBE], "google-antigravity/claude-sonnet-4-6")).toBeNull();
	});

	/**
	 * A provider with no usage probe reports no `report` at all, which must classify
	 * as "not checked" rather than throwing. Two of the six live credentials are in
	 * exactly that state.
	 */
	it("treats a credential with no usage report as unchecked, not as a failure", () => {
		const noReport = { provider: "opencode-zen", ok: null, reason: "no usage probe configured" } as CredentialProbe;
		expect(exhaustedPoolFor([noReport], "opencode-zen/whatever-gemini")).toBeNull();
	});
});

/**
 * When a spent quota pool stops the run and when it merely warns.
 *
 * This branch exists because the guard, as first written, exited on a spent pool
 * before `--dry-run` was handled. That made config validation impossible during the
 * one period it is most useful: waiting for a refill with a run queued up and
 * wanting to know the arm is wired right before the pool returns. The fix must not
 * drift back, and must not overshoot into letting a real run start against a pool
 * that would fail every trial.
 */
describe("spentQuotaShouldAbort — a dry run reports quota, a real run dies on it", () => {
	const spent = { pool: "google-antigravity:google:default:daily" };

	/** A real run against a spent pool would produce a comparison with missing samples. */
	it("aborts a real run when the pool is spent", () => {
		expect(spentQuotaShouldAbort(spent, false)).toBe(true);
	});

	/** A dry run starts no container, so a spent pool cannot cost anything. */
	it("does not abort a dry run when the pool is spent", () => {
		expect(spentQuotaShouldAbort(spent, true)).toBe(false);
	});

	/** With quota available there is nothing to abort on, in either mode. */
	it("never aborts when the pool has quota left", () => {
		expect(spentQuotaShouldAbort(null, false)).toBe(false);
		expect(spentQuotaShouldAbort(null, true)).toBe(false);
	});
});
