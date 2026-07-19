export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

export function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

/**
 * Coerce an unknown to a trimmed, non-empty string, or null. Non-strings and
 * blank/whitespace-only strings both count as absent. The returned string is
 * already trimmed, so callers do not trim again.
 */
export function trimmedString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Coerce an unknown to a finite number, or null. Non-numbers and the
 * non-finite values (NaN, Infinity, -Infinity) all count as absent.
 */
export function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Own-property read returning the value only when it is a string. */
export function getStringProperty(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

/** Like getStringProperty, but blank/whitespace-only strings count as absent. */
export function getNonBlankStringProperty(record: Record<string, unknown>, key: string): string | undefined {
	const value = getStringProperty(record, key);
	return value !== undefined && value.trim().length > 0 ? value : undefined;
}
