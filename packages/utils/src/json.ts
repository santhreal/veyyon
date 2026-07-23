import { errorMessage } from "./type-guards";

/**
 * Try to parse JSON, returning null on failure.
 */
export function tryParseJson<T = unknown>(content: string): T | null {
	try {
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

/**
 * Serialize JSON while preserving bigint precision as decimal strings.
 *
 * Tool arguments normally arrive from JSON providers, but extension hooks and
 * host integrations can supply JavaScript bigint values. Native
 * `JSON.stringify` throws for those values, which makes otherwise valid agent
 * history impossible to persist, replay, or compact. A decimal string is the
 * only lossless JSON representation.
 *
 * This is the PERSISTENCE path: it stays lossless, and it still returns
 * `undefined` (or throws on a cycle) rather than inventing a rendering, because
 * a replayed value must be the value. For DISPLAY, where readability matters
 * more than round-tripping, use {@link stringifyJsonSafe}.
 */
export function stringifyJson(value: unknown, space?: string | number): string | undefined {
	return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), space);
}

/**
 * A replacer that renders in place the values `JSON.stringify` refuses.
 *
 * The kinds it throws on (cycles, bigint) or drops silently (functions,
 * symbols) are ordinary in real data: a DOM node has parent links, an id from
 * an API is often a bigint, and anything read off a live object tends to carry
 * methods. Marking each one where it sits keeps the rest of the object
 * readable, which is the whole point of rendering it.
 */
function displayReplacer(): (this: unknown, key: string, value: unknown) => unknown {
	// The chain of objects from the root down to whatever is being visited. A
	// value is only circular if it is one of its OWN ancestors, so a plain "have
	// I seen this before" set would be wrong: `{a: shared, b: shared}` is not a
	// cycle, and marking its second branch "[Circular]" would hide a whole branch
	// of real data. `this` is the holder of the current key, which is what lets
	// the stack unwind on the way back up.
	const ancestors: object[] = [];
	return function replace(this: unknown, _key: string, value: unknown): unknown {
		if (typeof value === "bigint") return `${value}n`;
		if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
		if (typeof value === "symbol") return value.toString();
		if (typeof value === "object" && value !== null) {
			while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
			// A cycle is named rather than thrown on, so the object still renders and
			// the reader can see exactly where it looped back.
			if (ancestors.includes(value)) return "[Circular]";
			ancestors.push(value);
		}
		return value;
	};
}

/** A short type name for a value that could not be rendered, used in the marker below. */
function describeType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value !== "object") return typeof value;
	const name = (value as object).constructor?.name;
	return name && name !== "Object" ? name : "object";
}

/**
 * Render any value as JSON for display, without ever throwing and without ever
 * lying about what it rendered.
 *
 * This is the one owner of a pattern that had been hand-rolled in five places,
 * every copy ending in `String(value)`. That fallback turns any object it could
 * not serialize into the literal text `[object Object]`, which reaches the
 * reader as the value itself with nothing to say serialization failed. It is
 * indistinguishable from an object that genuinely has no contents, so it sends
 * people after their own data instead of the real cause (Law 10).
 *
 * Cycles, bigint, functions and symbols are rendered in place. A value that
 * still cannot be written comes back as `[unserializable <type>: <reason>]`,
 * which is visibly a failure rather than a plausible-looking result.
 */
export function stringifyJsonSafe(value: unknown, space?: string | number): string {
	try {
		const text = JSON.stringify(value, displayReplacer(), space);
		// `stringify` returns undefined for a bare function or symbol at the top
		// level, which would otherwise reach the reader as the text "undefined".
		if (text !== undefined) return text;
	} catch (error) {
		return `[unserializable ${describeType(value)}: ${errorMessage(error)}]`;
	}
	return `[unserializable ${describeType(value)}]`;
}
