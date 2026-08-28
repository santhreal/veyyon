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

import {
	deleteValueAtPointer,
	getValueAtPointer,
	looksLikeJsonContainerString,
	normalizeEnumStringWhitespace,
	normalizeOptionalNullsForSchema,
	pathToPointer,
	setValueAtPointer,
	tryCoerceForExpectedTypes,
	tryParseJsonForTypes,
} from "./validation-helpers";

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
