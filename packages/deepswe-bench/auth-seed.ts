/**
 * Choosing which credential store to stage into every task container.
 *
 * The runner copies the operator's `agent.db` into `assets/auth-agent.db`, which
 * is bind-mounted into all N task containers. Getting that copy wrong does not
 * fail loudly: the agent starts, cannot authenticate, and the run reports N task
 * failures that look like model or harness problems. Both ways of getting it
 * wrong had bitten real runs, so the decision lives here as a pure function with
 * its own tests rather than inline in `run.ts` where nothing could reach it.
 *
 * The two failure modes:
 *
 *   1. PICKING A PRE-MOVE STORE. Logins used to live under
 *      `profiles/<name>/shared-auth`; they now live in the machine-wide
 *      `~/.veyyon/shared-auth` (`getSharedAuthDir`). The old files commonly
 *      survive as stale leftovers, so a candidate list that tried them first
 *      staged credentials that expired long ago while a live store sat unread.
 *
 *   2. FREEZING ONE SNAPSHOT. The staged copy was written once and then reused
 *      forever if the file merely existed. OAuth access tokens rotate, so from
 *      the first refresh onward every container received a token the provider
 *      had already retired.
 */

/** What the runner should do about `assets/auth-agent.db`, and why. */
export type AuthSeedDecision =
	/** No candidate store exists. The run cannot authenticate; fail before launching containers. */
	| { readonly kind: "missing" }
	/** No staged copy yet: copy `source`. */
	| { readonly kind: "seed"; readonly source: string; readonly legacy: boolean }
	/** The staged copy predates `source`, so it may hold a rotated-out token: copy again. */
	| { readonly kind: "reseed"; readonly source: string; readonly legacy: boolean }
	/** The staged copy is at least as new as `source`: leave it alone. */
	| { readonly kind: "current"; readonly source: string; readonly legacy: boolean };

/**
 * Pick a store and decide whether the staged copy needs rewriting.
 *
 * `sources` is ordered most-canonical first; the first that exists wins, and
 * `legacy` is true whenever that is not the first entry, so the caller can say so
 * out loud instead of silently running on pre-move credentials.
 *
 * `mtimeOf` returns undefined for a path that does not exist, which is how both
 * "no store at all" and "nothing staged yet" are expressed.
 *
 * Ties re-use the staged copy. Equal mtimes mean the file has not been touched
 * since it was staged, and copying on equality would rewrite the asset on every
 * run for no change.
 */
export function decideAuthSeed(
	sources: readonly string[],
	stagedPath: string,
	mtimeOf: (p: string) => number | undefined,
): AuthSeedDecision {
	let source: string | undefined;
	let legacy = false;
	for (let i = 0; i < sources.length; i++) {
		const candidate = sources[i] as string;
		if (mtimeOf(candidate) !== undefined) {
			source = candidate;
			legacy = i > 0;
			break;
		}
	}
	if (source === undefined) return { kind: "missing" };

	const stagedMtime = mtimeOf(stagedPath);
	if (stagedMtime === undefined) return { kind: "seed", source, legacy };
	// `source` exists, so its mtime is defined; the ?? 0 keeps the types honest
	// without inventing a branch that cannot happen.
	return (mtimeOf(source) ?? 0) > stagedMtime
		? { kind: "reseed", source, legacy }
		: { kind: "current", source, legacy };
}
