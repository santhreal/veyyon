import { formatNumber } from "@veyyon/utils";

export const PLAN_KEEP_CONTEXT_OPTION_INDEX = 2;
export const PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT = 80;

export function formatContextTokenCount(value: number): string {
	return formatNumber(Math.max(0, Math.round(value))).toLowerCase();
}
