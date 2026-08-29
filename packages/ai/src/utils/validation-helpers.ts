import { structuredCloneJSON } from "@veyyon/utils/json";
import { isRecord } from "@veyyon/utils/type-guards";
import { isJsonSchemaValueValid } from "./schema/json-schema-validator";

export const JSON_NUMBER_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export const NUMERIC_STRING_PATTERN = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

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

function tryCoerceBooleanToNumber(
	value: unknown,
	expectedTypes: string[],
): { value: unknown; changed: boolean } {
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

export function tryCoerceForExpectedTypes(
	value: unknown,
	expectedTypes: string[],
): { value: unknown; changed: boolean } {
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

export const MAX_HEAL_DISTANCE = 3;
export const BRACKET_CHARS = ["[", "]", "{", "}"] as const;

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

export const MAX_NESTED_JSON_STRING_PARSE_DEPTH = 3;

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

export function looksLikeJsonContainerString(value: unknown): boolean {
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

export function tryParseJsonForTypes(
	value: string,
	expectedTypes: string[],
	depth = 0,
): { value: unknown; changed: boolean } {
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

export function pathToPointer(path: ReadonlyArray<PropertyKey>): string {
	if (path.length === 0) return "";
	return `/${path.map(seg => String(seg).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function decodeJsonPointer(pointer: string): string[] {
	return pointer
		.split("/")
		.slice(1) // Remove leading empty segment from initial "/"
		.map(segment => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function getValueAtPointer(root: unknown, pointer: string): unknown {
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

export function setValueAtPointer(root: unknown, pointer: string, value: unknown): unknown {
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

export function deleteValueAtPointer(root: unknown, pointer: string): unknown {
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

export function normalizeOptionalNullsForSchema(
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

export function normalizeEnumStringWhitespace(
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
