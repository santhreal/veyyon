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

/** The subset of `CredentialHealthResult` this decision reads. */
export interface CredentialProbe {
	readonly provider: string;
	/** `true` served a token, `false` failed, `null` no probe is configured. */
	readonly ok: boolean | null;
	/** Why it failed; present when `ok === false`. */
	readonly reason?: string;
	/** OAuth identity, used only to make the operator's message specific. */
	readonly email?: string;
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
