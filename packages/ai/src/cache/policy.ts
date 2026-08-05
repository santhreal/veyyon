/**
 * What to DO when the prompt cache did not work.
 *
 * The verdict in `verdict.ts` is a fact; this is the response to it. Three
 * levels, because the right answer depends on who is watching:
 *
 * - `error` fails the run. A rejected cache is a defect, and a defect that only
 *   logs is a defect nobody fixes: all four of the shipped cache bugs were
 *   logging-visible and still reached users, because the run kept working and
 *   only the bill moved. Failing is what makes the next one impossible to miss.
 * - `warn` reports it and continues. The default, because a false positive that
 *   halts a working session is worse than an unnoticed one that costs money, and
 *   because `unverifiable` genuinely cannot be attributed.
 * - `off` records nothing beyond the verdict itself.
 *
 * WHY THE THROW IS DEFERRED. A rejection is only knowable AFTER the response,
 * when usage arrives, and the money is already spent by then. Throwing at that
 * point would also destroy a completed assistant turn — the user loses work AND
 * the money, which is strictly worse than losing the money alone. So the failure
 * is raised at the START of the next request on the same key instead: the
 * completed turn is kept, and the session stops before paying the same full
 * price twice. `pendingFailure` is that latch.
 */
import { $env } from "@veyyon/utils/env";
import type { CacheEnforcement } from "../types";
import { type CacheVerdict, describeCacheVerdict, isCacheHealthy } from "./verdict";

export type { CacheEnforcement };

/**
 * Resolve the enforcement level, defaulting to reporting rather than failing.
 *
 * `warn` is the default because the cost of the two mistakes is asymmetric. A
 * missed rejection costs money and shows up in the record; a wrong rejection
 * halts a session that was working. The verdict is provable, but it is proven
 * against provider usage reporting, and a provider that changes what it reports
 * would turn `error` into an outage. Hard blocking is therefore opt-in: set
 * `VEYYON_CACHE_ENFORCEMENT=error`, or turn on **Settings → Context → Block On
 * Cache Rejection**.
 *
 * ANTHROPIC ONLY, and that is a gap rather than a design. `providers/anthropic.ts`
 * is the single production importer of this module, so on Bedrock, on OpenAI
 * Responses and on the OpenAI-compatible chat-completions path (OpenRouter
 * Claude) the enforcement level resolves and then governs nothing. Two of the
 * four defects that motivated this subsystem, listed in
 * `test/cache-verdict.test.ts`, happened on providers it does not observe.
 */
export function resolveCacheEnforcement(explicit?: CacheEnforcement): CacheEnforcement {
	if (explicit) return explicit;
	const configured = $env.VEYYON_CACHE_ENFORCEMENT?.trim().toLowerCase();
	if (configured === "off" || configured === "warn" || configured === "error") return configured;
	return "warn";
}

/**
 * Raised when a request's cache markers demonstrably did not take effect.
 *
 * Carries the verdict rather than a formatted string so a caller can report the
 * token counts itself, and names the provider surface, because every one of the
 * shipped defects was specific to one surface while the others were fine.
 */
export class CacheRejectedError extends Error {
	readonly verdict: CacheVerdict;
	readonly provider: string;
	readonly modelId: string;

	constructor(verdict: CacheVerdict, provider: string, modelId: string) {
		super(
			`${provider}/${modelId}: ${describeCacheVerdict(verdict)}. ` +
				`The previous turn paid full input rate for a prompt it asked the provider to cache. ` +
				`Set cache.enforcement to "warn" to continue anyway.`,
		);
		this.name = "CacheRejectedError";
		this.verdict = verdict;
		this.provider = provider;
		this.modelId = modelId;
	}
}

/** A verdict severe enough to fail on, as opposed to merely unhealthy. */
export function isEnforceableFailure(verdict: CacheVerdict): boolean {
	// `rejected` is the only provable one: we asked, it was large enough, the
	// window was open, and the provider reported nothing either way. `degraded`,
	// `invalidated` and `unverifiable` all have innocent explanations (a moving
	// window, an edited transcript, a provider that under-reports), so failing on
	// them would halt working sessions.
	return verdict.kind === "rejected";
}

export interface CacheEnforcementDecision {
	/** Report the verdict to the operator. */
	report: boolean;
	/** Fail the NEXT request on this key; see the deferral note above. */
	failNext: boolean;
}

export function decideCacheEnforcement(verdict: CacheVerdict, enforcement: CacheEnforcement): CacheEnforcementDecision {
	if (enforcement === "off") return { report: false, failNext: false };
	if (isCacheHealthy(verdict)) return { report: false, failNext: false };
	return { report: true, failNext: enforcement === "error" && isEnforceableFailure(verdict) };
}
