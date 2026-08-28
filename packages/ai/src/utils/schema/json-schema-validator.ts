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
	fromUnionBranch?: boolean;
}

export interface JsonSchemaValidationResult {
	success: boolean;
	issues: JsonSchemaValidationIssue[];
}

interface ValidationContext {
	root: unknown;
	seenPairs: Set<string>;
	objectIds: WeakMap<object, number>;
	nextObjectId: { value: number };
	refDepth: number;
}

const MAX_REF_DEPTH = 64;

let seenUnevaluatedWarning = false;

function getValueIdentity(ctx: ValidationContext, value: object): number {
	let id = ctx.objectIds.get(value);
	if (id !== undefined) return id;
	id = ctx.nextObjectId.value;
	ctx.nextObjectId.value += 1;
	ctx.objectIds.set(value, id);
	return id;
}

function pushIssue(
	issues: JsonSchemaValidationIssue[],
	path: readonly PropertyKey[],
	message: string,
	options: { expectedTypes?: string[]; keyword?: string } = {},
): void {
	issues.push({ path: path.slice(), message, ...options });
}

function typeOfJsonValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number" && Number.isInteger(value)) return "integer";
	return typeof value;
}

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

function decodePointerToken(token: string): string {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

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

function isRequiredSet(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

function validateSchemaNode(
	schema: unknown,
	value: unknown,
	path: readonly PropertyKey[],
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

	const ref = schema.$ref;
	if (typeof ref === "string") {
		const resolved = resolveLocalRef(ctx.root, ref);
		if (resolved === undefined) {
			pushIssue(issues, path, `unresolved reference ${ref}`, { keyword: "$ref" });
			return false;
		}
		let pairKey: string | undefined;
		if (value !== null && typeof value === "object") {
			pairKey = `${ref}:${getValueIdentity(ctx, value)}`;
			if (ctx.seenPairs.has(pairKey)) return true;
			ctx.seenPairs.add(pairKey);
		} else {
			if (ctx.refDepth >= MAX_REF_DEPTH) {
				pushIssue(issues, path, "reference depth exceeded", { keyword: "$ref" });
				return false;
			}
			ctx.refDepth += 1;
		}
		const ok = validateSchemaNode(resolved, value, path, ctx, issues);
		if (pairKey !== undefined) ctx.seenPairs.delete(pairKey);
		else ctx.refDepth -= 1;
		return ok;
	}

	if (value === null && schema.nullable === true) return true;

	let valid = true;
	const types = schemaTypes(schema);
	if (types.length > 0 && !types.some(type => matchesJsonSchemaType(value, type))) {
		pushIssue(issues, path, `expected ${types.join(" or ")}, received ${typeOfJsonValue(value)}`, {
			keyword: "type",
			expectedTypes: types,
		});
		return false;
	}

	if ("const" in schema && !areJsonValuesEqual(value, schema.const)) {
		pushIssue(issues, path, "must equal const value", { keyword: "const" });
		valid = false;
	}

	if (Array.isArray(schema.enum) && !schema.enum.some(entry => areJsonValuesEqual(entry, value))) {
		pushIssue(issues, path, "must be one of the allowed enum values", { keyword: "enum" });
		valid = false;
	}

	for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		if (keyword === "allOf") {
			for (const branch of branches) {
				valid = validateSchemaNode(branch, value, path, ctx, issues) && valid;
			}
			continue;
		}

		let matches = 0;
		let firstIssues: JsonSchemaValidationIssue[] | undefined;
		for (const branch of branches) {
			const branchIssues: JsonSchemaValidationIssue[] = [];
			if (validateSchemaNode(branch, value, path, ctx, branchIssues)) {
				matches += 1;
			} else if (!firstIssues) {
				firstIssues = branchIssues;
			}
		}
		const branchValid = keyword === "anyOf" ? matches > 0 : matches === 1;
		if (!branchValid) {
			if (matches === 0 && firstIssues && firstIssues.length > 0) {
				const unionDepth = path.length;
				for (const branchIssue of firstIssues) {
					if (branchIssue.path.length === unionDepth) {
						issues.push({ ...branchIssue, fromUnionBranch: true });
					} else {
						issues.push(branchIssue);
					}
				}
			} else {
				pushIssue(
					issues,
					path,
					keyword === "anyOf" ? "must match at least one schema" : "must match exactly one schema",
					{
						keyword,
					},
				);
			}
			valid = false;
		}
	}

	if ("not" in schema) {
		const notIssues: JsonSchemaValidationIssue[] = [];
		if (validateSchemaNode(schema.not, value, path, ctx, notIssues)) {
			pushIssue(issues, path, "must not match excluded schema", { keyword: "not" });
			valid = false;
		}
	}

	if ("if" in schema) {
		const ifIssues: JsonSchemaValidationIssue[] = [];
		const ifOk = validateSchemaNode(schema.if, value, path, ctx, ifIssues);
		const branch = ifOk ? schema.then : schema.else;
		if (branch !== undefined) {
			valid = validateSchemaNode(branch, value, path, ctx, issues) && valid;
		}
	}

	if (("unevaluatedProperties" in schema || "unevaluatedItems" in schema) && !seenUnevaluatedWarning) {
		seenUnevaluatedWarning = true;
		logger.warn(
			"JSON Schema unevaluatedProperties/unevaluatedItems are not enforced by the in-tree validator; treating as permissive",
		);
	}

	if (isRecord(value)) {
		valid = validateObjectKeywords(schema, value, path, ctx, issues) && valid;
	}
	if (Array.isArray(value)) {
		valid = validateArrayKeywords(schema, value, path, ctx, issues) && valid;
	}
	if (typeof value === "string") {
		valid = validateStringKeywords(schema, value, path, issues) && valid;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		valid = validateNumberKeywords(schema, value, path, issues) && valid;
	}

	return valid;
}

function validateObjectKeywords(
	schema: Record<string, unknown>,
	value: Record<string, unknown>,
	path: readonly PropertyKey[],
	ctx: ValidationContext,
	issues: JsonSchemaValidationIssue[],
): boolean {
	let valid = true;
	const properties = isRecord(schema.properties) ? schema.properties : {};
	if (isRequiredSet(schema.required)) {
		for (const key of schema.required) {
			if (!Object.hasOwn(value, key)) {
				pushIssue(issues, path.concat([key]), "is required", { keyword: "required" });
				valid = false;
			}
		}
	}

	for (const key in properties) {
		if (!Object.hasOwn(value, key)) continue;
		valid = validateSchemaNode(properties[key], value[key], path.concat([key]), ctx, issues) && valid;
	}

	if (schema.propertyNames !== undefined) {
		for (const key of Object.keys(value)) {
			valid = validateSchemaNode(schema.propertyNames, key, path.concat([key]), ctx, issues) && valid;
		}
	}

	const known = new Set(Object.keys(properties));
	if (isRecord(schema.patternProperties)) {
		const patternProperties = schema.patternProperties;
		for (const pattern in patternProperties) {
			const patternSchema = patternProperties[pattern];
			let re: RegExp;
			try {
				re = new RegExp(pattern);
			} catch {
				pushIssue(issues, path, `invalid patternProperties regex ${pattern}`, { keyword: "patternProperties" });
				valid = false;
				continue;
			}
			for (const key of Object.keys(value)) {
				if (!re.test(key)) continue;
				known.add(key);
				valid = validateSchemaNode(patternSchema, value[key], path.concat([key]), ctx, issues) && valid;
			}
		}
	}

	if (isRecord(schema.dependentRequired)) {
		const dependentRequired = schema.dependentRequired;
		for (const key in dependentRequired) {
			const deps = dependentRequired[key];
			if (!Object.hasOwn(value, key)) continue;
			if (!Array.isArray(deps)) continue;
			for (const dep of deps) {
				if (typeof dep !== "string") continue;
				if (!Object.hasOwn(value, dep)) {
					pushIssue(issues, path.concat([dep]), `is required when "${key}" is present`, {
						keyword: "dependentRequired",
					});
					valid = false;
				}
			}
		}
	}

	if (isRecord(schema.dependentSchemas)) {
		const dependentSchemas = schema.dependentSchemas;
		for (const key in dependentSchemas) {
			if (!Object.hasOwn(value, key)) continue;
			valid = validateSchemaNode(dependentSchemas[key], value, path, ctx, issues) && valid;
		}
	}

	const additional = schema.additionalProperties;
	if (additional === false) {
		for (const key of Object.keys(value)) {
			if (known.has(key)) continue;
			pushIssue(issues, path.concat([key]), "must not be present", { keyword: "additionalProperties" });
			valid = false;
		}
	} else if (additional !== undefined && additional !== true) {
		for (const key of Object.keys(value)) {
			if (known.has(key)) continue;
			valid = validateSchemaNode(additional, value[key], path.concat([key]), ctx, issues) && valid;
		}
	}

	if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) {
		pushIssue(issues, path, `must have at least ${schema.minProperties} properties`, { keyword: "minProperties" });
		valid = false;
	}
	if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) {
		pushIssue(issues, path, `must have at most ${schema.maxProperties} properties`, { keyword: "maxProperties" });
		valid = false;
	}

	return valid;
}

function validateArrayKeywords(
	schema: Record<string, unknown>,
	value: unknown[],
	path: readonly PropertyKey[],
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
	if (schema.uniqueItems === true) {
		for (let i = 0; i < value.length; i += 1) {
			for (let j = i + 1; j < value.length; j += 1) {
				if (!areJsonValuesEqual(value[i], value[j])) continue;
				pushIssue(issues, path.concat([j]), "must be unique", { keyword: "uniqueItems" });
				valid = false;
			}
		}
	}

	const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : undefined;
	const items = schema.items;
	if (Array.isArray(items)) {
		pushIssue(issues, path, "array-valued items is not valid in JSON Schema 2020-12; use prefixItems", {
			keyword: "items",
		});
		valid = false;
	} else if (prefixItems) {
		const limit = Math.min(prefixItems.length, value.length);
		for (let i = 0; i < limit; i += 1) {
			valid = validateSchemaNode(prefixItems[i], value[i], path.concat([i]), ctx, issues) && valid;
		}
		if (items !== undefined) {
			for (let i = prefixItems.length; i < value.length; i += 1) {
				valid = validateSchemaNode(items, value[i], path.concat([i]), ctx, issues) && valid;
			}
		}
	} else if (items !== undefined) {
		for (let i = 0; i < value.length; i += 1) {
			valid = validateSchemaNode(items, value[i], path.concat([i]), ctx, issues) && valid;
		}
	}

	if (schema.contains !== undefined) {
		const minContains = typeof schema.minContains === "number" ? schema.minContains : 1;
		const maxContains = typeof schema.maxContains === "number" ? schema.maxContains : Infinity;
		let count = 0;
		for (let i = 0; i < value.length; i += 1) {
			const containsIssues: JsonSchemaValidationIssue[] = [];
			if (validateSchemaNode(schema.contains, value[i], path.concat([i]), ctx, containsIssues)) {
				count += 1;
			}
		}
		if (count < minContains) {
			pushIssue(issues, path, `must contain at least ${minContains} matching item(s)`, { keyword: "contains" });
			valid = false;
		}
		if (count > maxContains) {
			pushIssue(issues, path, `must contain at most ${maxContains} matching item(s)`, { keyword: "maxContains" });
			valid = false;
		}
	}

	return valid;
}

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

function validateStringKeywords(
	schema: Record<string, unknown>,
	value: string,
	path: readonly PropertyKey[],
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

function validateNumberKeywords(
	schema: Record<string, unknown>,
	value: number,
	path: readonly PropertyKey[],
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
	if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
		if (!isMultipleOf(value, schema.multipleOf)) {
			pushIssue(issues, path, `must be a multiple of ${schema.multipleOf}`, { keyword: "multipleOf" });
			valid = false;
		}
	}
	return valid;
}

export function validateJsonSchemaValue(schema: unknown, value: unknown): JsonSchemaValidationResult {
	const issues: JsonSchemaValidationIssue[] = [];
	const success = validateSchemaNode(
		schema,
		value,
		[],
		{ root: schema, seenPairs: new Set(), objectIds: new WeakMap(), nextObjectId: { value: 0 }, refDepth: 0 },
		issues,
	);
	return { success, issues };
}

export function isJsonSchemaValueValid(schema: unknown, value: unknown): boolean {
	return validateJsonSchemaValue(schema, value).success;
}
