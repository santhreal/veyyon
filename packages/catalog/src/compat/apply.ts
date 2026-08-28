export function applyCompatOverrides(compat: object, overrides: object | undefined): void {
	if (!overrides) return;
	for (const key of Object.keys(overrides)) {
		const value = (overrides as Record<string, unknown>)[key];
		if (value !== undefined && Object.hasOwn(compat, key)) {
			(compat as Record<string, unknown>)[key] = value;
		}
	}
}
