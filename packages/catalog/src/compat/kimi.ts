/**
 * Kimi K2.7 Code family (including the -highspeed variant); native-only host
 * gating is the caller's responsibility. The ONE owner of the family id
 * pattern, shared by the compat tables and provider-model clamps.
 */
const KIMI_K27_CODE_MODEL_PATTERN = /(?:^|\/)kimi[-._]?k2(?:[._-]?|p)7[-._]?code(?:[-._]?highspeed)?$/i;

export function isKimiK27CodeModelId(modelId: string): boolean {
	return KIMI_K27_CODE_MODEL_PATTERN.test(modelId);
}

export function matchesKimiK27CodeFamily(spec: { id: string; name?: string }): boolean {
	if (isKimiK27CodeModelId(spec.id)) return true;
	return spec.id === "kimi-for-coding" && /k2\.?7 code/i.test(spec.name ?? "");
}
