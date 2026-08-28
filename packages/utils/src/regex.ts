export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ALNUM_CLASS = "\\p{L}\\p{N}";

export const ALNUM_RE = new RegExp(`[${ALNUM_CLASS}]`, "u");

export function hasAlphanumeric(value: string): boolean {
	return ALNUM_RE.test(value);
}

export const NON_ALNUM_RUN_RE = new RegExp(`[^${ALNUM_CLASS}]+`, "gu");

export const ALNUM_WORD_RE = new RegExp(`[${ALNUM_CLASS}]+`, "gu");

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
	return UUID_RE.test(value);
}

export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(value: string): boolean {
	return DATE_ONLY_RE.test(value);
}
