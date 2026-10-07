/**
 * In-tree JSON Schema validator.
 *
 * Used by `validation.ts` for tools authored as plain JSON Schema (no Zod
 * runtime). Covers the keyword set tool authors actually rely on — type,
 * enum, const, combinators, if/then/else, object/array/string/number
 * constraints, $ref, prefixItems/items, contains, propertyNames, pattern &
 * dependent* — but treats `unevaluatedProperties` / `unevaluatedItems` as
 * permissive (with a one-shot warning) since those require evaluation
 * tracking we do not implement.
 *
 * Compared to AJV this is single-pass, synchronous, dependency-free, and
 * tolerates non-standard shapes (`nullable`) that LLM-emitted schemas carry.
 *
 * The walk keeps one mutable instance path, pushing a key before it descends into a child and
 * popping it after, and copies the path only when it records an issue. A value that validates
 * allocates no path arrays.
 */
import * as logger from "@veyyon/utils/logger";
import { codePointLength } from "@veyyon/utils/string-length";
import { isRecord } from "@veyyon/utils/type-guards";
import { areJsonValuesEqual } from "./equality";
import { isMultipleOf } from "./multiple-of";

export interface JsonSchemaValidationIssue {
	path: PropertyKey[];
	message: string;
	expectedTypes?: string[];
	keyword?: string;
	/**
	 * Marks issues that originate inside a failed `anyOf` / `oneOf` branch.
	 * Consumers such as the tool-argument coercion layer use this to avoid
	 * applying type repairs (e.g. singleton-array wrapping) that would be
	 * authoritative outside of a combinator but are only one candidate
	 * branch's expectation here.
	 */
	fromUnionBranch?: boolean;
}

export interface JsonSchemaValidationResult {
	success: boolean;
	issues: JsonSchemaValidationIssue[];
}

/**
 * Cycle bookkeeping for recursive `$ref` schemas. We track pairs of (resolved
 * ref, value identity) rather than refs alone: returning `true` for every
 * nested occurrence of a ref previously allowed recursive schemas to silently
 * validate values they should have rejected. For primitive values we fall back
 * to a depth counter capped at MAX_REF_DEPTH so a self-referential schema can
 * still bottom out without infinite recursion.
 */
interface ValidationContext {
	root: unknown;
	seenPairs: Set<string>;
	objectIds: WeakMap<object, number>;
	nextObjectId: number;
	refDepth: number;
}

/** The instance path of the node being validated; a step pushes a key before descending and pops it after. */
type InstancePath = PropertyKey[];

interface IssueOptions {
	expectedTypes?: string[];
	keyword?: string;
}

const MAX_REF_DEPTH = 64;

/** Module-level guard so the unevaluatedItems/unevaluatedProperties warning fires once per process. */
let seenUnevaluatedWarning = false;

function getValueIdentity(ctx: ValidationContext, value: object): number {
	let id = ctx.objectIds.get(value);
	if (id !== undefined) return id;
	id = ctx.nextObjectId;
	ctx.nextObjectId += 1;
	ctx.objectIds.set(value, id);
	return id;
}

/** Record an issue at `path`, copied so later steps of the walk cannot change it. */
function pushIssue(
	issues: JsonSchemaValidationIssue[],
	path: InstancePath,
	message: string,
	options: IssueOptions,
): void {
	issues.push({ path: path.slice(), message, ...options });
}

/** Record an issue at the child `key` of `path`. */
function pushChildIssue(
	issues: JsonSchemaValidationIssue[],
	path: InstancePath,
	key: PropertyKey,
	message: string,
	options: IssueOptions,
): void {
	const at = path.slice();
	at.push(key);
	issues.push({ path: at, message, ...options });
}

/** Validate `value`, the child `key` of the current node, against `schema`. */
function validateChild(
	schema: unknown,
	value: unknown,
	path: InstancePath,
	key: PropertyKey,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	path.push(key);
	const valid = validateSchemaNode(schema, value, path, ctx, issues);
	path.pop();
	return valid;
}

function typeOfJsonValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number" && Number.isInteger(value)) return "integer";
	return typeof value;
}

/** Decide whether `value` satisfies a single JSON-Schema `type` keyword string. `integer` is a refinement of `number`. */
function matchesJsonSchemaType(value: unknown, type: string): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "object":
			return isRecord(value);
		case "array":
			return Array.isArray(value);
		case "null":
			return value === null;
		default:
			return false;
	}
}

/** Whether `value` matches the `type` keyword as written: one string, or any string in an array. */
function matchesDeclaredType(raw: unknown, value: unknown): boolean {
	if (typeof raw === "string") return matchesJsonSchemaType(value, raw);
	if (!Array.isArray(raw)) return false;
	for (const entry of raw) {
		if (typeof entry === "string" && matchesJsonSchemaType(value, entry)) return true;
	}
	return false;
}

/** Extract the effective `type` list from a schema, treating `nullable: true` as adding `"null"`. */
function schemaTypes(schema: Record<string, unknown>): string[] {
	const raw = schema.type;
	const types =
		typeof raw === "string"
			? [raw]
			: Array.isArray(raw)
				? raw.filter((entry): entry is string => typeof entry === "string")
				: [];
	if (schema.nullable === true && !types.includes("null")) {
		return types.concat(["null"]);
	}
	return types;
}

/** RFC 6901 token decode: `~1` → `/`, `~0` → `~`. */
function decodePointerToken(token: string): string {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Resolve a `#/path/to/node` pointer against the root schema. Returns `undefined` for external/unsupported refs. */
function resolveLocalRef(root: unknown, ref: string): unknown | undefined {
	if (ref === "#") return root;
	if (!ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const rawToken of ref.slice(2).split("/")) {
		const token = decodePointerToken(rawToken);
		if (!isRecord(current) && !Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[token];
	}
	return current;
}

/** Narrow `required: unknown` to `required: string[]` — the spec allows it to be missing but rejects non-string entries. */
function isRequiredSet(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

function includesJsonValue(list: readonly unknown[], value: unknown): boolean {
	for (const entry of list) {
		if (areJsonValuesEqual(entry, value)) return true;
	}
	return false;
}

/**
 * Core validator. Walks a schema node, applies every applicable keyword to
 * `value`, and accumulates issues. Returns `true` only if no keyword
 * rejected. A node that returns `true` has recorded no issue: a combinator
 * collects its branches' issues aside and records them only when it fails.
 */
function validateSchemaNode(
	schema: unknown,
	value: unknown,
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	if (schema === true) return true;
	if (schema === false) {
		pushIssue(issues, path, "must not match false schema", { keyword: "false" });
		return false;
	}
	if (!isRecord(schema)) {
		pushIssue(issues, path, "schema must be an object or boolean", { keyword: "schema" });
		return false;
	}
	if (typeof schema.$ref === "string") return validateRef(schema.$ref, value, path, ctx, issues);
	if (value === null && schema.nullable === true) return true;
	if (!validateType(schema, value, path, issues)) return false;

	let valid = validateConstAndEnum(schema, value, path, issues);
	valid = validateInPlaceApplicators(schema, value, path, ctx, issues) && valid;
	warnUnevaluatedOnce(schema);
	return validateKindKeywords(schema, value, path, ctx, issues) && valid;
}

/**
 * Follow a `$ref`. For object/array values the cycle key is (ref, value identity), so the same
 * schema applied to a different value still recurses and only an exact (schema, value) repeat
 * short-circuits as a true cycle. For primitives a depth counter lets self-referential schemas
 * without a base case terminate.
 */
function validateRef(
	ref: string,
	value: unknown,
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	const resolved = resolveLocalRef(ctx.root, ref);
	if (resolved === undefined) {
		pushIssue(issues, path, `unresolved reference ${ref}`, { keyword: "$ref" });
		return false;
	}
	if (value !== null && typeof value === "object") {
		const pairKey = `${ref}:${getValueIdentity(ctx, value)}`;
		if (ctx.seenPairs.has(pairKey)) return true;
		ctx.seenPairs.add(pairKey);
		const valid = validateSchemaNode(resolved, value, path, ctx, issues);
		ctx.seenPairs.delete(pairKey);
		return valid;
	}
	if (ctx.refDepth >= MAX_REF_DEPTH) {
		pushIssue(issues, path, "reference depth exceeded", { keyword: "$ref" });
		return false;
	}
	ctx.refDepth += 1;
	const valid = validateSchemaNode(resolved, value, path, ctx, issues);
	ctx.refDepth -= 1;
	return valid;
}

/**
 * Apply `type`. A mismatch reports every accepted type and stops the node's other keywords. The
 * type list is built only on a mismatch: a schema with `nullable: true` and no `type` accepts only
 * `null`, which `validateSchemaNode` returned for before reaching here.
 */
function validateType(
	schema: Record<string, unknown>,
	value: unknown,
	path: InstancePath,
	issues: JsonSchemaValidationIssue[],
): boolean {
	const raw = schema.type;
	if (raw === undefined ? schema.nullable !== true : matchesDeclaredType(raw, value)) return true;
	const types = schemaTypes(schema);
	if (types.length === 0 || types.some(type => matchesJsonSchemaType(value, type))) return true;
	pushIssue(issues, path, `expected ${types.join(" or ")}, received ${typeOfJsonValue(value)}`, {
		keyword: "type",
		expectedTypes: types,
	});
	return false;
}

function validateConstAndEnum(
	schema: Record<string, unknown>,
	value: unknown,
	path: InstancePath,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	if ("const" in schema && !areJsonValuesEqual(value, schema.const)) {
		pushIssue(issues, path, "must equal const value", { keyword: "const" });
		valid = false;
	}
	if (Array.isArray(schema.enum) && !includesJsonValue(schema.enum, value)) {
		pushIssue(issues, path, "must be one of the allowed enum values", { keyword: "enum" });
		valid = false;
	}
	return valid;
}

/** Apply the keywords that validate the node's own value against subschemas: `anyOf`, `oneOf`, `allOf`, `not`, `if`. */
function validateInPlaceApplicators(
	schema: Record<string, unknown>,
	value: unknown,
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	if (Array.isArray(schema.anyOf)) valid = validateUnion("anyOf", schema.anyOf, value, path, ctx, issues) && valid;
	if (Array.isArray(schema.oneOf)) valid = validateUnion("oneOf", schema.oneOf, value, path, ctx, issues) && valid;
	if (Array.isArray(schema.allOf)) {
		for (const branch of schema.allOf) valid = validateSchemaNode(branch, value, path, ctx, issues) && valid;
	}
	if ("not" in schema && validateSchemaNode(schema.not, value, path, ctx, [])) {
		pushIssue(issues, path, "must not match excluded schema", { keyword: "not" });
		valid = false;
	}
	if ("if" in schema) valid = validateConditional(schema, value, path, ctx, issues) && valid;
	return valid;
}

/**
 * Apply `if`/`then`/`else`: validate the `if` branch silently and, on its outcome, validate the value against `then`
 * or `else`. Each subschema is a schema node; neither branch has to be an object. A schema whose `if` reads properties
 * only `then` supplies still resolves consistently for the shapes LLMs emit.
 */
function validateConditional(
	schema: Record<string, unknown>,
	value: unknown,
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	const branch = validateSchemaNode(schema.if, value, path, ctx, []) ? schema.then : schema.else;
	return branch === undefined || validateSchemaNode(branch, value, path, ctx, issues);
}

/**
 * Apply `anyOf` (at least one branch) or `oneOf` (exactly one). When no branch matches, the first
 * failed branch's issues stand for the union; the ones at the union's own path are tagged
 * `fromUnionBranch`, and deeper ones describe a specific field within the failed branch and stay
 * individually repairable.
 */
function validateUnion(
	keyword: "anyOf" | "oneOf",
	branches: readonly unknown[],
	value: unknown,
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let matches = 0;
	let firstIssues: JsonSchemaValidationIssue[] | undefined;
	let branchIssues: JsonSchemaValidationIssue[] = [];
	for (const branch of branches) {
		if (validateSchemaNode(branch, value, path, ctx, branchIssues)) matches += 1;
		else if (!firstIssues) {
			firstIssues = branchIssues;
			branchIssues = [];
			continue;
		}
		branchIssues.length = 0;
	}
	if (keyword === "anyOf" ? matches > 0 : matches === 1) return true;
	if (matches === 0 && firstIssues && firstIssues.length > 0) pushFirstBranchIssues(firstIssues, path.length, issues);
	else {
		const message = keyword === "anyOf" ? "must match at least one schema" : "must match exactly one schema";
		pushIssue(issues, path, message, { keyword });
	}
	return false;
}

/** Push a union's first failed branch's issues, tagging those at the union's own depth `fromUnionBranch`. */
function pushFirstBranchIssues(
	branchIssues: readonly JsonSchemaValidationIssue[],
	unionDepth: number,
	issues: JsonSchemaValidationIssue[],
): void {
	for (const branchIssue of branchIssues) {
		issues.push(branchIssue.path.length === unionDepth ? { ...branchIssue, fromUnionBranch: true } : branchIssue);
	}
}

/**
 * `unevaluatedProperties` / `unevaluatedItems` require tracking which keys/indices were
 * "evaluated" by sibling keywords across composed schemas — expensive bookkeeping we do not
 * implement. Warn once so tool authors who rely on them know the keyword is silently permissive in
 * this validator.
 */
function warnUnevaluatedOnce(schema: Record<string, unknown>): void {
	if (seenUnevaluatedWarning || !("unevaluatedProperties" in schema || "unevaluatedItems" in schema)) return;
	seenUnevaluatedWarning = true;
	logger.warn(
		"JSON Schema unevaluatedProperties/unevaluatedItems are not enforced by the in-tree validator; treating as permissive",
	);
}

/** Apply the keywords of the value's own kind: object, array, string or finite number. */
function validateKindKeywords(
	schema: Record<string, unknown>,
	value: unknown,
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	if (isRecord(value)) return validateObjectKeywords(schema, value, path, ctx, issues);
	if (Array.isArray(value)) return validateArrayKeywords(schema, value, path, ctx, issues);
	if (typeof value === "string") return validateStringKeywords(schema, value, path, issues);
	if (typeof value === "number" && Number.isFinite(value)) return validateNumberKeywords(schema, value, path, issues);
	return true;
}

/**
 * Apply object-shaped JSON-Schema keywords: `required`, `properties`, `propertyNames`, `patternProperties`, `dependentRequired`, `dependentSchemas`, `additionalProperties`, and the `min/maxProperties` counts.
 *
 * Every instance-membership test uses `Object.hasOwn`, never `key in value`. JSON Schema defines a
 * `required`/`properties` key as an OWN property of the instance, but `key in value` also matches
 * inherited `Object.prototype` members. A JSON.parse'd instance always carries that prototype, so
 * `key in value` breaks two ways: `required: ["toString"]` passes on an object that lacks the
 * property (false negative), and `properties: { toString: ... }` on an object without it validates
 * the inherited `Object.prototype.toString` function against the subschema (spurious failure).
 * `Object.hasOwn` keeps the tests to real own properties, matching the `Object.keys(value)`
 * iteration the count/additionalProperties keywords use.
 */
function validateObjectKeywords(
	schema: Record<string, unknown>,
	value: Record<string, unknown>,
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = isRequiredSet(schema.required) ? validateRequired(schema.required, value, path, issues) : true;
	const properties = isRecord(schema.properties) ? schema.properties : undefined;
	if (properties) valid = validateProperties(properties, value, path, ctx, issues) && valid;

	const additional = schema.additionalProperties;
	const known = knownKeysFor(additional, properties);
	const keys = needsOwnKeys(schema, known) ? Object.keys(value) : [];

	if (schema.propertyNames !== undefined) {
		valid = validatePropertyNames(schema.propertyNames, keys, path, ctx, issues) && valid;
	}
	if (isRecord(schema.patternProperties)) {
		valid = validatePatternProperties(schema.patternProperties, value, keys, known, path, ctx, issues) && valid;
	}
	valid = validateDependencies(schema, value, path, ctx, issues) && valid;
	if (known) valid = validateAdditionalProperties(additional, value, keys, known, path, ctx, issues) && valid;
	return validatePropertyCount(schema, keys.length, path, issues) && valid;
}

/**
 * The keys `additionalProperties` does not govern, seeded with the property names; `patternProperties` adds the keys
 * its patterns match. Undefined when `additionalProperties` is absent or `true` and so restricts no leftover key.
 */
function knownKeysFor(additional: unknown, properties: Record<string, unknown> | undefined): Set<string> | undefined {
	if (additional === undefined || additional === true) return undefined;
	return new Set(properties ? Object.keys(properties) : []);
}

/** Apply `required`: each listed key must be an own property of the instance. */
function validateRequired(
	required: readonly string[],
	value: Record<string, unknown>,
	path: InstancePath,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	for (const key of required) {
		if (Object.hasOwn(value, key)) continue;
		pushChildIssue(issues, path, key, "is required", { keyword: "required" });
		valid = false;
	}
	return valid;
}

/** Apply `properties` to each listed key the instance holds as an own property. */
function validateProperties(
	properties: Record<string, unknown>,
	value: Record<string, unknown>,
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	for (const key in properties) {
		if (!Object.hasOwn(value, key)) continue;
		valid = validateChild(properties[key], value[key], path, key, ctx, issues) && valid;
	}
	return valid;
}

/** Apply `propertyNames` to each own key, as a string value at the key's own path. */
function validatePropertyNames(
	propertyNames: unknown,
	keys: readonly string[],
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	for (const key of keys) valid = validateChild(propertyNames, key, path, key, ctx, issues) && valid;
	return valid;
}

/** Apply `minProperties` and `maxProperties` to the instance's own key count. */
function validatePropertyCount(
	schema: Record<string, unknown>,
	count: number,
	path: InstancePath,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	if (typeof schema.minProperties === "number" && count < schema.minProperties) {
		pushIssue(issues, path, `must have at least ${schema.minProperties} properties`, { keyword: "minProperties" });
		valid = false;
	}
	if (typeof schema.maxProperties === "number" && count > schema.maxProperties) {
		pushIssue(issues, path, `must have at most ${schema.maxProperties} properties`, { keyword: "maxProperties" });
		valid = false;
	}
	return valid;
}

/** Whether any object keyword walks or counts the instance's own keys. */
function needsOwnKeys(schema: Record<string, unknown>, known: Set<string> | undefined): boolean {
	return (
		known !== undefined ||
		schema.propertyNames !== undefined ||
		isRecord(schema.patternProperties) ||
		typeof schema.minProperties === "number" ||
		typeof schema.maxProperties === "number"
	);
}

/** Validate each own key a `patternProperties` pattern matches, marking it known to `additionalProperties`. */
function validatePatternProperties(
	patternProperties: Record<string, unknown>,
	value: Record<string, unknown>,
	keys: readonly string[],
	known: Set<string> | undefined,
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	for (const pattern in patternProperties) {
		const patternSchema = patternProperties[pattern];
		const re = compiledPattern(pattern);
		if (re === null) {
			pushIssue(issues, path, `invalid patternProperties regex ${pattern}`, { keyword: "patternProperties" });
			valid = false;
			continue;
		}
		for (const key of keys) {
			if (!re.test(key)) continue;
			known?.add(key);
			valid = validateChild(patternSchema, value[key], path, key, ctx, issues) && valid;
		}
	}
	return valid;
}

/** Apply `dependentRequired` and `dependentSchemas` for each trigger key the instance holds. */
function validateDependencies(
	schema: Record<string, unknown>,
	value: Record<string, unknown>,
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	if (isRecord(schema.dependentRequired)) {
		valid = validateDependentRequired(schema.dependentRequired, value, path, issues);
	}
	if (isRecord(schema.dependentSchemas)) {
		valid = validateDependentSchemas(schema.dependentSchemas, value, path, ctx, issues) && valid;
	}
	return valid;
}

/** Apply `dependentRequired`: for each trigger key the instance holds, every listed string key must be present too. */
function validateDependentRequired(
	dependentRequired: Record<string, unknown>,
	value: Record<string, unknown>,
	path: InstancePath,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	for (const key in dependentRequired) {
		const deps = dependentRequired[key];
		if (!Object.hasOwn(value, key) || !Array.isArray(deps)) continue;
		for (const dep of deps) {
			if (typeof dep !== "string" || Object.hasOwn(value, dep)) continue;
			pushChildIssue(issues, path, dep, `is required when "${key}" is present`, { keyword: "dependentRequired" });
			valid = false;
		}
	}
	return valid;
}

/** Apply `dependentSchemas`: for each trigger key the instance holds, the whole instance must match its subschema. */
function validateDependentSchemas(
	dependentSchemas: Record<string, unknown>,
	value: Record<string, unknown>,
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	for (const key in dependentSchemas) {
		if (!Object.hasOwn(value, key)) continue;
		valid = validateSchemaNode(dependentSchemas[key], value, path, ctx, issues) && valid;
	}
	return valid;
}

/** Apply `additionalProperties` (`false` or a subschema) to the own keys no other object keyword governs. */
function validateAdditionalProperties(
	additional: unknown,
	value: Record<string, unknown>,
	keys: readonly string[],
	known: Set<string>,
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	for (const key of keys) {
		if (known.has(key)) continue;
		if (additional === false) {
			pushChildIssue(issues, path, key, "must not be present", { keyword: "additionalProperties" });
			valid = false;
		} else {
			valid = validateChild(additional, value[key], path, key, ctx, issues) && valid;
		}
	}
	return valid;
}

/** Apply array-shaped keywords: `min/maxItems`, `uniqueItems`, `prefixItems` + `items` tuple validation, and `contains` with `min/maxContains`. */
function validateArrayKeywords(
	schema: Record<string, unknown>,
	value: unknown[],
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	if (typeof schema.minItems === "number" && value.length < schema.minItems) {
		pushIssue(issues, path, `must have at least ${schema.minItems} items`, { keyword: "minItems" });
		valid = false;
	}
	if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
		pushIssue(issues, path, `must have at most ${schema.maxItems} items`, { keyword: "maxItems" });
		valid = false;
	}
	if (schema.uniqueItems === true) valid = validateUniqueItems(value, path, issues) && valid;
	valid = validateItems(schema, value, path, ctx, issues) && valid;
	if (schema.contains !== undefined) valid = validateContains(schema, value, path, ctx, issues) && valid;
	return valid;
}

/** Apply `uniqueItems: true`: report every element equal to an earlier one, once per earlier match. */
function validateUniqueItems(
	value: readonly unknown[],
	path: InstancePath,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	for (let i = 0; i < value.length; i += 1) {
		for (let j = i + 1; j < value.length; j += 1) {
			if (!areJsonValuesEqual(value[i], value[j])) continue;
			pushChildIssue(issues, path, j, "must be unique", { keyword: "uniqueItems" });
			valid = false;
		}
	}
	return valid;
}

/**
 * Tuple validation uses JSON Schema 2020-12 `prefixItems` for per-index schemas. When present,
 * `items` is the schema for every remaining element; array-valued `items` is the pre-2020 tuple
 * form and is rejected.
 */
function validateItems(
	schema: Record<string, unknown>,
	value: unknown[],
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	const items = schema.items;
	if (Array.isArray(items)) {
		pushIssue(issues, path, "array-valued items is not valid in JSON Schema 2020-12; use prefixItems", {
			keyword: "items",
		});
		return false;
	}
	let valid = true;
	let first = 0;
	if (Array.isArray(schema.prefixItems)) {
		const prefixItems = schema.prefixItems;
		const limit = Math.min(prefixItems.length, value.length);
		for (let i = 0; i < limit; i += 1) valid = validateChild(prefixItems[i], value[i], path, i, ctx, issues) && valid;
		first = prefixItems.length;
	}
	if (items !== undefined) {
		for (let i = first; i < value.length; i += 1)
			valid = validateChild(items, value[i], path, i, ctx, issues) && valid;
	}
	return valid;
}

/** Count the elements `contains` matches, discarding their issues, and check the count against `min/maxContains`. */
function validateContains(
	schema: Record<string, unknown>,
	value: unknown[],
	path: InstancePath,
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	const minContains = typeof schema.minContains === "number" ? schema.minContains : 1;
	const maxContains = typeof schema.maxContains === "number" ? schema.maxContains : Infinity;
	const discarded: JsonSchemaValidationIssue[] = [];
	let count = 0;
	for (let i = 0; i < value.length; i += 1) {
		if (validateChild(schema.contains, value[i], path, i, ctx, discarded)) count += 1;
		discarded.length = 0;
	}
	let valid = true;
	if (count < minContains) {
		pushIssue(issues, path, `must contain at least ${minContains} matching item(s)`, { keyword: "contains" });
		valid = false;
	}
	if (count > maxContains) {
		pushIssue(issues, path, `must contain at most ${maxContains} matching item(s)`, { keyword: "maxContains" });
		valid = false;
	}
	return valid;
}

/**
 * Compile a JSON Schema `pattern` or `patternProperties` key once and memoize it. Validating an
 * array of N strings against a shared `{ items: { pattern } }` schema reaches
 * `validateStringKeywords` N times with the identical pattern string, so a bare
 * `new RegExp(schema.pattern)` recompiled the same regex once per element -
 * O(elements) redundant compilation on the hot path that validates model tool
 * output. The cache keys on the raw pattern source and stores `null` for a
 * pattern that fails to compile, so an invalid pattern is diagnosed once and
 * never re-throws on subsequent elements. This is the single owner of pattern
 * compilation for the validator.
 */
const compiledPatternCache = new Map<string, RegExp | null>();

function compiledPattern(pattern: string): RegExp | null {
	const cached = compiledPatternCache.get(pattern);
	if (cached !== undefined) return cached;
	let regex: RegExp | null;
	try {
		regex = new RegExp(pattern);
	} catch {
		regex = null;
	}
	compiledPatternCache.set(pattern, regex);
	return regex;
}

/** Apply string-shaped keywords: `min/maxLength`, `pattern`. Invalid regexes flag the schema itself rather than the value. */
function validateStringKeywords(
	schema: Record<string, unknown>,
	value: string,
	path: InstancePath,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	const length =
		typeof schema.minLength === "number" || typeof schema.maxLength === "number" ? codePointLength(value) : 0;
	if (typeof schema.minLength === "number" && length < schema.minLength) {
		pushIssue(issues, path, `must be at least ${schema.minLength} characters`, { keyword: "minLength" });
		valid = false;
	}
	if (typeof schema.maxLength === "number" && length > schema.maxLength) {
		pushIssue(issues, path, `must be at most ${schema.maxLength} characters`, { keyword: "maxLength" });
		valid = false;
	}
	if (typeof schema.pattern === "string") {
		const regex = compiledPattern(schema.pattern);
		if (regex === null) {
			pushIssue(issues, path, "schema pattern is invalid", { keyword: "pattern" });
			valid = false;
		} else if (!regex.test(value)) {
			pushIssue(issues, path, "must match pattern", { keyword: "pattern" });
			valid = false;
		}
	}
	return valid;
}

/** Apply number-shaped keywords: `minimum`/`maximum`, `exclusiveMinimum`/`exclusiveMaximum` (both numeric draft 2020-12 and boolean draft-07 forms), and `multipleOf`. */
function validateNumberKeywords(
	schema: Record<string, unknown>,
	value: number,
	path: InstancePath,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	if (typeof schema.minimum === "number" && value < schema.minimum) {
		pushIssue(issues, path, `must be >= ${schema.minimum}`, { keyword: "minimum" });
		valid = false;
	}
	if (typeof schema.maximum === "number" && value > schema.maximum) {
		pushIssue(issues, path, `must be <= ${schema.maximum}`, { keyword: "maximum" });
		valid = false;
	}
	if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
		pushIssue(issues, path, `must be > ${schema.exclusiveMinimum}`, { keyword: "exclusiveMinimum" });
		valid = false;
	}
	if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
		pushIssue(issues, path, `must be < ${schema.exclusiveMaximum}`, { keyword: "exclusiveMaximum" });
		valid = false;
	}
	if (schema.exclusiveMinimum === true && typeof schema.minimum === "number" && value <= schema.minimum) {
		pushIssue(issues, path, `must be > ${schema.minimum}`, { keyword: "exclusiveMinimum" });
		valid = false;
	}
	if (schema.exclusiveMaximum === true && typeof schema.maximum === "number" && value >= schema.maximum) {
		pushIssue(issues, path, `must be < ${schema.maximum}`, { keyword: "exclusiveMaximum" });
		valid = false;
	}
	if (typeof schema.multipleOf === "number" && !isMultipleOf(value, schema.multipleOf)) {
		pushIssue(issues, path, `must be a multiple of ${schema.multipleOf}`, { keyword: "multipleOf" });
		valid = false;
	}
	return valid;
}

export function validateJsonSchemaValue(schema: unknown, value: unknown): JsonSchemaValidationResult {
	const issues: JsonSchemaValidationIssue[] = [];
	const ctx: ValidationContext = {
		root: schema,
		seenPairs: new Set(),
		objectIds: new WeakMap(),
		nextObjectId: 0,
		refDepth: 0,
	};
	const success = validateSchemaNode(schema, value, [], ctx, issues);
	return { success, issues };
}

export function isJsonSchemaValueValid(schema: unknown, value: unknown): boolean {
	return validateJsonSchemaValue(schema, value).success;
}
