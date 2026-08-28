let configuredLimits: Record<string, number> = {};

export function configureProviderMaxInFlightRequests(limits: Record<string, number> | undefined): void {
	configuredLimits = limits ?? {};
}

export function resolveProviderInFlightLimit(
	provider: string,
	perCallLimits?: Record<string, number>,
): number | undefined {
	const limits = perCallLimits ?? configuredLimits;
	const value = limits[provider];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.max(1, Math.floor(value));
}
