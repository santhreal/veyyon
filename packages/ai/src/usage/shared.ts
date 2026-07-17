import type { UsageStatus } from "../usage";

// The ONE owner of the usage status thresholds: >=90% used warns, >=100%
// exhausts. The remaining-fraction variant is the exact mirror, kept side by
// side so the boundary comparisons stay explicit instead of float-derived.
export function usageStatusFromUsedFraction(usedFraction: number | undefined): UsageStatus {
	if (usedFraction === undefined) return "unknown";
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

export function usageStatusFromRemainingFraction(remainingFraction: number | undefined): UsageStatus {
	if (remainingFraction === undefined) return "unknown";
	if (remainingFraction <= 0) return "exhausted";
	if (remainingFraction <= 0.1) return "warning";
	return "ok";
}

/**
 * Return the OAuth access token to use for a usage probe, or undefined to
 * short-circuit. AuthStorage is the sole refresh authority; an expired or
 * non-OAuth credential skips the probe rather than sending a stale token.
 */
export function resolveOAuthAccessToken(params: { credential: UsageProbeCredential }): string | undefined {
	const { credential } = params;
	if (credential.type !== "oauth") return undefined;
	if (!credential.accessToken) return undefined;
	if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
		return undefined;
	}
	return credential.accessToken;
}

interface UsageProbeCredential {
	type: string;
	accessToken?: string;
	expiresAt?: number;
}
