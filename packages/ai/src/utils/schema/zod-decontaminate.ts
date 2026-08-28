import { isRecord } from "@veyyon/utils/type-guards";
import type { JsonObject } from "./types";

const VALID_JSON_SCHEMA_TYPES: Record<string, true> = {
	string: true,
	number: true,
	integer: true,
	boolean: true,
	object: true,
	array: true,
	null: true,
};

const ZOD_KINDS: Record<string, true> = {
	string: true,
	number: true,
	int: true,
	boolean: true,
	bigint: true,
	null: true,
	undefined: true,
	void: true,
	any: true,
	unknown: true,
	never: true,
	date: true,
	symbol: true,
	nan: true,
	enum: true,
	literal: true,
	object: true,
	array: true,
	tuple: true,
	record: true,
	map: true,
	set: true,
	union: true,
	discriminatedUnion: true,
	intersection: true,
	lazy: true,
	promise: true,
	function: true,
	file: true,
	custom: true,
	template_literal: true,
	optional: true,
	nullable: true,
	default: true,
	prefault: true,
	catch: true,
	pipe: true,
	transform: true,
	brand: true,
	readonly: true,
	success: true,
	nonoptional: true,
};

const ZOD_SCALAR_TO_JSON_TYPE: Record<string, string> = {
	string: "string",
	number: "number",
	int: "integer",
	boolean: "boolean",
	null: "null",
	bigint: "string",
	date: "string",
	nan: "number",
};

const ZOD_NOISE_KEYS: Record<string, true> = {
	def: true,
	options: true,
	_zod: true,
	checks: true,
};

const KEYS_THAT_ACCEPT_NULL: Record<string, true> = {
	default: true,
	const: true,
	examples: true,
};

function isZodLeak(node: JsonObject): boolean {
	const def = node.def;
	if (!isRecord(def)) return false;
	const defType = def.type;
	if (typeof defType !== "string" || !ZOD_KINDS[defType]) return false;
	return node.type === defType;
}

function inferTypeFromValues(values: readonly unknown[]): string {
	if (values.length === 0) return "string";
	const first = values[0];
	if (typeof first === "number") return Number.isInteger(first) ? "integer" : "number";
	if (typeof first === "boolean") return "boolean";
	if (first === null) return "null";
	return "string";
}

function unwrapInnerSchema(def: JsonObject): unknown {
	return def.innerType ?? def.in ?? def.out ?? def.schema ?? def.element ?? {};
}

function copyWithoutNoise(node: JsonObject): JsonObject {
	const out: JsonObject = {};
	for (const key in node) {
		if (ZOD_NOISE_KEYS[key]) continue;
		const value = node[key];
		if (value === null && !KEYS_THAT_ACCEPT_NULL[key]) continue;
		out[key] = value;
	}
	return out;
}

function rewriteZodNode(node: JsonObject, seen: WeakSet<object>): unknown {
	const def = node.def as JsonObject;
	const kind = def.type as string;

	switch (kind) {
		case "enum": {
			const optionsArray = Array.isArray(node.options) ? (node.options as unknown[]) : null;
			const entries = isRecord(def.entries) ? Object.values(def.entries) : null;
			const enumObj = isRecord(node.enum) ? Object.values(node.enum) : null;
			const values = optionsArray ?? entries ?? enumObj ?? [];
			return { type: inferTypeFromValues(values), enum: values };
		}

		case "literal": {
			const values = Array.isArray(def.values) ? (def.values as unknown[]) : [];
			if (values.length === 1) {
				return { const: values[0] };
			}
			if (values.length > 1) {
				return { type: inferTypeFromValues(values), enum: values };
			}
			return {};
		}

		case "union":
		case "discriminatedUnion": {
			const arms = Array.isArray(def.options)
				? (def.options as unknown[])
				: Array.isArray(node.options)
					? (node.options as unknown[])
					: [];
			return { anyOf: arms.map(x => walk(x, seen)) };
		}

		case "intersection": {
			return {
				allOf: [walk(def.left, seen), walk(def.right, seen)],
			};
		}

		case "array": {
			return { type: "array", items: walk(def.element, seen) };
		}

		case "set": {
			const element = def.valueType ?? def.element;
			return { type: "array", uniqueItems: true, items: walk(element, seen) };
		}

		case "tuple": {
			const items = Array.isArray(def.items) ? (def.items as unknown[]) : [];
			const out: JsonObject = { type: "array", prefixItems: items.map(x => walk(x, seen)) };
			const rest = def.rest;
			if (rest != null) out.items = walk(rest, seen);
			return out;
		}

		case "record":
		case "map": {
			return { type: "object", additionalProperties: walk(def.valueType, seen) };
		}

		case "object": {
			const shape = isRecord(def.shape) ? def.shape : ({} as JsonObject);
			const properties: JsonObject = {};
			const required: string[] = [];
			for (const key in shape) {
				const inner = walk(shape[key], seen);
				properties[key] = inner;
				if (!isOptionalEntry(shape[key])) required.push(key);
			}
			const out: JsonObject = { type: "object", properties };
			if (required.length > 0) out.required = required;
			return out;
		}

		case "nonoptional":
		case "optional":
		case "nullable":
		case "default":
		case "prefault":
		case "catch":
		case "readonly":
		case "brand":
		case "lazy":
		case "pipe":
		case "transform": {
			const inner = walk(unwrapInnerSchema(def), seen);
			if (kind === "nullable" && isRecord(inner)) {
				if (typeof inner.type === "string") {
					return { ...inner, type: [inner.type, "null"] };
				}
				if (Array.isArray(inner.type)) {
					return (inner.type as string[]).includes("null")
						? inner
						: { ...inner, type: (inner.type as string[]).concat(["null"]) };
				}
				return { anyOf: [inner, { type: "null" }] };
			}
			return inner;
		}

		default: {
			const cleaned = copyWithoutNoise(node);
			const mapped = ZOD_SCALAR_TO_JSON_TYPE[kind];
			if (mapped) {
				cleaned.type = mapped;
			} else if (typeof cleaned.type === "string" && !VALID_JSON_SCHEMA_TYPES[cleaned.type]) {
				delete cleaned.type;
			}
			if (cleaned.enum !== undefined && !Array.isArray(cleaned.enum)) {
				delete cleaned.enum;
			}
			return cleaned;
		}
	}
}

function isOptionalEntry(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (!isZodLeak(value)) return false;
	const kind = (value.def as JsonObject).type;
	return kind === "optional" || kind === "default" || kind === "prefault";
}

export function decontaminateZodInstance(value: unknown): unknown {
	return walk(value, new WeakSet());
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
	if (Array.isArray(value)) {
		if (seen.has(value)) return value;
		seen.add(value);
		let changed = false;
		const out = value.map(entry => {
			const rewritten = walk(entry, seen);
			if (rewritten !== entry) changed = true;
			return rewritten;
		});
		return changed ? out : value;
	}
	if (!isRecord(value)) return value;
	if (seen.has(value)) return value;
	seen.add(value);

	if (isZodLeak(value)) {
		const rewritten = rewriteZodNode(value, seen);
		return rewritten === value ? value : walk(rewritten, seen);
	}

	let changed = false;
	const out: JsonObject = {};
	for (const key in value) {
		const child = value[key];
		const rewritten = walk(child, seen);
		if (rewritten !== child) changed = true;
		out[key] = rewritten;
	}
	return changed ? out : value;
}
