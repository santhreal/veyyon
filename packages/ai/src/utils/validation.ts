import { structuredCloneJSON } from "@veyyon/utils/json";
import { isRecord } from "@veyyon/utils/type-guards";
import type { Type } from "arktype";
import type { ZodType } from "zod/v4";
import type { $ZodIssue as ZodIssue } from "zod/v4/core";
import { ARG_KEY_CLOSE, ARG_KEY_OPEN, ARG_VALUE_CLOSE, ARG_VALUE_OPEN, TOOL_CALL_CLOSE } from "../dialect/wire-tags";
import * as AIError from "../error";
import type { Tool, ToolCall } from "../types";
import { upgradeJsonSchemaTo202012 } from "./schema/draft";
import {
	isJsonSchemaValueValid,
	type JsonSchemaValidationIssue,
	validateJsonSchemaValue,
} from "./schema/json-schema-validator";
import { stamp } from "./schema/stamps";
import { arkToWireSchema, isArkErrors, isArkSchema, isZodSchema, zodToWireSchema } from "./schema/wire";

const JSON_NUMBER_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const NUMERIC_STRING_PATTERN = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function matchesExpectedType(value: unknown, expectedTypes: string[]): boolean {
	return expectedTypes.some(type => {
		switch (type) {
			case "string":
				return typeof value === "string";
			case "number":
				return typeof value === "number" && Number.isFinite(value);
			case "integer":
				return typeof value === "number" && Number.isInteger(value);
			case "boolean":
				return typeof value === "boolean";
			case "null":
				return value === null;
			case "array":
				return Array.isArray(value);
			case "object":
				return isRecord(value);
			default:
				return false;
		}
	});
}

function tryParseNumberString(value: string, expectedTypes: string[]): { value: unknown; changed: boolean } {
	if (!expectedTypes.includes("number") && !expectedTypes.includes("integer")) {
		return { value, changed: false };
	}

	const trimmed = value.trim();
	if (!trimmed || !NUMERIC_STRING_PATTERN.test(trimmed)) {
		return { value, changed: false };
	}

	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) {
		return { value, changed: false };
	}

	if (!matchesExpectedType(parsed, expectedTypes)) {
		return { value, changed: false };
	}

	return { value: parsed, changed: true };
}

function tryCoerceBoolean(value: unknown, expectedTypes: string[]): { value: unknown; changed: boolean } {
	if (!expectedTypes.includes("boolean")) {
		return { value, changed: false };
	}

	if (typeof value === "number") {
		if (value === 0) return { value: false, changed: true };
		if (value === 1) return { value: true, changed: true };
		return { value, changed: false };
	}

	if (typeof value !== "string") {
		return { value, changed: false };
	}

	switch (value.trim().toLowerCase()) {
		case "true":
		case "1":
		case "yes":
		case "on":
			return { value: true, changed: true };
		case "false":
		case "0":
		case "no":
		case "off":
			return { value: false, changed: true };
		default:
			return { value, changed: false };
	}
}

function tryCoerceBooleanToNumber(value: unknown, expectedTypes: string[]): { value: unknown; changed: boolean } {
	if (!expectedTypes.includes("number") && !expectedTypes.includes("integer")) {
		return { value, changed: false };
	}
	if (typeof value !== "boolean") {
		return { value, changed: false };
	}
	return { value: value ? 1 : 0, changed: true };
}

function tryCoerceString(value: unknown, expectedTypes: string[]): { value: unknown; changed: boolean } {
	if (!expectedTypes.includes("string") || typeof value === "string" || value === null || value === undefined) {
		return { value, changed: false };
	}

	if (Array.isArray(value) || typeof value === "object") {
		try {
			const stringified = JSON.stringify(value);
			if (stringified === undefined) return { value, changed: false };
			return { value: stringified, changed: true };
		} catch {
			return { value, changed: false };
		}
	}

	if (typeof value === "function") {
		return { value, changed: false };
	}

	if (typeof value === "boolean") {
		return { value, changed: false };
	}

	return { value: String(value), changed: true };
}

function tryCoerceForExpectedTypes(value: unknown, expectedTypes: string[]): { value: unknown; changed: boolean } {
	if (typeof value === "string") {
		const parsed = tryParseJsonForTypes(value, expectedTypes);
		if (parsed.changed) return parsed;
		return tryCoerceBoolean(value, expectedTypes);
	}

	const booleanCoercion = tryCoerceBoolean(value, expectedTypes);
	if (booleanCoercion.changed) return booleanCoercion;

	const numericCoercion = tryCoerceBooleanToNumber(value, expectedTypes);
	if (numericCoercion.changed) return numericCoercion;

	return tryCoerceString(value, expectedTypes);
}

function tryParseLeadingJsonContainer(value: string): unknown | undefined {
	const firstChar = value[0];
	const closingChar = firstChar === "{" ? "}" : firstChar === "[" ? "]" : undefined;
	if (!closingChar) return undefined;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') inString = false;
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === firstChar) {
			depth += 1;
			continue;
		}

		if (char !== closingChar) continue;
		depth -= 1;
		if (depth !== 0) continue;

		const prefix = value.slice(0, index + 1);
		try {
			return JSON.parse(prefix) as unknown;
		} catch {
			const cleaned = cleanLiteralEscapes(prefix);
			if (cleaned !== prefix) {
				try {
					return JSON.parse(cleaned) as unknown;
				} catch {}
			}
			const escapedControls = escapeRawControlsInJsonStrings(prefix);
			if (escapedControls !== prefix) {
				try {
					return JSON.parse(escapedControls) as unknown;
				} catch {}
			}
			return tryHealMalformedJson(prefix);
		}
	}

	return undefined;
}

function cleanLiteralEscapes(value: string): string {
	let result = "";
	let inString = false;
	let i = 0;
	while (i < value.length) {
		const ch = value[i];
		if (inString) {
			if (ch === "\\" && i + 1 < value.length) {
				result += ch + value[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			result += ch;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inString = true;
			result += ch;
			i += 1;
			continue;
		}
		if (ch === "\\" && i + 1 < value.length) {
			const next = value[i + 1];
			if (next === "n" || next === "t" || next === "r") {
				result += " ";
				i += 2;
				continue;
			}
		}
		result += ch;
		i += 1;
	}
	return result;
}

function escapeRawControlsInJsonStrings(value: string): string {
	let result = "";
	let inString = false;
	let escaped = false;
	let changed = false;
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		if (inString) {
			if (escaped) {
				result += ch;
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				result += ch;
				escaped = true;
				continue;
			}
			if (ch === '"') {
				result += ch;
				inString = false;
				continue;
			}
			const code = ch.charCodeAt(0);
			if (code < 0x20) {
				changed = true;
				switch (ch) {
					case "\n":
						result += "\\n";
						break;
					case "\r":
						result += "\\r";
						break;
					case "\t":
						result += "\\t";
						break;
					case "\b":
						result += "\\b";
						break;
					case "\f":
						result += "\\f";
						break;
					default:
						result += `\\u${code.toString(16).padStart(4, "0")}`;
				}
				continue;
			}
			result += ch;
			continue;
		}
		if (ch === '"') {
			inString = true;
		}
		result += ch;
	}
	return changed ? result : value;
}

const MAX_HEAL_DISTANCE = 3;
const BRACKET_CHARS = ["[", "]", "{", "}"] as const;

function tryHealMalformedJson(value: string): unknown | undefined {
	try {
		return JSON.parse(value) as unknown;
	} catch {}

	const tailStart = Math.max(0, value.length - (MAX_HEAL_DISTANCE * 2 + 1));

	for (let i = tailStart; i < value.length; i += 1) {
		const candidate = value.slice(0, i) + value.slice(i + 1);
		try {
			return JSON.parse(candidate) as unknown;
		} catch {}
	}

	for (let i = tailStart; i < value.length; i += 1) {
		const original = value[i];
		for (const replacement of BRACKET_CHARS) {
			if (replacement === original) continue;
			const candidate = value.slice(0, i) + replacement + value.slice(i + 1);
			try {
				return JSON.parse(candidate) as unknown;
			} catch {}
		}
	}

	return undefined;
}

const MAX_NESTED_JSON_STRING_PARSE_DEPTH = 3;

function acceptParsedJsonForTypes(
	parsed: unknown,
	source: string,
	expectedTypes: string[],
	depth: number,
): { value: unknown; changed: boolean } {
	if (parsed === null && source.trim() === "null") {
		return { value: null, changed: true };
	}
	if (matchesExpectedType(parsed, expectedTypes)) {
		return { value: parsed, changed: true };
	}
	if (typeof parsed === "string" && !expectedTypes.includes("string") && depth < MAX_NESTED_JSON_STRING_PARSE_DEPTH) {
		return tryParseJsonForTypes(parsed, expectedTypes, depth + 1);
	}
	return { value: source, changed: false };
}

function looksLikeJsonContainerString(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const trimmed = value.trimStart();
	if (trimmed.startsWith("{")) {
		const body = trimmed.slice(1);
		return body.trimStart().startsWith('"') || body.includes(":") || body.trimStart().startsWith("}");
	}
	if (!trimmed.startsWith("[")) return false;
	const firstItem = trimmed.slice(1).trimStart();
	return (
		firstItem.startsWith("{") ||
		firstItem.startsWith("[") ||
		firstItem.startsWith('"') ||
		firstItem.startsWith("]") ||
		firstItem.startsWith("true") ||
		firstItem.startsWith("false") ||
		firstItem.startsWith("null") ||
		/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?:\s*(?:,|\]|$))/.test(firstItem)
	);
}

function tryParseJsonForTypes(value: string, expectedTypes: string[], depth = 0): { value: unknown; changed: boolean } {
	const trimmed = value.trim();
	if (!trimmed) return { value, changed: false };

	const numberCoercion = tryParseNumberString(trimmed, expectedTypes);
	if (numberCoercion.changed) {
		return numberCoercion;
	}

	const looksJsonObject = trimmed.startsWith("{") && looksLikeJsonContainerString(trimmed);
	const looksJsonArray = trimmed.startsWith("[") && looksLikeJsonContainerString(trimmed);
	const looksJsonString = trimmed.startsWith('"') && !expectedTypes.includes("string");
	const looksJsonLiteral =
		trimmed === "true" || trimmed === "false" || trimmed === "null" || JSON_NUMBER_PATTERN.test(trimmed);

	if (!looksJsonObject && !looksJsonArray && !looksJsonString && !looksJsonLiteral) {
		return { value, changed: false };
	}

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		const accepted = acceptParsedJsonForTypes(parsed, trimmed, expectedTypes, depth);
		if (accepted.changed) return accepted;
	} catch {
		if (looksJsonObject || looksJsonArray) {
			const escapedControls = escapeRawControlsInJsonStrings(trimmed);
			if (escapedControls !== trimmed) {
				try {
					const parsed = JSON.parse(escapedControls) as unknown;
					const accepted = acceptParsedJsonForTypes(parsed, escapedControls, expectedTypes, depth);
					if (accepted.changed) return accepted;
				} catch {}
			}
			const leading = tryParseLeadingJsonContainer(trimmed);
			if (leading !== undefined) {
				const accepted = acceptParsedJsonForTypes(leading, trimmed, expectedTypes, depth);
				if (accepted.changed) return accepted;
			}
			const healed = tryHealMalformedJson(trimmed);
			if (healed !== undefined) {
				const accepted = acceptParsedJsonForTypes(healed, trimmed, expectedTypes, depth);
				if (accepted.changed) return accepted;
			}
		}
		return { value, changed: false };
	}

	return { value, changed: false };
}

function pathToPointer(path: ReadonlyArray<PropertyKey>): string {
	if (path.length === 0) return "";
	return `/${path.map(seg => String(seg).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function decodeJsonPointer(pointer: string): string[] {
	return pointer
		.split("/")
		.slice(1) // Remove leading empty segment from initial "/"
		.map(segment => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function getValueAtPointer(root: unknown, pointer: string): unknown {
	const segments = decodeJsonPointer(pointer);
	let current: unknown = root;

	for (const segment of segments) {
		if (current === null || current === undefined) return undefined;
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index)) return undefined;
			current = current[index];
			continue;
		}
		if (typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}

	return current;
}

function setValueAtPointer(root: unknown, pointer: string, value: unknown): unknown {
	if (!pointer) return value;
	const segments = decodeJsonPointer(pointer);
	let current: unknown = root;

	for (let index = 0; index < segments.length - 1; index += 1) {
		const segment = segments[index];
		if (current === null || current === undefined) return root;
		if (Array.isArray(current)) {
			const arrayIndex = Number(segment);
			if (!Number.isInteger(arrayIndex)) return root;
			current = current[arrayIndex];
			continue;
		}
		if (typeof current !== "object") return root;
		current = (current as Record<string, unknown>)[segment];
	}

	const lastSegment = segments[segments.length - 1];
	if (Array.isArray(current)) {
		const arrayIndex = Number(lastSegment);
		if (!Number.isInteger(arrayIndex)) return root;
		current[arrayIndex] = value;
		return root;
	}

	if (typeof current !== "object" || current === null) return root;
	(current as Record<string, unknown>)[lastSegment] = value;
	return root;
}

function deleteValueAtPointer(root: unknown, pointer: string): unknown {
	if (!pointer) return root;
	const segments = decodeJsonPointer(pointer);
	if (segments.length === 0) return root;
	return deleteAtSegment(root, segments, 0);
}

function deleteAtSegment(node: unknown, segments: string[], depth: number): unknown {
	const segment = segments[depth];
	const isLeaf = depth === segments.length - 1;

	if (Array.isArray(node)) {
		const index = Number(segment);
		if (!Number.isInteger(index) || index < 0 || index >= node.length) return node;
		if (isLeaf) {
			const next = node.slice();
			next.splice(index, 1);
			return next;
		}
		const child = deleteAtSegment(node[index], segments, depth + 1);
		if (child === node[index]) return node;
		const next = node.slice();
		next[index] = child;
		return next;
	}

	if (typeof node !== "object" || node === null) return node;
	const obj = node as Record<string, unknown>;
	if (!Object.hasOwn(obj, segment)) return node;
	if (isLeaf) {
		const { [segment]: _omit, ...rest } = obj;
		return rest;
	}
	const child = deleteAtSegment(obj[segment], segments, depth + 1);
	if (child === obj[segment]) return node;
	return { ...obj, [segment]: child };
}

function branchMatchesSchema(branch: unknown, value: unknown): boolean {
	return isJsonSchemaValueValid(branch, value);
}

function normalizeOptionalNullsForSchema(
	schema: unknown,
	value: unknown,
	isRoot = true,
): { value: unknown; changed: boolean } {
	if (value === null || value === undefined) return { value, changed: false };
	if (schema === null || typeof schema !== "object") return { value, changed: false };

	const schemaObject = schema as Record<string, unknown>;

	const normalizeAnyOfLike = (keyword: "anyOf" | "oneOf"): { value: unknown; changed: boolean } => {
		const branches = schemaObject[keyword];
		if (!Array.isArray(branches)) return { value, changed: false };

		for (const branch of branches) {
			if (branchMatchesSchema(branch, value)) return { value, changed: false };
		}

		let changedCandidate: { value: unknown; changed: true } | null = null;

		for (const branch of branches) {
			const normalized = normalizeOptionalNullsForSchema(branch, value, isRoot);
			if (!normalized.changed) continue;

			if (branchMatchesSchema(branch, normalized.value)) {
				return normalized;
			}

			if (!changedCandidate) {
				changedCandidate = { value: normalized.value, changed: true };
			}
		}

		return changedCandidate ?? { value, changed: false };
	};

	const anyOfNormalization = normalizeAnyOfLike("anyOf");
	if (anyOfNormalization.changed) return anyOfNormalization;

	const oneOfNormalization = normalizeAnyOfLike("oneOf");
	if (oneOfNormalization.changed) return oneOfNormalization;

	if (Array.isArray(schemaObject.allOf)) {
		let changed = false;
		let nextValue: unknown = value;
		for (const branch of schemaObject.allOf) {
			const normalized = normalizeOptionalNullsForSchema(branch, nextValue, isRoot);
			if (!normalized.changed) continue;
			nextValue = normalized.value;
			changed = true;
		}
		if (changed) return { value: nextValue, changed: true };
	}

	if (Array.isArray(value)) {
		const itemSchema = schemaObject.items;
		if (!isRecord(itemSchema)) {
			return { value, changed: false };
		}

		let changed = false;
		let nextValue = value;
		for (let i = 0; i < value.length; i += 1) {
			const normalized = normalizeOptionalNullsForSchema(itemSchema, value[i], false);
			if (!normalized.changed) continue;
			if (!changed) {
				nextValue = value.slice();
				changed = true;
			}
			nextValue[i] = normalized.value;
		}
		return { value: changed ? nextValue : value, changed };
	}

	if ((schemaObject.type === "number" || schemaObject.type === "integer") && typeof value === "string") {
		return tryParseNumberString(value, [schemaObject.type as string]);
	}

	if (schemaObject.type !== "object") return { value, changed: false };
	if (typeof value !== "object" || value === null) return { value, changed: false };
	if (Array.isArray(value)) return { value, changed: false };
	if (schemaObject.properties === null || typeof schemaObject.properties !== "object") {
		return { value, changed: false };
	}

	const properties = schemaObject.properties as Record<string, unknown>;
	const required = new Set(Array.isArray(schemaObject.required) ? (schemaObject.required as string[]) : []);

	let changed = false;
	let nextValue = value as Record<string, unknown>;

	for (const [key, propertySchema] of Object.entries(properties)) {
		if (!(key in nextValue)) continue;
		const currentValue = nextValue[key];
		const isNullish = currentValue === null || currentValue === "null";
		const isInvalidEmptyString =
			currentValue === "" && !required.has(key) && !branchMatchesSchema(propertySchema, currentValue);

		if ((isNullish || isInvalidEmptyString) && !required.has(key)) {
			if (!changed) {
				nextValue = { ...nextValue };
				changed = true;
			}
			delete nextValue[key];
			continue;
		}

		if (isNullish && propertySchema && typeof propertySchema === "object") {
			const propertyObject = propertySchema as Record<string, unknown>;
			if ("default" in propertyObject) {
				if (!changed) {
					nextValue = { ...nextValue };
					changed = true;
				}
				nextValue[key] = structuredCloneJSON(propertyObject.default);
				continue;
			}
		}
		const normalized = normalizeOptionalNullsForSchema(propertySchema, currentValue, false);
		if (!normalized.changed) continue;

		if (!changed) {
			nextValue = { ...nextValue };
			changed = true;
		}
		nextValue[key] = normalized.value;
	}

	if (!isRoot && schemaObject.additionalProperties === false) {
		const knownKeys = new Set(Object.keys(properties));
		for (const key of Object.keys(nextValue)) {
			if (knownKeys.has(key)) continue;
			const v = nextValue[key];
			if (v !== null && v !== "null") continue;
			if (!changed) {
				nextValue = { ...nextValue };
				changed = true;
			}
			delete nextValue[key];
		}
	}

	return { value: changed ? nextValue : value, changed };
}

function decodeJsonPointerToken(token: string): string {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalJsonSchemaRef(root: unknown, ref: string): unknown | undefined {
	if (ref === "#") return root;
	if (!ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const rawToken of ref.slice(2).split("/")) {
		const token = decodeJsonPointerToken(rawToken);
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[token];
	}
	return current;
}

function normalizeEnumStringWhitespace(
	schema: unknown,
	value: unknown,
	root: unknown = schema,
	refs: ReadonlySet<string> = new Set(),
): { value: unknown; changed: boolean } {
	if (value === null || value === undefined) return { value, changed: false };
	if (schema === null || typeof schema !== "object") return { value, changed: false };

	const schemaObject = schema as Record<string, unknown>;
	const ref = schemaObject.$ref;
	if (typeof ref === "string") {
		if (refs.has(ref)) return { value, changed: false };
		const resolved = resolveLocalJsonSchemaRef(root, ref);
		if (resolved === undefined) return { value, changed: false };
		const nextRefs = new Set(refs);
		nextRefs.add(ref);
		return normalizeEnumStringWhitespace(resolved, value, root, nextRefs);
	}

	const branchMatches = (branch: unknown, candidate: unknown): boolean => {
		if (branch !== null && typeof branch === "object") {
			const branchRef = (branch as Record<string, unknown>).$ref;
			if (typeof branchRef === "string" && !refs.has(branchRef)) {
				const resolved = resolveLocalJsonSchemaRef(root, branchRef);
				if (resolved !== undefined) return branchMatchesSchema(resolved, candidate);
			}
		}
		return branchMatchesSchema(branch, candidate);
	};

	const normalizeAnyOfLike = (keyword: "anyOf" | "oneOf"): { value: unknown; changed: boolean } => {
		const branches = schemaObject[keyword];
		if (!Array.isArray(branches)) return { value, changed: false };
		if (branches.some(branch => branchMatches(branch, value))) return { value, changed: false };

		for (const branch of branches) {
			const normalized = normalizeEnumStringWhitespace(branch, value, root, refs);
			if (!normalized.changed) continue;
			if (branchMatches(branch, normalized.value)) return normalized;
		}
		return { value, changed: false };
	};

	const anyOfNormalization = normalizeAnyOfLike("anyOf");
	if (anyOfNormalization.changed) return anyOfNormalization;

	const oneOfNormalization = normalizeAnyOfLike("oneOf");
	if (oneOfNormalization.changed) return oneOfNormalization;

	if (Array.isArray(schemaObject.allOf)) {
		let changed = false;
		let nextValue: unknown = value;
		for (const branch of schemaObject.allOf) {
			const normalized = normalizeEnumStringWhitespace(branch, nextValue, root, refs);
			if (!normalized.changed) continue;
			nextValue = normalized.value;
			changed = true;
		}
		if (changed) return { value: nextValue, changed: true };
	}

	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed !== value) {
			const enumValues = schemaObject.enum;
			if (Array.isArray(enumValues) && !enumValues.includes(value) && enumValues.includes(trimmed)) {
				return { value: trimmed, changed: true };
			}
			const constValue = schemaObject.const;
			if (typeof constValue === "string" && trimmed === constValue) {
				return { value: trimmed, changed: true };
			}
		}
		return { value, changed: false };
	}

	if (Array.isArray(value)) {
		let changed = false;
		let nextValue = value;
		const prefixItems = schemaObject.prefixItems;
		if (Array.isArray(prefixItems)) {
			for (let i = 0; i < value.length && i < prefixItems.length; i += 1) {
				const itemSchema = prefixItems[i];
				const normalized = normalizeEnumStringWhitespace(itemSchema, value[i], root, refs);
				if (!normalized.changed) continue;
				if (!changed) {
					nextValue = value.slice();
					changed = true;
				}
				nextValue[i] = normalized.value;
			}
		}

		const itemSchema = schemaObject.items;
		if (isRecord(itemSchema)) {
			for (let i = 0; i < value.length; i += 1) {
				if (Array.isArray(prefixItems) && i < prefixItems.length) continue;
				const normalized = normalizeEnumStringWhitespace(itemSchema, nextValue[i], root, refs);
				if (!normalized.changed) continue;
				if (!changed) {
					nextValue = value.slice();
					changed = true;
				}
				nextValue[i] = normalized.value;
			}
		}
		return { value: changed ? nextValue : value, changed };
	}

	if (typeof value !== "object") return { value, changed: false };
	const properties = schemaObject.properties;
	if (!properties || typeof properties !== "object") return { value, changed: false };

	const propsObject = properties as Record<string, unknown>;
	const valueObject = value as Record<string, unknown>;
	let changed = false;
	let nextValue = valueObject;
	for (const [key, propertySchema] of Object.entries(propsObject)) {
		if (!(key in nextValue)) continue;
		const normalized = normalizeEnumStringWhitespace(propertySchema, nextValue[key], root, refs);
		if (!normalized.changed) continue;
		if (!changed) {
			nextValue = { ...nextValue };
			changed = true;
		}
		nextValue[key] = normalized.value;
	}
	return { value: changed ? nextValue : valueObject, changed };
}

const IDENTIFIER_STRING_KEYS: ReadonlySet<string> = new Set([
	"path",
	"paths",
	"file",
	"file_path",
	"filePath",
	"filepath",
	"url",
	"uri",
	"title",
	"label",
]);

const CONTENT_CARRYING_KEYS: ReadonlySet<string> = new Set(["content", "input", "body", "text", "command", "code"]);

const TRAILING_LINE_TERMINATOR_RE = /[\r\n]+$/;

function trimTrailingLineTerminators(input: string): string {
	if (!TRAILING_LINE_TERMINATOR_RE.test(input)) return input;
	return input.replace(TRAILING_LINE_TERMINATOR_RE, "");
}

function trimIdentifierStringLeaf(input: unknown): unknown {
	if (typeof input === "string") {
		const trimmed = trimTrailingLineTerminators(input);
		return trimmed === input ? input : trimmed;
	}
	if (Array.isArray(input)) {
		let changed = false;
		let next = input;
		for (let i = 0; i < input.length; i += 1) {
			const item = input[i];
			if (typeof item !== "string") continue;
			const trimmed = trimTrailingLineTerminators(item);
			if (trimmed === item) continue;
			if (!changed) {
				next = input.slice();
				changed = true;
			}
			next[i] = trimmed;
		}
		return changed ? next : input;
	}
	return input;
}

const MAX_VALUE_WALK_DEPTH = 64;

function normalizeIdentifierStringWhitespace(value: unknown, depth = 0): { value: unknown; changed: boolean } {
	if (depth >= MAX_VALUE_WALK_DEPTH) return { value, changed: false };
	if (Array.isArray(value)) {
		let changed = false;
		let next = value;
		for (let i = 0; i < value.length; i += 1) {
			const normalized = normalizeIdentifierStringWhitespace(value[i], depth + 1);
			if (!normalized.changed) continue;
			if (!changed) {
				next = value.slice();
				changed = true;
			}
			next[i] = normalized.value;
		}
		return { value: changed ? next : value, changed };
	}

	if (value === null || typeof value !== "object") return { value, changed: false };

	const source = value as Record<string, unknown>;
	let changed = false;
	let out: Record<string, unknown> = source;
	for (const [key, entry] of Object.entries(source)) {
		let nextEntry = entry;
		if (CONTENT_CARRYING_KEYS.has(key)) continue;
		if (IDENTIFIER_STRING_KEYS.has(key)) {
			const trimmed = trimIdentifierStringLeaf(entry);
			if (trimmed !== entry) nextEntry = trimmed;
		}
		const nested = normalizeIdentifierStringWhitespace(nextEntry, depth + 1);
		if (nested.changed) nextEntry = nested.value;
		if (nextEntry === entry) continue;
		if (!changed) {
			out = { ...source };
			changed = true;
		}
		out[key] = nextEntry;
	}
	return { value: changed ? out : value, changed };
}

const MAX_KEY_DECODE_DEPTH = 3;

function decodeDoubleEncodedKey(key: string): string | null {
	let current = key;
	let decoded: string | null = null;
	for (let depth = 0; depth < MAX_KEY_DECODE_DEPTH; depth += 1) {
		if (current.length < 2 || current[0] !== '"' || current[current.length - 1] !== '"') break;
		let parsed: unknown;
		try {
			parsed = JSON.parse(current);
		} catch {
			break;
		}
		if (typeof parsed !== "string") break;
		current = parsed;
		decoded = current;
	}
	return decoded;
}

function normalizeDoubleEncodedKeys(value: unknown, depth = 0): { value: unknown; changed: boolean } {
	if (depth >= MAX_VALUE_WALK_DEPTH) return { value, changed: false };
	if (Array.isArray(value)) {
		let changed = false;
		let next = value;
		for (let i = 0; i < value.length; i += 1) {
			const normalized = normalizeDoubleEncodedKeys(value[i], depth + 1);
			if (!normalized.changed) continue;
			if (!changed) {
				next = value.slice();
				changed = true;
			}
			next[i] = normalized.value;
		}
		return { value: changed ? next : value, changed };
	}

	if (value === null || typeof value !== "object") return { value, changed: false };

	const source = value as Record<string, unknown>;
	let changed = false;
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(source)) {
		const normalizedChild = normalizeDoubleEncodedKeys(entry, depth + 1);
		const nextChild = normalizedChild.changed ? normalizedChild.value : entry;

		const decodedKey = decodeDoubleEncodedKey(key);
		const targetKey =
			decodedKey !== null &&
			decodedKey !== key &&
			!Object.hasOwn(source, decodedKey) &&
			!Object.hasOwn(out, decodedKey)
				? decodedKey
				: key;

		if (targetKey !== key || normalizedChild.changed) changed = true;
		Object.defineProperty(out, targetKey, {
			value: nextChild,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}

	return { value: changed ? out : value, changed };
}

function schemaAcceptsStringAndArray(schema: Record<string, unknown>): boolean {
	if (Array.isArray(schema.type) && schema.type.includes("string") && schema.type.includes("array")) {
		return true;
	}

	for (const key of ["anyOf", "oneOf"] as const) {
		const branches = schema[key];
		if (!Array.isArray(branches)) continue;
		let hasString = false;
		let hasArray = false;
		for (const branch of branches) {
			if (!branch || typeof branch !== "object") continue;
			const branchType = (branch as Record<string, unknown>).type;
			if (branchType === "string" || (Array.isArray(branchType) && branchType.includes("string"))) {
				hasString = true;
			}
			if (branchType === "array" || (Array.isArray(branchType) && branchType.includes("array"))) {
				hasArray = true;
			}
			if (hasString && hasArray) return true;
		}
	}
	return false;
}

function schemaNodeAcceptsArray(schema: unknown): schema is Record<string, unknown> {
	if (!schema || typeof schema !== "object") return false;
	const schemaObject = schema as Record<string, unknown>;
	const schemaType = schemaObject.type;
	return schemaType === "array" || (Array.isArray(schemaType) && schemaType.includes("array"));
}

function parsedArrayMatchesArrayBranch(schema: Record<string, unknown>, value: unknown[]): boolean {
	if (schemaNodeAcceptsArray(schema)) {
		return isJsonSchemaValueValid(schema, value);
	}

	for (const key of ["anyOf", "oneOf"] as const) {
		const branches = schema[key];
		if (!Array.isArray(branches)) continue;
		const branchList: unknown[] = branches;
		for (const branch of branchList) {
			if (!schemaNodeAcceptsArray(branch)) continue;
			if (isJsonSchemaValueValid(branch, value)) return true;
		}
	}
	return false;
}

function normalizeStringEncodedArrayUnions(schema: unknown, value: unknown): { value: unknown; changed: boolean } {
	if (value === null || value === undefined) return { value, changed: false };
	if (schema === null || typeof schema !== "object") return { value, changed: false };

	const schemaObject = schema as Record<string, unknown>;

	if (typeof value === "string" && schemaAcceptsStringAndArray(schemaObject)) {
		const trimmed = value.trim();
		if (!trimmed.startsWith("[")) return { value, changed: false };
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (Array.isArray(parsed)) {
				const candidate = normalizeDoubleEncodedKeys(parsed).value as unknown[];
				if (parsedArrayMatchesArrayBranch(schemaObject, candidate)) {
					return { value: candidate, changed: true };
				}
			}
		} catch {}
		return { value, changed: false };
	}

	if (Array.isArray(value)) {
		const itemSchema = schemaObject.items;
		if (!isRecord(itemSchema)) {
			return { value, changed: false };
		}
		let changed = false;
		let nextValue = value;
		for (let i = 0; i < value.length; i += 1) {
			const normalized = normalizeStringEncodedArrayUnions(itemSchema, value[i]);
			if (!normalized.changed) continue;
			if (!changed) {
				nextValue = value.slice();
				changed = true;
			}
			nextValue[i] = normalized.value;
		}
		return { value: changed ? nextValue : value, changed };
	}

	if (schemaObject.type !== "object") return { value, changed: false };
	if (typeof value !== "object" || value === null) return { value, changed: false };
	const properties = schemaObject.properties;
	if (!properties || typeof properties !== "object") return { value, changed: false };

	const propsObject = properties as Record<string, unknown>;
	const valueObject = value as Record<string, unknown>;
	let changed = false;
	let nextValue = valueObject;
	for (const [key, propertySchema] of Object.entries(propsObject)) {
		if (!(key in nextValue)) continue;
		const normalized = normalizeStringEncodedArrayUnions(propertySchema, nextValue[key]);
		if (!normalized.changed) continue;
		if (!changed) {
			nextValue = { ...nextValue };
			changed = true;
		}
		nextValue[key] = normalized.value;
	}
	return { value: changed ? nextValue : valueObject, changed };
}

function singleRequiredStringKey(schema: unknown): string | undefined {
	if (!isRecord(schema)) return undefined;
	const obj = schema as Record<string, unknown>;
	if (obj.type !== "object") return undefined;
	const properties = obj.properties;
	if (!properties || typeof properties !== "object") return undefined;
	const keys = Object.keys(properties as Record<string, unknown>);
	if (keys.length !== 1) return undefined;
	const key = keys[0];
	const required = obj.required;
	if (!Array.isArray(required) || required.length !== 1 || required[0] !== key) return undefined;
	const propertySchema = (properties as Record<string, unknown>)[key];
	if (!propertySchema || typeof propertySchema !== "object") return undefined;
	return (propertySchema as Record<string, unknown>).type === "string" ? key : undefined;
}

function normalizeSingleStringField(schema: unknown, value: unknown): { value: unknown; changed: boolean } {
	const key = singleRequiredStringKey(schema);
	if (key === undefined) return { value, changed: false };
	if (!isRecord(value)) return { value, changed: false };
	const record = value as Record<string, unknown>;
	if (record[key] !== undefined) return { value, changed: false };
	for (const candidate in record) {
		if (candidate === key || !Object.hasOwn(record, candidate)) continue;
		const candidateValue = record[candidate];
		if (typeof candidateValue !== "string") continue;
		const next = { ...record, [key]: candidateValue };
		delete next[candidate];
		return { value: next, changed: true };
	}
	return { value, changed: false };
}

interface FlatIssue {
	keyword: "type" | "unrecognized" | "other";
	instancePath: string;
	expectedTypes: string[];
	unionBranch: boolean;
}

function mapZodExpectedToJsonSchemaType(expected: unknown): string | null {
	if (typeof expected !== "string") return null;
	switch (expected) {
		case "string":
		case "number":
		case "boolean":
		case "array":
		case "object":
		case "null":
			return expected;
		case "record":
			return "object";
		case "int":
		case "bigint":
			return "integer";
		case "nan":
			return "number";
		default:
			return null;
	}
}

function flattenIssues(issues: ReadonlyArray<ZodIssue>): FlatIssue[] {
	const out: FlatIssue[] = [];
	const walk = (issue: ZodIssue, prefix: ReadonlyArray<PropertyKey>, unionBranch: boolean): void => {
		const fullPath = prefix.length === 0 ? issue.path : prefix.concat(issue.path);
		if (issue.code === "invalid_type") {
			const mapped = mapZodExpectedToJsonSchemaType((issue as { expected?: unknown }).expected);
			if (mapped) {
				out.push({ keyword: "type", instancePath: pathToPointer(fullPath), expectedTypes: [mapped], unionBranch });
				return;
			}
		}
		if (issue.code === "unrecognized_keys") {
			const keys = (issue as { keys?: ReadonlyArray<string> }).keys ?? [];
			for (const key of keys) {
				out.push({
					keyword: "unrecognized",
					instancePath: pathToPointer(fullPath.concat([key])),
					expectedTypes: [],
					unionBranch,
				});
			}
			return;
		}
		if (issue.code === "invalid_union") {
			const inner = (issue as unknown as { errors?: ReadonlyArray<ReadonlyArray<ZodIssue>> }).errors;
			if (inner) {
				for (const branch of inner) {
					for (const child of branch) {
						walk(child, fullPath, child.path.length === 0);
					}
				}
			}
			return;
		}
		out.push({ keyword: "other", instancePath: pathToPointer(fullPath), expectedTypes: [], unionBranch });
	};
	for (const issue of issues) walk(issue, [], false);
	return out;
}

function coerceArgsFromIssues(args: unknown, issues: FlatIssue[]): { value: unknown; changed: boolean } {
	if (issues.length === 0) return { value: args, changed: false };

	let changed = false;
	let owned = false;
	let nextArgs: unknown = args;

	for (const issue of issues) {
		if (issue.keyword === "unrecognized") {
			const previous = nextArgs;
			nextArgs = deleteValueAtPointer(nextArgs, issue.instancePath);
			if (nextArgs !== previous) changed = true;
			continue;
		}
		if (issue.keyword !== "type") continue;
		if (issue.expectedTypes.length === 0) continue;

		const currentValue = getValueAtPointer(nextArgs, issue.instancePath);
		const result = tryCoerceForExpectedTypes(currentValue, issue.expectedTypes);
		let coercedValue = result.changed ? result.value : undefined;
		if (
			coercedValue === undefined &&
			issue.expectedTypes.includes("array") &&
			!issue.unionBranch &&
			currentValue !== undefined &&
			!Array.isArray(currentValue)
		) {
			const objectCoercion =
				typeof currentValue === "string"
					? tryParseJsonForTypes(currentValue, ["object"])
					: { value: currentValue, changed: false };
			if (objectCoercion.changed || !looksLikeJsonContainerString(currentValue)) {
				coercedValue = [objectCoercion.changed ? objectCoercion.value : currentValue];
			}
		}
		if (coercedValue === undefined) continue;

		if (!owned) {
			nextArgs = structuredCloneJSON(nextArgs);
			owned = true;
			changed = true;
		}
		nextArgs = setValueAtPointer(nextArgs, issue.instancePath, coercedValue);
	}

	return { value: changed ? nextArgs : args, changed };
}

type ValidationContext =
	| {
			kind: "zod";
			zod: ZodType;
			json: Record<string, unknown>;
	  }
	| {
			kind: "arktype";
			ark: Type;
			json: Record<string, unknown>;
	  }
	| {
			kind: "json";
			json: Record<string, unknown>;
	  };

const kValidationContext = Symbol("ai.validationContext");
function getValidationContext(tool: Tool): ValidationContext {
	return stamp(tool.parameters as object, kValidationContext, params =>
		isArkSchema(params)
			? { kind: "arktype", ark: params, json: arkToWireSchema(params) }
			: isZodSchema(params)
				? { kind: "zod", zod: params, json: zodToWireSchema(params) }
				: { kind: "json", json: upgradeJsonSchemaTo202012(params) as Record<string, unknown> },
	);
}

type ContextValidationResult =
	| { success: true; value: unknown }
	| { success: false; flatIssues: FlatIssue[]; messages: string[] };

function preserveUnknownRootFields(input: unknown, parsed: unknown): unknown {
	if (!isRecord(input) || !isRecord(parsed)) return parsed;
	return { ...input, ...parsed };
}

function flattenJsonSchemaIssues(issues: ReadonlyArray<JsonSchemaValidationIssue>): FlatIssue[] {
	return issues.map(issue => {
		const unionBranch = issue.fromUnionBranch === true;
		if (issue.keyword === "additionalProperties") {
			return {
				keyword: "unrecognized",
				instancePath: pathToPointer(issue.path),
				expectedTypes: [],
				unionBranch,
			};
		}
		return {
			keyword: issue.keyword === "type" ? "type" : "other",
			instancePath: pathToPointer(issue.path),
			expectedTypes: issue.expectedTypes ?? [],
			unionBranch,
		};
	});
}

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
	return path.length === 0 ? "root" : path.map(seg => String(seg)).join("/");
}

function validateContext(ctx: ValidationContext, value: unknown): ContextValidationResult {
	if (ctx.kind === "zod") {
		const result = ctx.zod.safeParse(value);
		if (result.success) {
			return { success: true, value: preserveUnknownRootFields(value, result.data) };
		}
		return {
			success: false,
			flatIssues: flattenIssues(result.error.issues),
			messages: result.error.issues.map(issue => `  - ${formatIssuePath(issue.path)}: ${issue.message}`),
		};
	}

	if (ctx.kind === "arktype") {
		const out = ctx.ark(value);
		if (!isArkErrors(out)) {
			return { success: true, value: preserveUnknownRootFields(value, out) };
		}
		const jr = validateJsonSchemaValue(ctx.json, value);
		const flatIssues = jr.success ? [] : flattenJsonSchemaIssues(jr.issues);
		return {
			success: false,
			flatIssues,
			messages: out.map(e => `  - ${formatIssuePath(e.path)}: ${e.message}`),
		};
	}

	const result = validateJsonSchemaValue(ctx.json, value);
	if (result.success) return { success: true, value };
	return {
		success: false,
		flatIssues: flattenJsonSchemaIssues(result.issues),
		messages: result.issues.map(issue => `  - ${formatIssuePath(issue.path)}: ${issue.message}`),
	};
}

const SPILL_KEY_PATTERN = /^[\w.$-]{1,128}$/;

interface SpillSplit {
	head: string;
	pairs: [string, string][];
}

function skipSpillWhitespace(text: string, from: number): number {
	let at = from;
	while (at < text.length && " \n\t\r".includes(text[at]!)) at++;
	return at;
}

function isSpillPairStart(text: string, at: number): boolean {
	if (!text.startsWith(ARG_KEY_OPEN, at)) return false;
	const keyStart = at + ARG_KEY_OPEN.length;
	const keyEnd = text.indexOf(ARG_KEY_CLOSE, keyStart);
	if (keyEnd === -1 || !SPILL_KEY_PATTERN.test(text.slice(keyStart, keyEnd))) return false;
	const valueAt = skipSpillWhitespace(text, keyEnd + ARG_KEY_CLOSE.length);
	return text.startsWith(ARG_VALUE_OPEN, valueAt);
}

function findSpillValueEnd(text: string, from: number): { end: number; next: number } {
	const close = text.indexOf(ARG_VALUE_CLOSE, from);
	let wrong = text.indexOf(ARG_KEY_CLOSE, from);
	let open = text.indexOf(ARG_KEY_OPEN, from);
	while (true) {
		const candidates = [close, wrong, open].filter(index => index !== -1);
		if (candidates.length === 0) return { end: text.length, next: text.length };
		const at = Math.min(...candidates);
		if (at === close) return { end: at, next: at + ARG_VALUE_CLOSE.length };
		if (at === wrong) {
			const follow = skipSpillWhitespace(text, at + ARG_KEY_CLOSE.length);
			if (
				follow >= text.length ||
				text.startsWith(ARG_KEY_OPEN, follow) ||
				text.startsWith(TOOL_CALL_CLOSE, follow)
			) {
				return { end: at, next: at + ARG_KEY_CLOSE.length };
			}
			wrong = text.indexOf(ARG_KEY_CLOSE, at + 1);
			continue;
		}
		if (isSpillPairStart(text, at)) {
			let end = at;
			while (end > from && " \n\t\r".includes(text[end - 1]!)) end--;
			return { end, next: at };
		}
		open = text.indexOf(ARG_KEY_OPEN, at + 1);
	}
}

function parseSpilledPairs(text: string): [string, string][] | null {
	const pairs: [string, string][] = [];
	let at = skipSpillWhitespace(text, 0);
	while (at < text.length) {
		if (text.startsWith(TOOL_CALL_CLOSE, at)) {
			at = skipSpillWhitespace(text, at + TOOL_CALL_CLOSE.length);
			return at >= text.length ? pairs : null;
		}
		if (!text.startsWith(ARG_KEY_OPEN, at)) return null;
		const keyStart = at + ARG_KEY_OPEN.length;
		const keyEnd = text.indexOf(ARG_KEY_CLOSE, keyStart);
		if (keyEnd === -1) return null;
		const key = text.slice(keyStart, keyEnd);
		if (!SPILL_KEY_PATTERN.test(key)) return null;
		at = skipSpillWhitespace(text, keyEnd + ARG_KEY_CLOSE.length);
		if (!text.startsWith(ARG_VALUE_OPEN, at)) return null;
		at += ARG_VALUE_OPEN.length;
		const { end, next } = findSpillValueEnd(text, at);
		pairs.push([key, text.slice(at, end)]);
		at = skipSpillWhitespace(text, next);
	}
	return pairs;
}

function splitSpilledValue(text: string): SpillSplit | null {
	let wrong = text.indexOf(ARG_KEY_CLOSE);
	let open = text.indexOf(ARG_KEY_OPEN);
	while (wrong !== -1 || open !== -1) {
		if (wrong !== -1 && (open === -1 || wrong < open)) {
			const pairs = parseSpilledPairs(text.slice(wrong + ARG_KEY_CLOSE.length));
			if (pairs) return { head: text.slice(0, wrong), pairs };
			wrong = text.indexOf(ARG_KEY_CLOSE, wrong + 1);
			continue;
		}
		if (isSpillPairStart(text, open)) {
			const pairs = parseSpilledPairs(text.slice(open));
			if (pairs && pairs.length > 0) return { head: text.slice(0, open).trimEnd(), pairs };
		}
		open = text.indexOf(ARG_KEY_OPEN, open + 1);
	}
	return null;
}

function healInbandArgSpill(value: unknown): { value: unknown; changed: boolean } {
	if (!isRecord(value)) return { value, changed: false };
	let changed = false;
	const out: Record<string, unknown> = { ...value };
	const recovered: [string, string][] = [];
	for (const key in value) {
		const entry = value[key];
		if (typeof entry !== "string") continue;
		if (!entry.includes(ARG_KEY_OPEN) && !entry.includes(ARG_KEY_CLOSE)) continue;
		const split = splitSpilledValue(entry);
		if (!split) continue;
		out[key] = split.head;
		for (let pi = 0; pi < split.pairs.length; pi++) recovered.push(split.pairs[pi]!);
		changed = true;
	}
	if (!changed) return { value, changed: false };
	for (const [key, entry] of recovered) {
		if (!(key in out)) out[key] = entry;
	}
	return { value: out, changed: true };
}

const MAX_COERCION_PASSES = 5;

export function validateToolCall(tools: Tool[], toolCall: ToolCall): ToolCall["arguments"] {
	const tool = tools.find(t => t.name === toolCall.name);
	if (!tool) {
		throw new AIError.ToolNotFoundError(
			toolCall.name,
			tools.map(t => t.name),
		);
	}
	return validateToolArguments(tool, toolCall);
}

const MAX_ERROR_ARG_STRING_LENGTH = 256;
const MAX_ERROR_ARG_ARRAY_SAMPLE = 1;
const MAX_ERROR_ARG_OBJECT_KEYS = 8;
const MAX_ERROR_ARGS_JSON_LENGTH = 600;
const MAX_ERROR_RAW_JSON_LENGTH = 512;
const MAX_ERROR_ARG_DEPTH = 8;
const MAX_ERROR_ISSUES_LENGTH = 400;
const MAX_ERROR_MESSAGE_LENGTH = 1200;

function boundErrorText(text: string, max: number): string {
	if (text.length <= max) return text;
	const note = (keep: number): string => `… [truncated ${text.length - keep} chars]`;
	let keep = max;
	while (keep > 0 && keep + note(keep).length > max) keep--;
	return `${text.slice(0, keep)}${note(keep)}`;
}

function truncateArgsForError(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return boundErrorText(value, MAX_ERROR_ARG_STRING_LENGTH);
	if (Array.isArray(value)) {
		if (depth >= MAX_ERROR_ARG_DEPTH) return `… ${value.length} element(s) elided below depth ${depth}`;
		const sample: unknown[] = value
			.slice(0, MAX_ERROR_ARG_ARRAY_SAMPLE)
			.map(entry => truncateArgsForError(entry, depth + 1));
		const elided = value.length - sample.length;
		if (elided > 0) sample.push(`… ${elided} more of ${value.length} element(s) elided`);
		return sample;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value);
		if (depth >= MAX_ERROR_ARG_DEPTH) return `… ${entries.length} key(s) elided below depth ${depth}`;
		const out: Record<string, unknown> = {};
		for (const [key, entry] of entries.slice(0, MAX_ERROR_ARG_OBJECT_KEYS)) {
			out[key] = truncateArgsForError(entry, depth + 1);
		}
		const elided = entries.length - Math.min(entries.length, MAX_ERROR_ARG_OBJECT_KEYS);
		if (elided > 0) out["…"] = `${elided} more of ${entries.length} key(s) elided`;
		return out;
	}
	return value;
}

function isEmptyEcho(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === "object") return Object.keys(value).length === 0;
	return false;
}

function schemaLiteralValues(node: unknown, depth = 0): string[] | undefined {
	if (depth > 4 || !isRecord(node)) return undefined;
	const enumValues = node.enum;
	if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues.map(entry => String(entry));
	if ("const" in node && node.const !== undefined) return [String(node.const)];
	const branches = node.anyOf ?? node.oneOf;
	if (!Array.isArray(branches)) return undefined;
	const collected: string[] = [];
	for (const branch of branches) {
		const values = schemaLiteralValues(branch, depth + 1);
		if (!values) return undefined;
		for (let vi = 0; vi < values.length; vi++) collected.push(values[vi]!);
	}
	return collected.length > 0 ? collected : undefined;
}

function schemaNodeAtIssuePath(json: unknown, path: string): unknown {
	if (path === "root") return json;
	let node: unknown = json;
	for (const segment of path.split("/")) {
		if (!isRecord(node)) return undefined;
		const child = /^\d+$/.test(segment)
			? node.items
			: isRecord(node.properties)
				? node.properties[segment]
				: undefined;
		if (child === undefined) return undefined;
		node = child;
	}
	return node;
}

function annotateIssuesWithAcceptedValues(json: unknown, messages: readonly string[]): string[] {
	const annotated = messages.map(message => {
		const match = /^\s*-\s([^:]+):\s/.exec(message);
		if (!match) return { message, namesTheSet: false };
		const values = schemaLiteralValues(schemaNodeAtIssuePath(json, match[1]));
		if (!values || values.length === 0) return { message, namesTheSet: false };
		const tokens = new Set(message.split(/[^A-Za-z0-9_$-]+/).filter(token => token.length > 0));
		if (values.every(value => tokens.has(value))) return { message, namesTheSet: true };
		return { message: `${message} (accepted: ${values.join(" | ")})`, namesTheSet: true };
	});
	return annotated
		.filter(line => line.namesTheSet)
		.concat(annotated.filter(line => !line.namesTheSet))
		.map(line => line.message);
}

export function validateToolArguments(tool: Tool, toolCall: ToolCall): ToolCall["arguments"] {
	const originalArgs = toolCall.arguments;
	if (originalArgs && typeof originalArgs === "object" && "__parseError" in originalArgs) {
		const parseError = originalArgs.__parseError;
		const rawJson = boundErrorText(String(originalArgs.__rawJson ?? ""), MAX_ERROR_RAW_JSON_LENGTH);
		throw new AIError.ValidationError(
			boundErrorText(
				`Validation failed for tool "${toolCall.name}": Tool call arguments are not valid JSON.\nParse Error: ${parseError}\nRaw JSON:\n${rawJson}`,
				MAX_ERROR_MESSAGE_LENGTH,
			),
		);
	}
	const ctx = getValidationContext(tool);
	const { json } = ctx;

	let normalizedArgs: unknown = originalArgs;
	let changed = false;

	const keyNormalization = normalizeDoubleEncodedKeys(normalizedArgs);
	if (keyNormalization.changed) {
		normalizedArgs = keyNormalization.value;
		changed = true;
	}

	const initialNormalization = normalizeOptionalNullsForSchema(json, normalizedArgs);
	if (initialNormalization.changed) {
		normalizedArgs = initialNormalization.value;
		changed = true;
	}

	const enumStringNormalization = normalizeEnumStringWhitespace(json, normalizedArgs);
	if (enumStringNormalization.changed) {
		normalizedArgs = enumStringNormalization.value;
		changed = true;
	}

	const identifierStringNormalization = normalizeIdentifierStringWhitespace(normalizedArgs);
	if (identifierStringNormalization.changed) {
		normalizedArgs = identifierStringNormalization.value;
		changed = true;
	}

	const stringEncodedArrayNorm = normalizeStringEncodedArrayUnions(json, normalizedArgs);
	if (stringEncodedArrayNorm.changed) {
		normalizedArgs = stringEncodedArrayNorm.value;
		changed = true;
	}

	const identifierStringNormalizationAfterArray = normalizeIdentifierStringWhitespace(normalizedArgs);
	if (identifierStringNormalizationAfterArray.changed) {
		normalizedArgs = identifierStringNormalizationAfterArray.value;
		changed = true;
	}

	const singleStringNorm = normalizeSingleStringField(json, normalizedArgs);
	if (singleStringNorm.changed) {
		normalizedArgs = singleStringNorm.value;
		changed = true;
	}

	let result = validateContext(ctx, normalizedArgs);
	if (result.success) return result.value as ToolCall["arguments"];

	const coercionOutcome = runCoercionPasses(ctx, normalizedArgs, result);
	normalizedArgs = coercionOutcome.args;
	changed ||= coercionOutcome.changed;
	result = coercionOutcome.result;
	if (result.success) return result.value as ToolCall["arguments"];

	const spillHeal = healInbandArgSpill(normalizedArgs);
	if (spillHeal.changed) {
		normalizedArgs = spillHeal.value;
		changed = true;
		result = validateContext(ctx, normalizedArgs);
		if (!result.success) {
			const healedOutcome = runCoercionPasses(ctx, normalizedArgs, result);
			normalizedArgs = healedOutcome.args;
			result = healedOutcome.result;
		}
		if (result.success) return result.value as ToolCall["arguments"];
	}

	const annotated = annotateIssuesWithAcceptedValues(json, result.messages);
	const errors = boundErrorText(annotated.join("\n") || "Unknown validation error", MAX_ERROR_ISSUES_LENGTH);

	const originalEcho = truncateArgsForError(originalArgs);
	const normalizedEcho = changed ? truncateArgsForError(normalizedArgs) : undefined;
	const normalizedIsInformative =
		normalizedEcho !== undefined &&
		!isEmptyEcho(normalizedEcho) &&
		JSON.stringify(normalizedEcho) !== JSON.stringify(originalEcho);
	const receivedArgs = normalizedIsInformative ? { original: originalEcho, normalized: normalizedEcho } : originalEcho;

	const receivedJson = JSON.stringify(receivedArgs, null, 2) ?? "undefined";
	const boundedJson = boundErrorText(receivedJson, MAX_ERROR_ARGS_JSON_LENGTH);

	const errorMessage = boundErrorText(
		`Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${boundedJson}`,
		MAX_ERROR_MESSAGE_LENGTH,
	);

	throw new AIError.ValidationError(errorMessage);
}

function runCoercionPasses(
	ctx: ValidationContext,
	args: unknown,
	initial: ContextValidationResult,
): { args: unknown; result: ContextValidationResult; changed: boolean } {
	const { json } = ctx;
	let normalizedArgs = args;
	let result = initial;
	let changed = false;
	for (let pass = 0; pass < MAX_COERCION_PASSES; pass += 1) {
		if (result.success) break;
		const coercion = coerceArgsFromIssues(normalizedArgs, result.flatIssues);
		if (!coercion.changed) break;

		normalizedArgs = coercion.value;
		changed = true;

		const keyNormalizationPass = normalizeDoubleEncodedKeys(normalizedArgs);
		if (keyNormalizationPass.changed) {
			normalizedArgs = keyNormalizationPass.value;
		}

		const nullNormalization = normalizeOptionalNullsForSchema(json, normalizedArgs);
		if (nullNormalization.changed) {
			normalizedArgs = nullNormalization.value;
		}

		const enumStringNormalizationPass = normalizeEnumStringWhitespace(json, normalizedArgs);
		if (enumStringNormalizationPass.changed) {
			normalizedArgs = enumStringNormalizationPass.value;
		}

		const identifierStringNormalizationPass = normalizeIdentifierStringWhitespace(normalizedArgs);
		if (identifierStringNormalizationPass.changed) {
			normalizedArgs = identifierStringNormalizationPass.value;
		}

		const stringEncodedArrayNormPass = normalizeStringEncodedArrayUnions(json, normalizedArgs);
		if (stringEncodedArrayNormPass.changed) {
			normalizedArgs = stringEncodedArrayNormPass.value;
		}

		const identifierStringNormalizationAfterArrayPass = normalizeIdentifierStringWhitespace(normalizedArgs);
		if (identifierStringNormalizationAfterArrayPass.changed) {
			normalizedArgs = identifierStringNormalizationAfterArrayPass.value;
		}

		const singleStringNormPass = normalizeSingleStringField(json, normalizedArgs);
		if (singleStringNormPass.changed) {
			normalizedArgs = singleStringNormPass.value;
		}

		result = validateContext(ctx, normalizedArgs);
	}
	return { args: normalizedArgs, result, changed };
}
