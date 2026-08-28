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
	if (!(value instanceof Error)) return String(value);
	return value.message || value.name;
}

export function trimmedString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function setSafeProperty(target: Record<string, unknown>, key: string, value: unknown): void {
	if (UNSAFE_OBJECT_KEYS.has(key)) {
		Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
		return;
	}
	target[key] = value;
}

export function getOwnProperty(target: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(target, key) ? target[key] : undefined;
}

export function getStringProperty(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

export function getNonBlankStringProperty(record: Record<string, unknown>, key: string): string | undefined {
	const value = getStringProperty(record, key);
	return value !== undefined && value.trim().length > 0 ? value : undefined;
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		value != null &&
		(typeof value === "object" || typeof value === "function") &&
		typeof (value as { then?: unknown }).then === "function"
	);
}
