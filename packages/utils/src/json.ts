import { errorMessage } from "./type-guards";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function tryParseJson<T = unknown>(content: string): T | null {
	try {
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

export function stringifyJson(value: unknown, space?: string | number): string | undefined {
	return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), space);
}

function displayReplacer(): (this: unknown, key: string, value: unknown) => unknown {
	const ancestors: object[] = [];
	return function replace(this: unknown, _key: string, value: unknown): unknown {
		if (typeof value === "bigint") return `${value}n`;
		if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
		if (typeof value === "symbol") return value.toString();
		if (typeof value === "object" && value !== null) {
			while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
			if (ancestors.includes(value)) return "[Circular]";
			ancestors.push(value);
		}
		return value;
	};
}

function describeType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value !== "object") return typeof value;
	const name = (value as object).constructor?.name;
	return name && name !== "Object" ? name : "object";
}

export function stringifyJsonSafe(value: unknown, space?: string | number): string {
	try {
		const text = JSON.stringify(value, displayReplacer(), space);
		if (text !== undefined) return text;
	} catch (error) {
		return `[unserializable ${describeType(value)}: ${errorMessage(error)}]`;
	}
	return `[unserializable ${describeType(value)}]`;
}

function isPlainObject(val: object): val is Record<string, unknown> {
	return Object.getPrototypeOf(val) === Object.prototype || Array.isArray(val);
}

export function structuredCloneJSON<T>(value: T): T {
	if (!value || typeof value !== "object") {
		return value;
	}

	if (isPlainObject(value)) {
		try {
			return structuredClone(value);
		} catch {}
	}
	return JSON.parse(JSON.stringify(value)) as T;
}
