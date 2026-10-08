/**
 * Tool-call argument validation pipeline.
 *
 * Tools may declare their parameters as either Zod schemas (canonical) or
 * plain JSON Schema (legacy / extensions). This module is the single
 * entrypoint the agent calls before dispatching a tool — it:
 *
 *   1. Builds (or fetches from cache) a `ValidationContext` for the tool —
 *      the Zod schema if available plus the equivalent wire JSON Schema, or
 *      just the JSON Schema for non-Zod tools.
 *   2. Normalizes LLM quirks (null / "null" → omit-or-default substitution)
 *      against the JSON Schema before validation.
 *   3. Validates with the Zod or JSON-Schema validator.
 *   4. On failure, walks the resulting issues and coerces common LLM type
 *      drift (JSON-stringified values, boolean/number/string scalar drift),
 *      drops unrecognized keys, and retries up to `MAX_COERCION_PASSES` times.
 *   5. Throws a formatted error if reconciliation fails; otherwise returns
 *      the parsed arguments with original unknown root fields preserved (so
 *      hallucinated top-level keys still surface to the caller).
 *
 * The goal is to be conservative: every coercion is a structural rewrite that
 * keeps the schema in charge of acceptance — we never invent values, only
 * massage shapes the LLM almost got right.
 */
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

// ============================================================================
// Type Coercion Utilities
// ============================================================================
//
// LLMs sometimes produce tool arguments where a value has the right meaning but
// the wrong JSON type. For example, an array parameter might arrive as
// `"[1, 2, 3]"`, a boolean as `"yes"` or `1`, or a string field as a structured
// object that should be embedded verbatim.
//
// Rather than rejecting these outright, we attempt automatic coercion:
//   1. Validate against the tool's schema (Zod, derived from TypeBox when the
//      tool was authored with TypeBox).
//   2. For each type error, perform only the schema-directed rewrite that
//      matches the expected type.
//   3. Re-validate the full argument object after each coercion pass.
//
// This is intentionally conservative: each rewrite is small and validation
// remains the source of truth for whether the result is accepted.
// ============================================================================

/** Regex matching valid JSON number literals (integers, decimals, scientific notation) */
const JSON_NUMBER_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Regex matching numeric strings (allows leading zeros) */
const NUMERIC_STRING_PATTERN = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Checks if a value matches any of the expected JSON Schema types.
 * Used to verify that a parsed JSON value is actually what the schema wants.
 */
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

	// A BOOLEAN is deliberately not repaired into a string. Every other coercion
	// here recovers a value the model plainly meant: `"300"` for a number, a
	// JSON-encoded object for a structured field. `true` in a string field means
	// no such thing, and stringifying it produces something that reads as valid
	// and does real work — `bash({command: true})` becomes `{command: "true"}` and
	// runs the `true` binary, `read({path: true})` reads a file named "true".
	// Both look like a successful call, so the model never learns it was wrong.
	// Failing here costs one turn and returns a correction it can act on.
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

/**
 * Parses the JSON object or array that opens `value`, ignoring whatever follows
 * its matching closer. Returns `undefined` when `value` opens no container, the
 * container never closes, or no repair of it parses.
 */
function tryParseLeadingJsonContainer(value: string): unknown | undefined {
	const end = leadingJsonContainerEnd(value);
	return end === -1 ? undefined : parseJsonContainerWithRepairs(value.slice(0, end + 1));
}

/**
 * Index of the bracket closing the container `value` opens, or -1. Brackets
 * inside string literals, and brackets of the other container kind, do not count.
 */
function leadingJsonContainerEnd(value: string): number {
	const open = value[0];
	const close = open === "{" ? "}" : open === "[" ? "]" : undefined;
	if (!close) return -1;
	let depth = 0;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char === '"') {
			index = jsonStringClose(value, index);
		} else if (char === open) {
			depth += 1;
		} else if (char === close) {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

/**
 * Index of the quote closing the string literal whose opening quote is at
 * `open`, or `value.length` when the literal is unterminated.
 */
function jsonStringClose(value: string, open: number): number {
	for (let index = open + 1; index < value.length; index += 1) {
		const char = value[index];
		if (char === "\\") index += 1;
		else if (char === '"') return index;
	}
	return value.length;
}

/** Text repairs tried in order on a balanced container that does not parse, each applied to the original text. */
const JSON_CONTAINER_TEXT_REPAIRS: ReadonlyArray<(text: string) => string> = [
	// LLMs sometimes emit literal `\n` or `\t` between JSON tokens (e.g. `[{...}\n]`).
	cleanLiteralEscapes,
	// LLMs sometimes emit raw newlines or tabs inside string content instead of `\n`/`\t`.
	escapeRawControlsInJsonStrings,
];

/**
 * Parses a balanced JSON container as written, then each text repair of it,
 * then single-character bracket healing. Returns `undefined` when none parses.
 */
function parseJsonContainerWithRepairs(text: string): unknown | undefined {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		// The repairs below handle text that does not parse as written.
	}
	for (const repair of JSON_CONTAINER_TEXT_REPAIRS) {
		const parsed = parseRepairedJson(text, repair);
		if (parsed !== undefined) return parsed;
	}
	return tryHealMalformedJson(text);
}

/** Parses `repair(text)`; `undefined` when the repair changes nothing or its result does not parse. */
function parseRepairedJson(text: string, repair: (text: string) => string): unknown | undefined {
	const repaired = repair(text);
	if (repaired === text) return undefined;
	try {
		return JSON.parse(repaired) as unknown;
	} catch {
		// One rung of a repair ladder: this candidate not parsing is the normal case.
		return undefined;
	}
}

/**
 * Replace literal `\n`, `\t`, `\r` sequences that appear OUTSIDE of JSON
 * strings with a space.  LLMs sometimes produce these when they
 * confuse the tool-call encoding with the content encoding. Returns `value`
 * itself when it holds none.
 */
function cleanLiteralEscapes(value: string): string {
	let result = "";
	let copiedFrom = 0;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char === '"') {
			index = jsonStringClose(value, index);
			continue;
		}
		if (char !== "\\") continue;
		const next = value[index + 1];
		if (next !== "n" && next !== "t" && next !== "r") continue;
		result += `${value.slice(copiedFrom, index)} `;
		copiedFrom = index + 2;
		index += 1;
	}
	return copiedFrom === 0 ? value : result + value.slice(copiedFrom);
}

/** The JSON escape of each control character 0x00–0x1F: `\b`, `\t`, `\n`, `\f`, `\r` or `\u00xx`. */
const JSON_CONTROL_ESCAPES: readonly string[] = Array.from({ length: 0x20 }, (_, code) =>
	JSON.stringify(String.fromCharCode(code)).slice(1, -1),
);

/**
 * Escape raw control characters (0x00–0x1F) that appear *inside* JSON string
 * literals. LLMs sometimes emit literal newlines/tabs/etc. inside string
 * content instead of `\n` / `\t` escape sequences, which `JSON.parse` rejects
 * even though the surrounding structure is valid.
 *
 * This function only rewrites characters while inside a string; structural
 * whitespace outside of strings is preserved unchanged. Returns `value` itself
 * when it holds none.
 */
function escapeRawControlsInJsonStrings(value: string): string {
	let result = "";
	let copiedFrom = 0;
	let inString = false;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code === 0x22 /* " */) {
			inString = !inString;
		} else if (!inString) {
			// Outside a string every character is structure and stays as written.
		} else if (code === 0x5c /* \ */) {
			// The escaped character is copied as written, a quote or a control included.
			index += 1;
		} else if (code < 0x20) {
			result += value.slice(copiedFrom, index) + JSON_CONTROL_ESCAPES[code];
			copiedFrom = index + 1;
		}
	}
	return copiedFrom === 0 ? value : result + value.slice(copiedFrom);
}

/** Maximum single-character edits to attempt when healing malformed JSON. */
const MAX_HEAL_DISTANCE = 3;
const BRACKET_CHARS = ["[", "]", "{", "}"] as const;

/**
 * Attempts to heal near-valid JSON by applying single-character edits near the
 * end of the string. LLMs (especially smaller ones) sometimes produce JSON with
 * a single misplaced, extra, or wrong bracket at the end — e.g. `"}]"` becomes
 * `"]}"` or gets an extra `}` appended. This function tries:
 *   1. Removing a single character from the last few positions
 *   2. Replacing a single character in the last few positions with each bracket type
 *
 * `value` has already failed to parse as written.
 * Returns the parsed value on success, undefined on failure.
 */
function tryHealMalformedJson(value: string): unknown | undefined {
	// Only attempt edits within the last few characters — the error is always
	// a bracket issue at the tail for the class of LLM mistakes this targets.
	const tailStart = Math.max(0, value.length - (MAX_HEAL_DISTANCE * 2 + 1));

	// Strategy 1: remove a single character from the tail
	for (let i = tailStart; i < value.length; i += 1) {
		const candidate = value.slice(0, i) + value.slice(i + 1);
		try {
			return JSON.parse(candidate) as unknown;
		} catch {
			// Most single-character edits produce invalid JSON; that is the search.
		}
	}

	// Strategy 2: replace a single character in the tail with each bracket type
	for (let i = tailStart; i < value.length; i += 1) {
		const original = value[i];
		for (const replacement of BRACKET_CHARS) {
			if (replacement === original) continue;
			const candidate = value.slice(0, i) + replacement + value.slice(i + 1);
			try {
				return JSON.parse(candidate) as unknown;
			} catch {
				// As above: a rejected candidate just means try the next bracket.
			}
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

/**
 * Attempts to parse a string as JSON if it looks like a JSON literal and
 * the parsed result matches one of the expected types.
 *
 * Only attempts parsing for strings that syntactically look like JSON:
 *   - Objects: `{...}`
 *   - Arrays: `[...]`
 *   - Literals: `true`, `false`, `null`, or numeric strings
 *
 * Returns `{ changed: true }` only if parsing succeeded AND the result
 * matches an expected type. This prevents false positives like parsing
 * the string `"123"` when the schema actually wants a string.
 */
function tryParseJsonForTypes(value: string, expectedTypes: string[], depth = 0): { value: unknown; changed: boolean } {
	const trimmed = value.trim();
	if (!trimmed) return { value, changed: false };

	const numberCoercion = tryParseNumberString(trimmed, expectedTypes);
	if (numberCoercion.changed) {
		return numberCoercion;
	}

	// Quick syntactic checks to avoid unnecessary parse attempts
	const looksJsonContainer = looksLikeJsonContainerString(trimmed);
	const looksJsonScalar =
		(trimmed.startsWith('"') && !expectedTypes.includes("string")) ||
		trimmed === "true" ||
		trimmed === "false" ||
		trimmed === "null" ||
		JSON_NUMBER_PATTERN.test(trimmed);
	if (!looksJsonContainer && !looksJsonScalar) return { value, changed: false };

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed) as unknown;
	} catch {
		const repaired = looksJsonContainer
			? parseRepairedJsonContainerForTypes(trimmed, expectedTypes, depth)
			: undefined;
		return repaired ?? { value, changed: false };
	}
	const accepted = acceptParsedJsonForTypes(parsed, trimmed, expectedTypes, depth);
	return accepted.changed ? accepted : { value, changed: false };
}

/** Repairs tried in order on a JSON container that does not parse; each yields `undefined` when it fails. */
const JSON_CONTAINER_TYPE_REPAIRS: ReadonlyArray<(text: string) => unknown> = [
	// LLMs sometimes emit literal newlines/tabs inside string content rather than `\n`/`\t`.
	text => parseRepairedJson(text, escapeRawControlsInJsonStrings),
	// A balanced container followed by trailing junk.
	tryParseLeadingJsonContainer,
	// A single-character bracket error near the end of the string.
	tryHealMalformedJson,
];

/** The first repair of a JSON container that does not parse whose result `expectedTypes` accepts, or `undefined`. */
function parseRepairedJsonContainerForTypes(
	text: string,
	expectedTypes: string[],
	depth: number,
): { value: unknown; changed: boolean } | undefined {
	for (const repair of JSON_CONTAINER_TYPE_REPAIRS) {
		const repaired = repair(text);
		if (repaired === undefined) continue;
		const accepted = acceptParsedJsonForTypes(repaired, text, expectedTypes, depth);
		if (accepted.changed) return accepted;
	}
	return undefined;
}

// ============================================================================
// JSON Pointer Utilities (RFC 6901)
// ============================================================================
//
// Internally we still address error locations using JSON Pointer syntax
// (e.g., `/foo/0/bar`).  These utilities let coercion read and write values at
// those paths regardless of whether the original error came from Zod or
// from JSON-Schema-shaped normalization.
// ============================================================================

/** Encode a structured Zod issue path as a JSON Pointer. */
function pathToPointer(path: ReadonlyArray<PropertyKey>): string {
	if (path.length === 0) return "";
	return `/${path.map(seg => String(seg).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

/**
 * Decodes a JSON Pointer string into path segments.
 * Handles RFC 6901 escape sequences: ~1 -> /, ~0 -> ~
 */
function decodeJsonPointer(pointer: string): string[] {
	if (!pointer) return [];
	return pointer
		.split("/")
		.slice(1) // Remove leading empty segment from initial "/"
		.map(segment => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * The child of `node` at `segment`: an integer index into an array or a key of
 * an object. `undefined` for any other node or a non-integer array segment.
 */
function childAtSegment(node: unknown, segment: string): unknown {
	if (Array.isArray(node)) {
		const index = Number(segment);
		return Number.isInteger(index) ? node[index] : undefined;
	}
	if (typeof node !== "object" || node === null) return undefined;
	return (node as Record<string, unknown>)[segment];
}

/** Follows the first `count` segments down from `root`; `undefined` once a step has no child. */
function descendSegments(root: unknown, segments: readonly string[], count: number): unknown {
	let current = root;
	for (let index = 0; index < count && current !== undefined; index += 1) {
		current = childAtSegment(current, segments[index]);
	}
	return current;
}

/**
 * Retrieves a value from a nested object/array structure using a JSON Pointer.
 * Returns undefined if the path doesn't exist or traversal fails.
 */
function getValueAtPointer(root: unknown, pointer: string): unknown {
	if (!pointer) return root;
	const segments = decodeJsonPointer(pointer);
	return descendSegments(root, segments, segments.length);
}

/**
 * Sets a value in a nested object/array structure using a JSON Pointer.
 * Mutates the structure in-place. Returns the root (possibly unchanged if
 * the path was invalid).
 */
function setValueAtPointer(root: unknown, pointer: string, value: unknown): unknown {
	if (!pointer) return value;
	const segments = decodeJsonPointer(pointer);
	const parent = descendSegments(root, segments, segments.length - 1);
	const key = segments[segments.length - 1];
	if (Array.isArray(parent)) {
		const index = Number(key);
		if (Number.isInteger(index)) parent[index] = value;
	} else if (typeof parent === "object" && parent !== null) {
		(parent as Record<string, unknown>)[key] = value;
	}
	return root;
}

/**
 * Returns a new structure with the key at `pointer` removed. Only the
 * containers along the path are shallow-cloned (`O(depth)` allocations);
 * every sibling subtree is shared with the input. Returns the input
 * reference unchanged when the pointer is empty, the path is invalid, or
 * the final key is absent — so callers can detect a no-op via identity.
 */
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

// ============================================================================
// JSON-Schema-driven normalization passes (LLM quirks).
// ============================================================================

/**
 * A schema-directed rewrite of one value. Every normalization pass returns
 * `value` itself when nothing changed, so a caller detects a no-op by identity
 * and an untouched argument tree costs no allocation.
 */
type SchemaValueRewrite<C> = (schema: unknown, value: unknown, context: C) => unknown;

type SchemaUnionRewrite<C> = (branches: unknown[], value: unknown, context: C) => unknown;

const EMPTY_LIST: readonly unknown[] = [];

/**
 * Applies `rewrite` to each property `properties` declares and `value` holds,
 * copying `value` at the first change.
 */
function rewriteDeclaredProperties<C>(
	properties: Record<string, unknown>,
	value: Record<string, unknown>,
	rewrite: SchemaValueRewrite<C>,
	context: C,
): Record<string, unknown> {
	let next = value;
	for (const key of Object.keys(properties)) {
		if (!(key in next)) continue;
		const current = next[key];
		const rewritten = rewrite(properties[key], current, context);
		if (rewritten === current) continue;
		if (next === value) next = { ...value };
		next[key] = rewritten;
	}
	return next;
}

/**
 * Applies `rewrite` to each element of `value`: element `i` under
 * `prefixItems[i]`, every later element under `itemSchema`. Elements past the
 * prefix are skipped when `itemSchema` is `undefined`. Copies `value` at the
 * first change.
 */
function rewriteArrayItems<C>(
	prefixItems: readonly unknown[],
	itemSchema: unknown,
	value: unknown[],
	rewrite: SchemaValueRewrite<C>,
	context: C,
): unknown[] {
	let next = value;
	for (let i = 0; i < value.length; i += 1) {
		if (i >= prefixItems.length && itemSchema === undefined) break;
		const rewritten = rewrite(i < prefixItems.length ? prefixItems[i] : itemSchema, value[i], context);
		if (rewritten === value[i]) continue;
		if (next === value) next = value.slice();
		next[i] = rewritten;
	}
	return next;
}

/**
 * Applies a rewrite through the combinator keywords of `schema`. The first of
 * the `anyOf` and `oneOf` union rewrites that changes `value` wins; otherwise
 * each `allOf` branch rewrites the value in turn.
 */
function rewriteThroughCombinators<C>(
	schema: Record<string, unknown>,
	value: unknown,
	rewriteUnion: SchemaUnionRewrite<C>,
	rewrite: SchemaValueRewrite<C>,
	context: C,
): unknown {
	if (Array.isArray(schema.anyOf)) {
		const rewritten = rewriteUnion(schema.anyOf, value, context);
		if (rewritten !== value) return rewritten;
	}
	if (Array.isArray(schema.oneOf)) {
		const rewritten = rewriteUnion(schema.oneOf, value, context);
		if (rewritten !== value) return rewritten;
	}
	if (!Array.isArray(schema.allOf)) return value;
	let next = value;
	for (const branch of schema.allOf) next = rewrite(branch, next, context);
	return next;
}

/**
 * Strips "no value" placeholders LLMs emit on optional properties (null,
 * `"null"`, and an empty string the property schema rejects), substitutes the
 * declared default for a nullish required property, and parses a numeric
 * string where a number-typed node expects one. `isRoot` marks the argument
 * object itself.
 */
function normalizeOptionalNullsForSchema(schema: unknown, value: unknown, isRoot: boolean): unknown {
	if (value === null || value === undefined) return value;
	if (schema === null || typeof schema !== "object") return value;
	const schemaObject = schema as Record<string, unknown>;

	const combined = rewriteThroughCombinators(
		schemaObject,
		value,
		normalizeOptionalNullsInUnion,
		normalizeOptionalNullsForSchema,
		isRoot,
	);
	if (combined !== value) return combined;

	if (Array.isArray(value)) {
		const itemSchema = schemaObject.items;
		if (!isRecord(itemSchema)) return value;
		return rewriteArrayItems(EMPTY_LIST, itemSchema, value, normalizeOptionalNullsForSchema, false);
	}

	// Coerce string → number/integer when the schema branch declares those types.
	// This fixes anyOf:[{type:"number"},{type:"null"}] (i.e. Optional<number>) where
	// the validator reports an "anyOf" error rather than a "type" error.
	const type = schemaObject.type;
	if ((type === "number" || type === "integer") && typeof value === "string") {
		return tryParseNumberString(value, [type]).value;
	}

	if (type !== "object" || typeof value !== "object") return value;
	const properties = schemaObject.properties;
	if (properties === null || typeof properties !== "object") return value;
	return normalizeOptionalNullProperties(
		schemaObject,
		properties as Record<string, unknown>,
		value as Record<string, unknown>,
		isRoot,
	);
}

/**
 * Rewrites `value` under the first union branch whose rewrite that branch
 * accepts, else under the first branch whose rewrite changed it.
 *
 * A value some branch already accepts is returned untouched: these passes
 * rescue values that would otherwise FAIL validation, and a passing value is
 * never mutated. Without this guard a `string | number` field (wire
 * `anyOf:[{type:"string"},{type:"number"}]`) receiving the quoted numeric
 * string "123" would coerce to the number 123 through the number branch even
 * though the string branch accepts "123" verbatim, corrupting the argument's
 * type and losing data outright ("007" -> 7). The intended coercion target,
 * `number | null` receiving "123", matches NEITHER branch raw, so the guard
 * leaves it to the rewrite.
 */
function normalizeOptionalNullsInUnion(branches: unknown[], value: unknown, isRoot: boolean): unknown {
	for (const branch of branches) {
		if (isJsonSchemaValueValid(branch, value)) return value;
	}
	let candidate = value;
	for (const branch of branches) {
		const normalized = normalizeOptionalNullsForSchema(branch, value, isRoot);
		if (normalized === value) continue;
		if (isJsonSchemaValueValid(branch, normalized)) return normalized;
		if (candidate === value) candidate = normalized;
	}
	return candidate;
}

/** The property rewrite that leaves the property as it is. */
const PROPERTY_UNCHANGED = Symbol("property unchanged");
/** The property rewrite that deletes the property. */
const PROPERTY_OMITTED = Symbol("property omitted");

function normalizeOptionalNullProperties(
	schema: Record<string, unknown>,
	properties: Record<string, unknown>,
	value: Record<string, unknown>,
	isRoot: boolean,
): Record<string, unknown> {
	const required: readonly unknown[] = Array.isArray(schema.required) ? schema.required : EMPTY_LIST;
	let next = value;
	for (const key of Object.keys(properties)) {
		if (!(key in next)) continue;
		const replacement = optionalNullPropertyReplacement(properties[key], next[key], required, key);
		if (replacement === PROPERTY_UNCHANGED) continue;
		if (next === value) next = { ...value };
		if (replacement === PROPERTY_OMITTED) delete next[key];
		else next[key] = replacement;
	}
	// At the ROOT level unknown null-valued keys stay: Zod-emitted wire schemas
	// always set `additionalProperties: false`, but the post-validation
	// `preserveUnknownRootFields` pass re-attaches root extras so callers can
	// observe (and reject) hallucinated fields. Stripping here would erase the
	// field before that snapshot, hiding the rejection signal.
	if (isRoot || schema.additionalProperties !== false) return next;
	return dropUndeclaredNullKeys(properties, next, value);
}

/**
 * What property `key` becomes. LLMs emit null, `"null"` and empty strings to
 * mean "no value": on an optional property such a placeholder is omitted (an
 * empty string only when the property schema rejects it), and a nullish
 * required property takes a clone of its declared default, so the call is not
 * rejected and later mutations never reach the schema. A default substitution
 * is a change even when the clone equals the placeholder.
 */
function optionalNullPropertyReplacement(
	propertySchema: unknown,
	current: unknown,
	required: readonly unknown[],
	key: string,
): unknown {
	const nullish = current === null || current === "null";
	if (
		(nullish || current === "") &&
		!required.includes(key) &&
		(nullish || !isJsonSchemaValueValid(propertySchema, current))
	) {
		return PROPERTY_OMITTED;
	}
	if (nullish && typeof propertySchema === "object" && propertySchema !== null && "default" in propertySchema) {
		return structuredCloneJSON(propertySchema.default);
	}
	const normalized = normalizeOptionalNullsForSchema(propertySchema, current, false);
	return normalized === current ? PROPERTY_UNCHANGED : normalized;
}

/**
 * Strips keys `properties` does not declare whose value is null or `"null"`,
 * for an object schema that forbids extras. LLMs sometimes hallucinate verbs
 * alongside valid ones (`split: null`, `original: null`); rejecting the whole
 * call wastes a turn. Undeclared keys with any other value stay, so a genuine
 * schema mistake still surfaces as a validation error. `next` is `original`
 * or its copy.
 */
function dropUndeclaredNullKeys(
	properties: Record<string, unknown>,
	next: Record<string, unknown>,
	original: Record<string, unknown>,
): Record<string, unknown> {
	let out = next;
	for (const key of Object.keys(next)) {
		if (Object.hasOwn(properties, key)) continue;
		const entry = next[key];
		if (entry !== null && entry !== "null") continue;
		if (out === original) out = { ...original };
		delete out[key];
	}
	return out;
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

/** The schema a `$ref` resolves against, and the refs already followed on the current path. */
interface SchemaRefScope {
	root: unknown;
	refs: ReadonlySet<string>;
}

const NO_REFS: ReadonlySet<string> = new Set();

/**
 * Trims surrounding whitespace from a string the schema accepts only trimmed:
 * an `enum` member or the `const` value. Follows local `$ref`s, each at most
 * once per path.
 */
function normalizeEnumStringWhitespace(schema: unknown, value: unknown, scope: SchemaRefScope): unknown {
	if (value === null || value === undefined) return value;
	if (schema === null || typeof schema !== "object") return value;
	const schemaObject = schema as Record<string, unknown>;
	if (typeof schemaObject.$ref === "string") return normalizeEnumStringsThroughRef(schemaObject.$ref, value, scope);

	const combined = rewriteThroughCombinators(
		schemaObject,
		value,
		normalizeEnumStringsInUnion,
		normalizeEnumStringWhitespace,
		scope,
	);
	if (combined !== value) return combined;

	if (typeof value === "string") return trimEnumString(schemaObject, value);
	if (Array.isArray(value)) {
		const prefixItems = Array.isArray(schemaObject.prefixItems) ? schemaObject.prefixItems : EMPTY_LIST;
		const itemSchema = isRecord(schemaObject.items) ? schemaObject.items : undefined;
		return rewriteArrayItems(prefixItems, itemSchema, value, normalizeEnumStringWhitespace, scope);
	}
	if (typeof value !== "object") return value;
	const properties = schemaObject.properties;
	if (!properties || typeof properties !== "object") return value;
	return rewriteDeclaredProperties(
		properties as Record<string, unknown>,
		value as Record<string, unknown>,
		normalizeEnumStringWhitespace,
		scope,
	);
}

function normalizeEnumStringsThroughRef(ref: string, value: unknown, scope: SchemaRefScope): unknown {
	if (scope.refs.has(ref)) return value;
	const resolved = resolveLocalJsonSchemaRef(scope.root, ref);
	if (resolved === undefined) return value;
	return normalizeEnumStringWhitespace(resolved, value, { root: scope.root, refs: new Set(scope.refs).add(ref) });
}

/** Rewrites `value` under the first union branch that accepts the rewrite, unless a branch accepts it already. */
function normalizeEnumStringsInUnion(branches: unknown[], value: unknown, scope: SchemaRefScope): unknown {
	for (const branch of branches) {
		if (enumBranchAccepts(branch, value, scope)) return value;
	}
	for (const branch of branches) {
		const normalized = normalizeEnumStringWhitespace(branch, value, scope);
		if (normalized !== value && enumBranchAccepts(branch, normalized, scope)) return normalized;
	}
	return value;
}

/** Validates `candidate` against `branch`, resolving a `$ref` branch not yet followed on this path. */
function enumBranchAccepts(branch: unknown, candidate: unknown, scope: SchemaRefScope): boolean {
	if (branch !== null && typeof branch === "object") {
		const ref = (branch as Record<string, unknown>).$ref;
		if (typeof ref === "string" && !scope.refs.has(ref)) {
			const resolved = resolveLocalJsonSchemaRef(scope.root, ref);
			if (resolved !== undefined) return isJsonSchemaValueValid(resolved, candidate);
		}
	}
	return isJsonSchemaValueValid(branch, candidate);
}

function trimEnumString(schema: Record<string, unknown>, value: string): string {
	const enumValues = schema.enum;
	const constValue = schema.const;
	if (!Array.isArray(enumValues) && typeof constValue !== "string") return value;
	const trimmed = value.trim();
	if (trimmed === value) return value;
	if (Array.isArray(enumValues) && !enumValues.includes(value) && enumValues.includes(trimmed)) return trimmed;
	return trimmed === constValue ? trimmed : value;
}

// ============================================================================
// Identifier-string trailing-whitespace normalization (LLM quirk).
// ============================================================================
//
// LLMs sometimes emit tool arguments with a trailing newline dangling off a
// short identifier — a path, URL, or a display label like `title`. These
// values are never legitimately terminated by line breaks, so we strip trailing
// line terminators from string values on the well-known keys below before the
// tool ever sees them. Content-carrying properties (`content`, `input`, `body`,
// `text`, `command`, `code`) are intentionally not traversed or trimmed so
// genuine trailing whitespace survives on writes, patches, shell commands, and
// eval snippets.
// ============================================================================

/**
 * Property names whose values are treated as short identifiers — filesystem
 * paths, URLs, URIs, or display labels. The trim only fires on strings sitting
 * under one of these keys, so `path: "docs/report "` still targets the file
 * whose name ends in a space.
 */
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
	if (typeof input === "string") return trimTrailingLineTerminators(input);
	if (!Array.isArray(input)) return input;
	let next = input;
	for (let i = 0; i < input.length; i += 1) {
		const item = input[i];
		if (typeof item !== "string") continue;
		const trimmed = trimTrailingLineTerminators(item);
		if (trimmed === item) continue;
		if (next === input) next = input.slice();
		next[i] = trimmed;
	}
	return next;
}

/**
 * Depth ceiling for the two schema-agnostic value walks below and for the
 * error echo. Real tool arguments are a handful of levels deep; a payload that
 * nests past this is malformed or hostile, and recursing it overflowed the
 * stack, so a clean `ValidationError` escaped the pipeline as a `RangeError`
 * instead. The depth does arrive intact: `JSON.parse` accepts 100k levels of
 * nesting without complaint. Past the ceiling a subtree is left exactly as
 * received rather than dropped, so no argument is ever lost to the guard.
 */
const MAX_VALUE_WALK_DEPTH = 64;

type ValueWalk = (value: unknown, depth: number) => unknown;

/**
 * Applies `walk` to every element of `value` one level deeper, copying the
 * array only once the first element changes so an untouched array is returned
 * by identity. Shared by the two schema-agnostic walks below.
 */
function walkArrayElements(value: unknown[], depth: number, walk: ValueWalk): unknown[] {
	let next = value;
	for (let i = 0; i < value.length; i += 1) {
		const normalized = walk(value[i], depth + 1);
		if (normalized === value[i]) continue;
		if (next === value) next = value.slice();
		next[i] = normalized;
	}
	return next;
}

/**
 * Recursively strip trailing line terminators from string values whose property
 * key matches {@link IDENTIFIER_STRING_KEYS}. Runs by property name only
 * (schema-agnostic) so it fires uniformly across Zod, ArkType, and plain JSON
 * Schema tools while preserving nested payloads under content-carrying keys.
 */
function normalizeIdentifierStringWhitespace(value: unknown, depth: number): unknown {
	if (depth >= MAX_VALUE_WALK_DEPTH) return value;
	if (Array.isArray(value)) return walkArrayElements(value, depth, normalizeIdentifierStringWhitespace);
	if (value === null || typeof value !== "object") return value;

	const source = value as Record<string, unknown>;
	let out = source;
	for (const key of Object.keys(source)) {
		if (CONTENT_CARRYING_KEYS.has(key)) continue;
		const entry = source[key];
		const leaf = IDENTIFIER_STRING_KEYS.has(key) ? trimIdentifierStringLeaf(entry) : entry;
		const nextEntry = normalizeIdentifierStringWhitespace(leaf, depth + 1);
		if (nextEntry === entry) continue;
		if (out === source) out = { ...source };
		out[key] = nextEntry;
	}
	return out;
}

// ============================================================================
// Double-encoded object-key normalization (LLM quirk).
// ============================================================================
//
// LLMs occasionally serialize an object key one time too many, so the property
// NAME arrives as the JSON encoding of the real name — literal quote characters
// and all (e.g. `{ "\"op\"": "done" }` decodes to the JS key `"op"`). The
// schema never matches such a key, so it reads as an unrecognized extra and is
// dropped by the unrecognized-key repair, later surfacing as a spurious
// missing-required error. We walk the whole value (arrays + nested objects)
// and rename any key that is itself the JSON encoding of a plain string back to
// that string.
// ============================================================================

/** Max layers of accidental JSON-encoding to peel off a single object key. */
const MAX_KEY_DECODE_DEPTH = 3;

/**
 * If `key` is the JSON encoding of a plain string (quote-wrapped and
 * `JSON.parse`s to a string), return the decoded string; otherwise null. Peels
 * up to {@link MAX_KEY_DECODE_DEPTH} nested encodings so multiply-encoded keys
 * collapse in one pass. Conservative: any key that is not a quote-wrapped JSON
 * string literal is left untouched.
 */
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

/**
 * Recursively unwrap object keys that were accidentally JSON-encoded an extra
 * time. Schema-agnostic by design: such keys are dropped before any schema pass
 * can map them, so this runs first. A key is only renamed when the decoded name
 * differs and does not already exist on the same object — renaming would
 * otherwise clobber a sibling and silently lose data.
 */
function normalizeDoubleEncodedKeys(value: unknown, depth: number): unknown {
	if (depth >= MAX_VALUE_WALK_DEPTH) return value;
	if (Array.isArray(value)) return walkArrayElements(value, depth, normalizeDoubleEncodedKeys);
	if (value === null || typeof value !== "object") return value;

	const source = value as Record<string, unknown>;
	const keys = Object.keys(source);
	// Built only at the first renamed key or changed child; until then the
	// result is `source` itself.
	let out: Record<string, unknown> | undefined;
	for (let i = 0; i < keys.length; i += 1) {
		const key = keys[i];
		const entry = source[key];
		const child = normalizeDoubleEncodedKeys(entry, depth + 1);
		const targetKey = decodedKeyTarget(key, source, out);
		if (out === undefined) {
			if (targetKey === key && child === entry) continue;
			out = copyLeadingEntries(source, keys, i);
		}
		// `defineProperty` so a decoded `__proto__` key becomes an own property
		// instead of mutating the result object's prototype.
		Object.defineProperty(out, targetKey, { value: child, writable: true, enumerable: true, configurable: true });
	}
	return out ?? value;
}

/**
 * The name `key` takes in the result: its decoded form when that form names no
 * key of `source` and none already in the result `out`, else `key`. Until `out`
 * exists the result holds only keys of `source`.
 */
function decodedKeyTarget(
	key: string,
	source: Record<string, unknown>,
	out: Record<string, unknown> | undefined,
): string {
	const decoded = decodeDoubleEncodedKey(key);
	// `Object.hasOwn` (not `in`) so a decoded `constructor`/`toString` is not
	// mistaken for a collision via the prototype chain.
	if (decoded === null || decoded === key || Object.hasOwn(source, decoded)) return key;
	return out !== undefined && Object.hasOwn(out, decoded) ? key : decoded;
}

/** A new object holding the first `count` of `keys` from `source` as own data properties. */
function copyLeadingEntries(
	source: Record<string, unknown>,
	keys: readonly string[],
	count: number,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (let i = 0; i < count; i += 1) {
		Object.defineProperty(out, keys[i], {
			value: source[keys[i]],
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
	return out;
}

// ============================================================================
// String-encoded array coercion for union(string, array) schemas.
// ============================================================================

/**
 * Detects whether a schema node accepts BOTH the `string` and `array` JSON
 * Schema types. Recognizes:
 *   - `{ "type": ["string", "array"] }` (multi-type),
 *   - `{ "anyOf": [...] }` / `{ "oneOf": [...] }` with at least one string
 *     branch and one array branch.
 */
function schemaAcceptsStringAndArray(schema: Record<string, unknown>): boolean {
	if (Array.isArray(schema.type) && schema.type.includes("string") && schema.type.includes("array")) {
		return true;
	}
	return unionHasStringAndArrayBranches(schema.anyOf) || unionHasStringAndArrayBranches(schema.oneOf);
}

function unionHasStringAndArrayBranches(branches: unknown): boolean {
	if (!Array.isArray(branches)) return false;
	let hasString = false;
	let hasArray = false;
	for (const branch of branches) {
		if (!branch || typeof branch !== "object") continue;
		const branchType = (branch as Record<string, unknown>).type;
		hasString ||= typeDeclares(branchType, "string");
		hasArray ||= typeDeclares(branchType, "array");
		if (hasString && hasArray) return true;
	}
	return false;
}

/** Whether a JSON Schema `type` keyword names `name`, alone or in a type list. */
function typeDeclares(type: unknown, name: string): boolean {
	return type === name || (Array.isArray(type) && type.includes(name));
}

function schemaNodeAcceptsArray(schema: unknown): schema is Record<string, unknown> {
	if (!schema || typeof schema !== "object") return false;
	return typeDeclares((schema as Record<string, unknown>).type, "array");
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

/**
 * Pre-validation normalization: when a schema field accepts BOTH `string` and
 * `array`, providers that double-serialize tool arguments (e.g. Z.AI / GLM)
 * deliver array values as JSON-encoded strings like `'["a","b"]'`. Zod's
 * `union([string, array])` happily accepts that string against the string
 * branch, so the type-error driven coercion in {@link coerceArgsFromIssues}
 * never fires, and downstream tools treat the literal `["a","b"]` as a path
 * (silently producing zero matches or glob parse errors).
 *
 * Walk the schema, through `anyOf`, `oneOf` and `allOf`; when both shapes are
 * accepted AND the incoming value is a JSON-array-shaped string, substitute the
 * parsed array only if it validates against the schema's array branch.
 * Conservative: array-shaped strings like `"[1]"` stay on the string branch
 * when the array branch is `string[]`.
 */
function normalizeStringEncodedArrayUnions(schema: unknown, value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (schema === null || typeof schema !== "object") return value;
	const schemaObject = schema as Record<string, unknown>;

	if (typeof value === "string" && schemaAcceptsStringAndArray(schemaObject)) {
		return parseStringEncodedArray(schemaObject, value);
	}
	const combined = rewriteThroughCombinators(
		schemaObject,
		value,
		parseStringEncodedArraysInUnion,
		normalizeStringEncodedArrayUnions,
		undefined,
	);
	if (combined !== value) return combined;
	if (Array.isArray(value)) {
		const itemSchema = schemaObject.items;
		if (!isRecord(itemSchema)) return value;
		return rewriteArrayItems(EMPTY_LIST, itemSchema, value, normalizeStringEncodedArrayUnions, undefined);
	}
	if (schemaObject.type !== "object" || typeof value !== "object") return value;
	const properties = schemaObject.properties;
	if (!properties || typeof properties !== "object") return value;
	return rewriteDeclaredProperties(
		properties as Record<string, unknown>,
		value as Record<string, unknown>,
		normalizeStringEncodedArrayUnions,
		undefined,
	);
}

/**
 * Rewrites `value` under the first union branch that accepts the rewrite. The
 * raw value already passes: a JSON-array string is a valid string, so unlike
 * the other union rewrites a branch accepting `value` does not stop the rewrite.
 */
function parseStringEncodedArraysInUnion(branches: unknown[], value: unknown): unknown {
	for (const branch of branches) {
		const rewritten = normalizeStringEncodedArrayUnions(branch, value);
		if (rewritten !== value && isJsonSchemaValueValid(branch, rewritten)) return rewritten;
	}
	return value;
}

/** The array a JSON-array-shaped `value` encodes, when the array branch of `schema` accepts it; else `value`. */
function parseStringEncodedArray(schema: Record<string, unknown>, value: string): unknown {
	const trimmed = value.trim();
	if (!trimmed.startsWith("[")) return value;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		// Not valid JSON — leave the string alone for the validator to handle.
		return value;
	}
	if (!Array.isArray(parsed)) return value;
	// Unwrap any double-encoded object keys inside the parsed array before the
	// branch-match check; otherwise an `array<object>` branch fails to validate
	// and the value silently stays on the string branch.
	const candidate = normalizeDoubleEncodedKeys(parsed, 0) as unknown[];
	return parsedArrayMatchesArrayBranch(schema, candidate) ? candidate : value;
}

/**
 * Name of the sole property when a schema declares exactly one required string
 * field, else `undefined`. Recognizes the closed single-argument tool shape
 * (`{ type: "object", properties: { X: { type: "string" } }, required: ["X"] }`).
 */
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

/**
 * LLM-quirk repair for single-argument tools. When a tool declares exactly one
 * property — a required string — some providers deliver the payload under a
 * different key (e.g. the `edit` tool's patch arriving as `input`/`_input`, or
 * any single-string tool whose argument the model mislabels). When the declared
 * key is absent but another field holds a string, adopt the first such string
 * as the declared key so the call validates instead of failing with "<key> was
 * missing". A present-but-wrong-type value is left alone so its real type error
 * still surfaces.
 */
function normalizeSingleStringField(schema: unknown, value: unknown): unknown {
	const key = singleRequiredStringKey(schema);
	if (key === undefined || !isRecord(value) || value[key] !== undefined) return value;
	for (const candidate in value) {
		if (candidate === key || !Object.hasOwn(value, candidate)) continue;
		const candidateValue = value[candidate];
		if (typeof candidateValue !== "string") continue;
		const next = { ...value, [key]: candidateValue };
		delete next[candidate];
		return next;
	}
	return value;
}

// ============================================================================
// Zod issue → coercion bridge
// ============================================================================

interface FlatIssue {
	keyword: "type" | "unrecognized" | "other";
	instancePath: string;
	expectedTypes: string[];
	unionBranch: boolean;
}

/**
 * Translate the Zod expected-type marker into the JSON-Schema type name our
 * coercion helpers already understand.
 */
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

/**
 * Flatten Zod issues into a list of (path, expected-types) records suitable
 * for the coercion pass. Recurses through `invalid_union` so each inner
 * candidate produces independent coercion attempts.
 */
function flattenIssues(issues: ReadonlyArray<ZodIssue>): FlatIssue[] {
	const out: FlatIssue[] = [];
	for (const issue of issues) flattenIssue(issue, [], false, out);
	return out;
}

function flattenIssue(
	issue: ZodIssue,
	prefix: ReadonlyArray<PropertyKey>,
	unionBranch: boolean,
	out: FlatIssue[],
): void {
	const fullPath = prefix.length === 0 ? issue.path : prefix.concat(issue.path);
	switch (issue.code) {
		case "invalid_type": {
			const mapped = mapZodExpectedToJsonSchemaType(issue.expected);
			if (!mapped) break;
			out.push({ keyword: "type", instancePath: pathToPointer(fullPath), expectedTypes: [mapped], unionBranch });
			return;
		}
		case "unrecognized_keys":
			for (const key of issue.keys) {
				out.push({
					keyword: "unrecognized",
					instancePath: pathToPointer(fullPath.concat([key])),
					expectedTypes: [],
					unionBranch,
				});
			}
			return;
		case "invalid_union":
			// A union-branch issue only competes with a sibling branch when it
			// sits at the union node's own path. Issues whose own path is
			// non-empty live on a deeper field that an already-identified
			// branch owns, so the singleton-array repair should still apply.
			for (const branch of issue.errors) {
				for (const child of branch) flattenIssue(child, fullPath, child.path.length === 0, out);
			}
			return;
		default:
			break;
	}
	out.push({ keyword: "other", instancePath: pathToPointer(fullPath), expectedTypes: [], unionBranch });
}

/**
 * Repair issues raised by the validator before we surface them to the caller.
 *
 * Two kinds of repair are applied:
 *  - **type**: when a value has a common LLM-produced shape mismatch, rewrite
 *    it only in the direction requested by the schema: parse JSON strings,
 *    accept boolean spellings, stringify non-null values for string fields,
 *    map booleans to numeric 0/1, and wrap singleton array values for non-union
 *    array expectations.
 *  - **unrecognized**: when a strict object received an extra key (Zod's
 *    `unrecognized_keys` or JSON Schema's `additionalProperties: false`),
 *    drop that key so re-validation succeeds. This effectively coerces every
 *    object schema to loose semantics recursively without rebuilding the
 *    underlying Zod tree.
 *
 * The function is safe and conservative:
 *   - Only processes "type" and "unrecognized" issues
 *   - Only attempts schema-directed coercions for the expected type
 *   - Only wraps singleton array values for non-union type expectations
 *   - Clones the args object before mutation (copy-on-write)
 */
function coerceArgsFromIssues(args: unknown, issues: FlatIssue[]): { value: unknown; changed: boolean } {
	if (issues.length === 0) return { value: args, changed: false };

	let changed = false;
	// Tracks whether `nextArgs` is a fully owned deep copy (safe to mutate
	// leaves). The unrecognized-key path uses path-shallow immutable updates
	// and does NOT require ownership, so we only pay for the deep clone when
	// a type coercion actually needs to write into a leaf.
	let owned = false;
	let nextArgs: unknown = args;

	for (const issue of issues) {
		if (issue.keyword === "unrecognized") {
			const previous = nextArgs;
			nextArgs = deleteValueAtPointer(nextArgs, issue.instancePath);
			if (nextArgs !== previous) changed = true;
			continue;
		}
		if (issue.keyword !== "type" || issue.expectedTypes.length === 0) continue;

		const coercedValue = coerceIssueValue(getValueAtPointer(nextArgs, issue.instancePath), issue);
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

/**
 * The value a `type` issue rewrites `currentValue` to, or `undefined` when no
 * coercion applies. A lone value for a non-union `array` expectation is wrapped
 * in an array.
 */
function coerceIssueValue(currentValue: unknown, issue: FlatIssue): unknown {
	const result = tryCoerceForExpectedTypes(currentValue, issue.expectedTypes);
	if (result.changed && result.value !== undefined) return result.value;
	if (!issue.expectedTypes.includes("array") || issue.unionBranch) return undefined;
	return wrapAsSingletonArray(currentValue);
}

/**
 * Wraps a lone non-array value in an array. A string holding a JSON object is
 * parsed first; a string that looks like a JSON container and does not parse
 * as an object is left alone.
 */
function wrapAsSingletonArray(value: unknown): unknown[] | undefined {
	if (value === undefined || Array.isArray(value)) return undefined;
	if (typeof value !== "string") return [value];
	const objectCoercion = tryParseJsonForTypes(value, ["object"]);
	if (objectCoercion.changed) return [objectCoercion.value];
	return looksLikeJsonContainerString(value) ? undefined : [value];
}

// ============================================================================
// Public API
// ============================================================================

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

/**
 * Cache the validation context derived from a tool's parameters schema.
 * Keyed by the parameters object identity (stable across tool registrations),
 * via {@link stamp} so callable ArkType schemas — and any frozen host — degrade
 * to recompute-on-call instead of throwing on assignment.
 */
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
		// A `.narrow()`/cross-field failure can have ArkType reject while the wire
		// JSON (its predicate dropped by the toJsonSchema fallback) accepts — then
		// there are no json issues to coerce and we fall through to the formatted
		// error built from ArkType's own messages.
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

// In-band `arg_key`/`arg_value` tool-call syntax that leaks into native
// tool-call arguments when a provider parses the model's owned format
// server-side and the model botches an `</arg_value>` closer.
//
// The five tags come from the dialect layer's tag owner, not from local copies. This module is not a dialect
// and must not depend on one, which is exactly why it had its own `SPILL_*` copies: `./dialect/rendering.ts`
// would have dragged the coercion helpers and the dialect types behind a string. `./dialect/wire-tags` imports
// nothing, so the repair now keys on the same bytes the GLM scanner parses instead of on a second spelling of
// them that no test compared.
/** Plausible spilled argument names; anything else is ordinary content. */
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

/** Whether a well-formed `<arg_key>NAME</arg_key>…<arg_value>` pair starts at `at`. */
function isSpillPairStart(text: string, at: number): boolean {
	if (!text.startsWith(ARG_KEY_OPEN, at)) return false;
	const keyStart = at + ARG_KEY_OPEN.length;
	const keyEnd = text.indexOf(ARG_KEY_CLOSE, keyStart);
	if (keyEnd === -1 || !SPILL_KEY_PATTERN.test(text.slice(keyStart, keyEnd))) return false;
	const valueAt = skipSpillWhitespace(text, keyEnd + ARG_KEY_CLOSE.length);
	return text.startsWith(ARG_VALUE_OPEN, valueAt);
}

/**
 * Finds where a spilled `<arg_value>` body ends: the legit closer, a
 * mistyped `</arg_key>` closer (validated by its follow-up), the start of the
 * next pair when the closer is missing entirely, or end of input (the
 * provider's parser consumed the terminating closer).
 */
function findSpillValueEnd(text: string, from: number): { end: number; next: number } {
	const close = text.indexOf(ARG_VALUE_CLOSE, from);
	const limit = close === -1 ? text.length : close;
	const wrong = findMistypedValueCloser(text, from, limit);
	const pair = findInlinedPairStart(text, from, wrong === -1 ? limit : wrong);
	if (pair !== -1) {
		let end = pair;
		while (end > from && " \n\t\r".includes(text[end - 1]!)) end--;
		return { end, next: pair };
	}
	if (wrong !== -1) return { end: wrong, next: wrong + ARG_KEY_CLOSE.length };
	if (close !== -1) return { end: close, next: close + ARG_VALUE_CLOSE.length };
	return { end: text.length, next: text.length };
}

/**
 * The first `</arg_key>` before `limit` that the end of input, a next
 * `<arg_key>` or `</tool_call>` follows, or -1. Any other `</arg_key>` is
 * value content.
 */
function findMistypedValueCloser(text: string, from: number, limit: number): number {
	for (let at = text.indexOf(ARG_KEY_CLOSE, from); at !== -1 && at < limit; at = text.indexOf(ARG_KEY_CLOSE, at + 1)) {
		const follow = skipSpillWhitespace(text, at + ARG_KEY_CLOSE.length);
		if (follow >= text.length || text.startsWith(ARG_KEY_OPEN, follow) || text.startsWith(TOOL_CALL_CLOSE, follow)) {
			return at;
		}
	}
	return -1;
}

/** The first `<arg_key>` before `limit` that opens a well-formed key/value pair, or -1. */
function findInlinedPairStart(text: string, from: number, limit: number): number {
	for (let at = text.indexOf(ARG_KEY_OPEN, from); at !== -1 && at < limit; at = text.indexOf(ARG_KEY_OPEN, at + 1)) {
		if (isSpillPairStart(text, at)) return at;
	}
	return -1;
}

/**
 * Strictly parses a spill tail as `<arg_key>…</arg_key><arg_value>…` pairs,
 * tolerating a trailing `</tool_call>`. Returns null on any shape that is not
 * pure pair syntax — the caller then treats the text as ordinary content.
 */
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

/**
 * Splits a contaminated string value at the earliest spill boundary: a
 * mistyped `</arg_key>` closer or an inlined next pair. Returns null when no
 * boundary yields a cleanly parseable tail.
 */
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

/**
 * Repairs native tool-call arguments contaminated by in-band
 * `<arg_key>`/`<arg_value>` syntax. Some providers parse owned tool-call
 * formats server-side; when the model mistypes or omits an `</arg_value>`
 * closer, every following pair is swallowed into one string argument, e.g.
 * `op: "done</arg_key>\n<arg_key>task</arg_key>\n<arg_value>…"`. Truncates
 * each contaminated top-level string at its spill boundary and restores the
 * swallowed pairs as sibling arguments (never overwriting existing keys).
 *
 * Only invoked after validation and every coercion pass fail, so valid calls
 * whose string content legitimately contains tag-like text are never touched.
 */
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

/**
 * Finds a tool by name and validates the tool call arguments against its schema.
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): ToolCall["arguments"] {
	const tool = tools.find(t => t.name === toolCall.name);
	if (!tool) {
		// The active set is right here, and it is the whole remedy for the model.
		throw new AIError.ToolNotFoundError(
			toolCall.name,
			tools.map(t => t.name),
		);
	}
	return validateToolArguments(tool, toolCall);
}

/** Cap per-field string lengths when embedding received args in an error message. */
const MAX_ERROR_ARG_STRING_LENGTH = 256;
/**
 * Array elements echoed verbatim before the tail is replaced by a count.
 *
 * A per-string cap alone does not bound a container: eight short todo items
 * are each far under {@link MAX_ERROR_ARG_STRING_LENGTH}, so the whole array
 * used to round-trip into the transcript on every retry. One element is
 * enough to show the shape the model actually sent.
 */
const MAX_ERROR_ARG_ARRAY_SAMPLE = 1;
/** Object keys echoed before the rest is replaced by a count. */
const MAX_ERROR_ARG_OBJECT_KEYS = 8;
/** Hard ceiling on the serialized received-arguments block, after per-node bounding. */
const MAX_ERROR_ARGS_JSON_LENGTH = 600;
/** Cap on the raw payload echoed when the arguments were not parseable JSON. */
const MAX_ERROR_RAW_JSON_LENGTH = 512;
/**
 * Nesting depth echoed before a subtree is replaced by a marker. Indentation
 * alone makes a deep echo mostly whitespace, and the walk is recursive, so this
 * bounds the stack as well as the bytes.
 */
const MAX_ERROR_ARG_DEPTH = 8;
/**
 * Ceiling on the joined issue lines. A validator names the rejected value
 * inside the message (`op must be "init" | … (was "xxx…")`), so a single
 * oversized field pushes the issue block past every per-argument cap: a 50k
 * enum value produced a 50,437-character failure that the model re-read on
 * every retry. Bounded separately from the echo so neither half can crowd the
 * other out of the message.
 */
const MAX_ERROR_ISSUES_LENGTH = 400;
/**
 * Ceiling on one issue line before its accepted-values hint is appended. The
 * validator quotes the rejected value at the end of the line, and a closed set
 * the validator describes instead of listing (ArkType jitless reports a
 * described literal union by its description) is named only by the hint that
 * follows that quote. Unbounded, a 50k rejected value pushed the hint past
 * {@link MAX_ERROR_ISSUES_LENGTH}, so the failure named no legal value.
 */
const MAX_ERROR_ISSUE_LINE_LENGTH = 256;
/**
 * Hard ceiling on the entire validation failure. The per-part caps above are
 * expected to keep the message well under it; this exists because per-part caps
 * do not compose into a whole-message bound on their own, and the whole message
 * is what lands in the transcript.
 */
const MAX_ERROR_MESSAGE_LENGTH = 1200;

/**
 * Cut `text` so the RESULT is at most `max` characters, the "what was dropped"
 * note included. Counting the note inside the budget is what makes `max` a
 * ceiling on the string a caller actually emits, so nested calls compose: the
 * outer bound holds whatever the inner ones produced. The note names the
 * dropped count, so its own width depends on the cut; the loop settles that.
 * Every `max` here is far wider than the note, which is the one case that
 * could not be honored (a bare note still has to be emitted).
 */
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

/** An echo that carries no information beyond "there was nothing here". */
function isEmptyEcho(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === "object") return Object.keys(value).length === 0;
	return false;
}

/**
 * Collect the literal values a schema node accepts, so a rejection can name
 * them. Sourced from the tool's own schema rather than a hardcoded list, which
 * would silently drift the first time an operation is added or renamed.
 */
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
		// A branch with no literals (a bare `string`) means the field is not a
		// closed set, so naming a partial list would mislead.
		if (!values) return undefined;
		for (let vi = 0; vi < values.length; vi++) collected.push(values[vi]!);
	}
	return collected.length > 0 ? collected : undefined;
}

/** Walk a `formatIssuePath` path (`op`, `list/0/items`) down a JSON schema. */
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

/**
 * Append the accepted values to each issue line whose field is a closed set.
 * Without this a rejection reads `op ... (was missing)` and the model has no
 * way to invent a legal value, so the retry it is then told to make cannot
 * succeed.
 */
function annotateIssuesWithAcceptedValues(json: unknown, messages: readonly string[]): string[] {
	const annotated = messages.map(line => {
		const message = boundErrorText(line, MAX_ERROR_ISSUE_LINE_LENGTH);
		const match = /^\s*-\s([^:]+):\s/.exec(message);
		if (!match) return { message, namesTheSet: false };
		const values = schemaLiteralValues(schemaNodeAtIssuePath(json, match[1]));
		if (!values || values.length === 0) return { message, namesTheSet: false };
		// Some validators (arktype) already spell the set out. Re-listing it would
		// double the line for no gain, so annotate only what is actually absent.
		// Spelled out means a standalone token: raw substring matching reads the
		// boilerplate "must be one of the allowed enum values" as already listing
		// `a` (inside "allowed") and `b` (inside "be"), so every set whose values
		// are all short enough to hide inside words silently lost its hint.
		const tokens = new Set(message.split(/[^A-Za-z0-9_$-]+/).filter(token => token.length > 0));
		if (values.every(value => tokens.has(value))) return { message, namesTheSet: true };
		return { message: `${message} (accepted: ${values.join(" | ")})`, namesTheSet: true };
	});
	// boundErrorText keeps the head and issues arrive in schema-property order,
	// so a wide rejection spent the whole budget on generic "is required" lines
	// and cut the one line that names a legal value. The set-naming lines are
	// the actionable ones; they lead, stably.
	return annotated
		.filter(line => line.namesTheSet)
		.concat(annotated.filter(line => !line.namesTheSet))
		.map(line => line.message);
}

/** One pre-validation rewrite of the arguments; returns `value` itself when nothing changed. */
type SchemaNormalizationPass = (json: Record<string, unknown>, value: unknown) => unknown;

/**
 * The schema-directed normalizations that precede every validation attempt,
 * in the order they run.
 */
const SCHEMA_NORMALIZATION_PASSES: readonly SchemaNormalizationPass[] = [
	// Unwrap accidentally double-JSON-encoded object keys before any schema
	// pass. LLMs sometimes emit `{ "\"op\"": "done" }`, so the property name
	// arrives quote-wrapped; left alone it reads as an unrecognized key, gets
	// dropped by the coercion repair, and re-surfaces as a missing-required
	// error. Running first means every later pass sees the corrected names.
	(_json, value) => normalizeDoubleEncodedKeys(value, 0),
	// Strip null/string "null" from optional fields, strip optional empty
	// strings only when their property schema rejects the explicit value, and
	// substitute defaults. Handles LLM outputting placeholders for "no value"
	// even when validation would otherwise pass.
	(json, value) => normalizeOptionalNullsForSchema(json, value, true),
	(json, value) => normalizeEnumStringWhitespace(json, value, { root: json, refs: NO_REFS }),
	// Strip trailing whitespace from string values on well-known
	// identifier-like property names (paths, URLs, titles). Some models tack
	// a newline onto a short-identifier arg from stream artifacts; downstream
	// tools then either fail to stat the target or annotate a "corrected
	// from" hint the model misreads as tool corruption.
	(_json, value) => normalizeIdentifierStringWhitespace(value, 0),
	// Then re-shape JSON-stringified arrays whose schema accepts both string
	// and array (e.g. `paths: string | string[]`). Without this, zod accepts
	// the literal `'["a","b"]'` as a string and downstream tools treat it as
	// a single path with embedded glob brackets — silent zero results.
	normalizeStringEncodedArrayUnions,
	// The unwrapped arrays can hold identifier strings of their own.
	(_json, value) => normalizeIdentifierStringWhitespace(value, 0),
	// Single-argument tools (e.g. `edit`): if the model put the lone required
	// string under a different key, adopt the first string field as that key.
	normalizeSingleStringField,
];

/**
 * Runs {@link SCHEMA_NORMALIZATION_PASSES} over `args`. `validateToolArguments`
 * runs it once before the first validation; `runCoercionPasses` runs it again
 * after every issue-driven coercion, because a coercion may unwrap a
 * JSON-string container and expose fields the earlier run could not reach.
 */
function normalizeArgsForSchema(json: Record<string, unknown>, args: unknown): unknown {
	let value = args;
	for (const pass of SCHEMA_NORMALIZATION_PASSES) value = pass(json, value);
	return value;
}

/**
 * Validates tool call arguments against the tool's schema (Zod or plain JSON
 * Schema). Applies LLM-quirk coercions (numeric strings, JSON-string
 * containers, null/invalid-empty-string-for-optional, null-for-default) before
 * declaring failure.
 *
 * @throws Error with a formatted message when validation cannot be reconciled.
 */
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

	let normalizedArgs = normalizeArgsForSchema(json, originalArgs);
	let changed = normalizedArgs !== originalArgs;

	let result = validateContext(ctx, normalizedArgs);
	if (result.success) return result.value as ToolCall["arguments"];

	const coercionOutcome = runCoercionPasses(ctx, normalizedArgs, result);
	normalizedArgs = coercionOutcome.args;
	changed ||= coercionOutcome.changed;
	result = coercionOutcome.result;
	if (result.success) return result.value as ToolCall["arguments"];

	// Last resort: some providers parse in-band tool-call syntax server-side,
	// and a mistyped/missing `</arg_value>` closer inlines the remaining pairs
	// into one string argument. Gated on validation failure so valid calls
	// with tag-like string content are never rewritten.
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

	// Format validation errors nicely. The header phrase is asserted by
	// existing tests; the detailed body is informational.
	const annotated = annotateIssuesWithAcceptedValues(json, result.messages);
	// The issue lines quote the rejected value, so they are as unbounded as the
	// payload is until this cap.
	const errors = boundErrorText(annotated.join("\n") || "Unknown validation error", MAX_ERROR_ISSUES_LENGTH);

	// Bound the echo hard. The message exists to name the offending field and
	// its accepted values; reproducing the caller's payload turns every retry
	// into another copy of the input in the transcript.
	const originalEcho = truncateArgsForError(originalArgs);
	const normalizedEcho = changed ? truncateArgsForError(normalizedArgs) : undefined;
	// A normalized half that is empty, or identical to the original, is pure
	// noise: it tells the model nothing its own arguments did not.
	const normalizedIsInformative =
		normalizedEcho !== undefined &&
		!isEmptyEcho(normalizedEcho) &&
		JSON.stringify(normalizedEcho) !== JSON.stringify(originalEcho);
	const receivedArgs = normalizedIsInformative ? { original: originalEcho, normalized: normalizedEcho } : originalEcho;

	const receivedJson = JSON.stringify(receivedArgs, null, 2) ?? "undefined";
	const boundedJson = boundErrorText(receivedJson, MAX_ERROR_ARGS_JSON_LENGTH);

	// Both halves are already bounded; the outer cut is the guarantee that the
	// whole message is bounded no matter how the parts compose.
	const errorMessage = boundErrorText(
		`Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${boundedJson}`,
		MAX_ERROR_MESSAGE_LENGTH,
	);

	throw new AIError.ValidationError(errorMessage);
}

/**
 * Runs up to {@link MAX_COERCION_PASSES} issue-driven coercion rounds,
 * re-applying the schema normalizations after each round because a coercion
 * may unwrap JSON-string containers and expose fields the pre-validation
 * passes could not reach.
 */
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

		// `coerceArgsFromIssues` may have just parsed a JSON-string container at
		// the root or a nested field, exposing double-encoded keys, `string |
		// string[]` descendants and a mislabelled lone string field the initial
		// run could not reach. Re-run before the unrecognized-key repair on the
		// next validation pass would delete them.
		normalizedArgs = normalizeArgsForSchema(json, normalizedArgs);

		result = validateContext(ctx, normalizedArgs);
	}
	return { args: normalizedArgs, result, changed };
}
