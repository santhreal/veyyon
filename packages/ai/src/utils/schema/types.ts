export type JsonObject = Record<string, unknown>;

/** True when `value` is a plain JSON object with no own enumerable keys. */
export function isJsonObjectEmpty(value: JsonObject): boolean {
	return Object.keys(value).length === 0;
}
