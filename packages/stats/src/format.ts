/**
 * Terminal-facing stat formatters shared by the stats package entry and the
 * coding-agent CLI/status-line. The web client's locale-aware `formatCost`
 * (client/data/formatters.ts) is a deliberately different display contract.
 */

/** Tiered fixed-precision dollar display for terminal output. */
export function formatCostTiered(n: number): string {
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

/** Premium-request counts are fractional units; display rounded to 2 decimals. */
export function normalizePremiumRequests(n: number): number {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}
