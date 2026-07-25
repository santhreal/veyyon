import { formatBytes, formatPercent } from "@veyyon/utils/format";
import { formatDistanceToNow } from "date-fns";

// Byte counts and percentages render with the shared pi-utils owners (binary units,
// "1.5MB"; one decimal place, "12.3%") so the dashboard matches every other product
// surface. `@veyyon/utils/format` has no imports of its own, which is what makes it safe
// to pull into a browser bundle — the rest of `@veyyon/utils` is not.
//
// `formatPercent` used to be a second implementation right here, with the same name and
// the same one-decimal output, and the two disagreed on one input: this copy rendered
// `NaN%` where the shared owner renders `0.0%`. A rate arriving as 0/0 is not a rare
// case for a dashboard — a project with no requests yet has exactly that error rate —
// and `packages/stats/src/index.ts` already used the shared owner, so the CLI and the
// dashboard printed different things for the same number.
export { formatBytes, formatPercent };

export function formatInteger(value: number): string {
	return value.toLocaleString();
}

export function formatCompact(value: number): string {
	return value.toLocaleString(undefined, { notation: "compact" });
}

export function formatCost(value: number, digits?: number): string {
	if (value === 0) return "$0";
	const fractionDigits = digits !== undefined ? digits : value > 0 && value < 0.01 ? 4 : 2;
	return `$${value.toLocaleString(undefined, {
		minimumFractionDigits: fractionDigits,
		maximumFractionDigits: fractionDigits,
	})}`;
}

export function formatDurationMs(value: number | null, digits?: number): string {
	if (value === null) return "-";
	const sec = value / 1000;
	const d = digits !== undefined ? digits : sec < 1 ? 2 : 1;
	return `${sec.toFixed(d)}s`;
}

export function formatTokensPerSecond(value: number | null): string {
	if (value === null) return "-";
	return value.toFixed(1);
}

export function formatRelativeTime(timestamp: number): string {
	return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
}
