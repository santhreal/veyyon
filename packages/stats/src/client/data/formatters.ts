import { formatDistanceToNow } from "date-fns";

// Cost/percent/byte display follows the product-wide contract owned by
// @veyyon/pi-utils format.ts so the dashboard and the CLI stats surface render
// the same quantities identically (DEDUP-FMT-CLIENT).
export { formatBytes, formatCost, formatPercent } from "@veyyon/pi-utils/format";

export function formatInteger(value: number): string {
	return value.toLocaleString();
}

export function formatCompact(value: number): string {
	return value.toLocaleString(undefined, { notation: "compact" });
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
