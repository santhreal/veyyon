export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

/** Non-null object check that, unlike {@link isRecord}, lets arrays through. */
export function isNonNullObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Own-property read of `key` on `value` when its value is a string; `undefined` otherwise (including null/undefined receivers). */
export function getStringProperty(value: object | null | undefined, key: string): string | undefined {
	if (!value) return undefined;
	const field = Object.getOwnPropertyDescriptor(value, key)?.value;
	return typeof field === "string" ? field : undefined;
}

/**
 * Own-property read of `key` on `value` when its value is a non-blank string;
 * `undefined` otherwise. Blank/whitespace-only strings are treated as absent so
 * `??` fallback chains skip past them.
 */
export function getNonBlankStringProperty(value: object, key: string): string | undefined {
	const field = getStringProperty(value, key);
	return field !== undefined && field.trim().length > 0 ? field : undefined;
}

/** Own-property read of `key` on `value` when its value is a finite number; `undefined` otherwise. */
export function getFiniteNumberProperty(value: object, key: string): number | undefined {
	const field = Object.getOwnPropertyDescriptor(value, key)?.value;
	return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/** `Error#message` for real errors; `String(value)` otherwise — the message-only read of {@link toError}. */
export function errorMessage(value: unknown): string {
	if (value instanceof Error && value.message) return value.message;
	const text = String(value);
	return text || "Unknown error";
}
