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
