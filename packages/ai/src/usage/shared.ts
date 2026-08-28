import type { UsageStatus } from "../usage";

export const USAGE_WARNING_FRACTION = 0.9;

export function usageStatusFromUsedFraction(usedFraction: number | undefined): UsageStatus {
	if (usedFraction === undefined) return "unknown";
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= USAGE_WARNING_FRACTION) return "warning";
	return "ok";
}
