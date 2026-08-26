/**
 * Deciding, before a single container starts, whether the staged credential
 * store can actually serve a token.
 *
 * WHY THIS EXISTS. The bench copies the operator's `agent.db` into
 * `assets/auth-agent.db` and mounts it into every task container. Nothing
 * checked that the copy still works, so a dead credential was discovered one
 * container at a time: each trial paid full setup, failed to authenticate, and
 * reported a task failure. Worse, the message the agent produced blamed the
 * model id rather than the credential (BACKLOG AUTH-FAILURE-BLAMES-MODEL-ID), so
 * a burned 40-trial run was misdiagnosed as an unservable model and led to an
 * allowlist gate against a model that worked fine.
 *
 * `AuthStorage.checkCredentials` already does the real probe: OAuth
 * refresh-on-expiry followed by the provider's auth-verifying endpoint, per
 * credential, without swallowing errors. This module is the decision made from
 * its results, kept pure so the reasoning is testable without a network or a
 * SQLite file.
 *
 * The three outcomes are deliberately distinct, because collapsing them is how
 * the original failure stayed invisible. "No credential works" and "no credential
 * could be checked" are not the same claim, and neither may be reported as
 * success.
 */

/**
 * One usage pool a provider meters separately, as reported by its usage probe.
 *
 * The nesting is the provider's, not a choice made here, and it is spelled out
 * because getting it wrong is silent. A first version of this read `limit.resetsAt`
 * and `probe.limits`, which type-checked against hand-written fixtures and matched
 * NOTHING on real data, so the check quietly never fired. The shapes below are
 * copied from a live `checkCredentials()` result.
 */
export interface CredentialLimit {
	/** Provider-scoped pool id, e.g. `google-antigravity:google:default:daily`. */
	readonly id: string;
	/** `exhausted` means this pool is spent; anything else is usable. */
	readonly status?: string;
	/** The metering window, whose `resetsAt` is epoch milliseconds. */
	readonly window?: { readonly resetsAt?: number };
}

/** The subset of `CredentialHealthResult` this decision reads. */
export interface CredentialProbe {
	readonly provider: string;
	/** `true` served a token, `false` failed, `null` no probe is configured. */
	readonly ok: boolean | null;
	/** Why it failed; present when `ok === false`. */
	readonly reason?: string;
	/** OAuth identity, used only to make the operator's message specific. */
	readonly email?: string;
	/** The usage probe's result. Absent when the provider has no usage probe. */
	readonly report?: { readonly limits?: readonly CredentialLimit[] };
}

export type AuthPreflightVerdict =
	/** At least one credential served a token. Proceed. */
	| { readonly kind: "ok"; readonly usable: number }
	/** The staged store holds no credentials at all. Fatal. */
	| { readonly kind: "empty" }
	/** Every credential that could be probed failed. Fatal. */
	| { readonly kind: "dead"; readonly failures: readonly { provider: string; reason: string }[] }
	/** No credential could be probed either way. Report loudly, then proceed. */
	| { readonly kind: "unverifiable"; readonly providers: readonly string[] };

/**
 * Read a set of credential probes into one verdict.
 *
 * A single working credential is enough: the bench needs one usable token, and
 * an operator with several accounts routinely has stale rows alongside a live
 * one. Requiring all of them to pass would block runs that can succeed.
 *
 * `unverifiable` exists so an unprobeable provider is never silently treated as
 * healthy. It is the one outcome that proceeds despite proving nothing, and it
 * has to say so out loud: a quiet pass here would recreate exactly the failure
 * this module was written to catch.
 */
export function decideAuthPreflight(probes: readonly CredentialProbe[]): AuthPreflightVerdict {
	if (probes.length === 0) return { kind: "empty" };

	const usable = probes.filter(probe => probe.ok === true).length;
	if (usable > 0) return { kind: "ok", usable };

	const failures = probes
		.filter(probe => probe.ok === false)
		.map(probe => ({
			provider: probe.email ? `${probe.provider} (${probe.email})` : probe.provider,
			reason: probe.reason ?? "no reason reported",
		}));
	if (failures.length > 0) return { kind: "dead", failures };

	return { kind: "unverifiable", providers: [...new Set(probes.map(probe => probe.provider))] };
}

/**
 * The vendor whose pool a model draws from, inferred from the model id.
 *
 * A gateway provider meters each upstream vendor SEPARATELY. On
 * `google-antigravity` there are three daily pools, `:google:`, `:openai:` and
 * `:anthropic:`, and they empty independently: the Gemini pool can be spent to
 * the last token while the other two sit untouched at 100%. So "the credential
 * serves a token" is true and useless. The question that matters is whether the
 * pool THIS model draws from has anything left.
 *
 * The table is explicit rather than clever, and unknown ids return null instead
 * of a guess. A wrong guess here refuses a run that could have succeeded, which
 * is worse than not checking, so the caller treats null as "could not check" and
 * says so rather than proceeding quietly (Law 10).
 */
export function modelVendor(modelId: string): string | null {
	const id = modelId.toLowerCase();
	if (id.includes("gemini")) return "google";
	if (id.includes("claude")) return "anthropic";
	if (id.includes("gpt") || id.includes("codex") || /\bo[134]\b/.test(id)) return "openai";
	return null;
}

/**
 * Whether the pool the requested model draws from is already spent, and when it
 * refills.
 *
 * WHY THIS IS A SEPARATE CHECK. The token probe above passes whenever ANY
 * credential authenticates, which stays true after a pool empties. Run
 * `2026-07-25T20-46-08-607Z` started on a healthy preflight, scored ten trials,
 * then hit `RESOURCE_EXHAUSTED` and produced twenty-six consecutive zero-token
 * trials. The mid-run abort in `run.ts` catches that case now, but catching it at
 * the START is strictly better: it costs nothing instead of an hour of container
 * setup, and it cannot produce a half-finished run whose missing samples read as
 * data.
 *
 * Matching is by vendor segment inside the pool id, so a provider that reports a
 * single unsegmented pool still matches when its id names the vendor. Returns
 * null when nothing matched, which means "not checked" and never "fine".
 */
export function exhaustedPoolFor(
	probes: readonly CredentialProbe[],
	modelId: string,
): { pool: string; resetsAt?: number } | null {
	const provider = modelId.includes("/") ? (modelId.split("/")[0] as string) : null;
	const vendor = modelVendor(modelId);
	if (!vendor) return null;
	for (const probe of probes) {
		if (provider && probe.provider !== provider) continue;
		for (const limit of probe.report?.limits ?? []) {
			if (limit.status !== "exhausted") continue;
			if (!limit.id.toLowerCase().includes(vendor)) continue;
			const resetsAt = limit.window?.resetsAt;
			return { pool: limit.id, ...(resetsAt !== undefined && { resetsAt }) };
		}
	}
	return null;
}

/**
 * The operator-facing sentence for a spent pool, naming the pool and when it
 * refills.
 *
 * The reset time is the only actionable part. An operator told merely that quota
 * ran out reruns immediately and hits the same wall; one told the refill time
 * either waits or switches models, and the message names both ways out.
 */
export function describeExhaustedPool(pool: { pool: string; resetsAt?: number }, modelId: string): string {
	const when = pool.resetsAt ? ` It refills at ${new Date(pool.resetsAt).toISOString()}.` : "";
	return (
		`the quota pool "${pool.pool}" that "${modelId}" draws from is already spent.${when}\n` +
		"Every trial would fail with RESOURCE_EXHAUSTED and produce no tokens, leaving a run whose " +
		"missing samples look like data. Wait for the refill, or pass --model for a vendor with quota " +
		"left: a gateway provider meters each upstream vendor separately, so the others may be untouched. " +
		"This is a quota problem. The model id and the arm allowlists are not at fault."
	);
}

/**
 * The operator-facing sentence for a verdict that stops the run.
 *
 * Deliberately never names the model id. The whole point of the preflight is
 * that the previous failure path blamed `--model` for a credential problem and
 * sent a real investigation down the wrong road for a day.
 */
export function describeAuthPreflightFailure(verdict: AuthPreflightVerdict, stagedPath: string): string {
	switch (verdict.kind) {
		case "empty":
			return (
				`the staged auth DB holds no credentials: ${stagedPath}\n` +
				"re-seed it by logging in (vey, then /login), which writes ~/.veyyon/shared-auth/agent.db"
			);
		case "dead": {
			const lines = verdict.failures.map(failure => `  ${failure.provider}: ${failure.reason}`).join("\n");
			return (
				`the staged auth DB cannot serve a token: ${stagedPath}\n${lines}\n` +
				"re-seed it by logging in again (vey, then /login). This is a credential problem. " +
				"The model id and the arm allowlists are not at fault; do not change them."
			);
		}
		default:
			// `ok` and `unverifiable` both proceed, so neither has a failure message.
			// Returning "" rather than throwing keeps the caller's branch simple.
			return "";
	}
}

/**
 * Whether a spent quota pool should stop the run, or only be reported.
 *
 * A REAL RUN MUST STOP. Every trial would fail with `RESOURCE_EXHAUSTED` and
 * produce no tokens, and a run whose samples are missing reads as data rather than
 * as an outage, which is the confusion the check exists to prevent.
 *
 * A DRY RUN MUST NOT. `--dry-run` answers "is my arm wired correctly" without
 * paying for a container, and the moment that answer is most wanted is while
 * waiting for a spent pool to refill so the real run can start the instant it does.
 * Exiting made the flag unusable in exactly that window: the one time validation is
 * free, it refused to run. Quota is a property of the model rather than of the
 * configuration, so it belongs with what a dry run cannot check, not with the
 * guards it exists to apply. It is still printed either way.
 */
export function spentQuotaShouldAbort(spent: { pool: string } | null, dryRun: boolean): boolean {
	if (spent === null) return false;
	return !dryRun;
}
