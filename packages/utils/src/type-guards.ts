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

/**
 * Object keys that a plain `obj[key] = value` assignment does NOT store as a
 * normal own property. `__proto__` routes through `Object.prototype`'s accessor:
 * an object value REPLACES the object's prototype (the entry vanishes and the
 * value's fields leak in as phantom inherited members) and a string value is
 * dropped entirely. `constructor`/`prototype` are included so a caller-supplied
 * key can never shadow those built-ins either. These are exactly the keys
 * `JSON.parse` stores as safe own data properties rather than routing through
 * the prototype setter.
 */
export const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Assign `value` onto `target` under a dynamic, possibly-untrusted `key`, storing
 * it as a normal own, enumerable property even when `key` is one of
 * {@link UNSAFE_OBJECT_KEYS}. For those keys it uses `Object.defineProperty` so
 * the value lands as an own data property under the literal name (byte-identical
 * to how `JSON.parse` represents the same key) instead of hitting the prototype
 * setter. Ordinary keys take the plain fast path, so this adds only a set
 * membership test. Use this anywhere a record is built from external key strings.
 */
export function setSafeProperty(target: Record<string, unknown>, key: string, value: unknown): void {
	if (UNSAFE_OBJECT_KEYS.has(key)) {
		Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
		return;
	}
	target[key] = value;
}

/**
 * Read the OWN value stored under `key`, or `undefined` when there is none. A
 * bare `target[key]` read for `key === "__proto__"` returns the inherited
 * `Object.prototype` (never the caller's intent) even before anything is stored;
 * this returns only what {@link setSafeProperty} actually wrote, or `undefined`.
 */
export function getOwnProperty(target: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(target, key) ? target[key] : undefined;
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
