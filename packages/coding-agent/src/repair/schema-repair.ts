import type { Tool, ToolCall } from "@veyyon/ai/types";
import { isArkSchema, isZodSchema, toolWireSchema } from "@veyyon/ai/utils/schema";
import { errorMessage } from "@veyyon/utils";
import { parseJsonWithRepair } from "@veyyon/utils/json-parse";
import { isRecord } from "@veyyon/utils/type-guards";

export const MAX_REPAIR_INPUT_BYTES = 1_048_576;

export type ToolCallRepairOutcome =
	| { status: "clean"; arguments: Record<string, unknown>; hints: readonly string[] }
	| { status: "repaired"; arguments: Record<string, unknown>; hints: readonly string[] }
	| { status: "unrepairable"; reason: string; hints: readonly string[] };

export function isToolCallRepairDisabled(): boolean {
	const value = process.env.VEYYON_REPAIR_DISABLE?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function asObjectArgs(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	return value;
}

function propertyExpectsString(propertySchema: unknown): boolean {
	if (!isRecord(propertySchema)) return false;
	const type = propertySchema.type;
	if (type === "string") return true;
	if (Array.isArray(type)) return type.includes("string");
	return false;
}

function missingRequiredStringKeys(schema: Record<string, unknown>, args: Record<string, unknown>): string[] {
	if (schema.type !== "object") return [];
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const required = Array.isArray(schema.required)
		? schema.required.filter((k): k is string => typeof k === "string")
		: [];
	const missing: string[] = [];
	for (const key of required) {
		if (args[key] !== undefined) continue;
		const propertySchema = properties[key];
		if (propertyExpectsString(propertySchema)) missing.push(key);
	}
	return missing;
}

function stringCandidateKeys(args: Record<string, unknown>, missingRequired: ReadonlySet<string>): string[] {
	const candidates: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (key.startsWith("__")) continue;
		if (missingRequired.has(key)) continue;
		if (typeof value === "string") candidates.push(key);
	}
	return candidates;
}

const COMMON_KEY_ALIASES: ReadonlyMap<string, string> = new Map([
	["filepath", "path"],
	["file", "path"],
	["filename", "path"],
	["targetfile", "path"],
	["contents", "content"],
	["text", "content"],
	["body", "content"],
	["isrecursive", "recursive"],
	["recurse", "recursive"],
	["dir", "directory"],
	["folder", "directory"],
	["q", "query"],
	["searchquery", "query"],
	["operation", "op"],
	["action", "op"],
]);

function normalizeKeyName(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type AliasKeyRepairPlan =
	| { kind: "none" }
	| { kind: "renamed"; renames: ReadonlyMap<string, string> }
	| { kind: "ambiguous"; reason: string; hints: readonly string[] };

export function planAliasKeyRepairs(
	schema: Record<string, unknown>,
	args: Record<string, unknown>,
): AliasKeyRepairPlan {
	if (schema.type !== "object") return { kind: "none" };
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const declaredKeys = Object.keys(properties);
	if (declaredKeys.length === 0) return { kind: "none" };

	const declaredByNormalized = new Map<string, string>();
	const collidedNormalized = new Set<string>();
	for (const key of declaredKeys) {
		const normalized = normalizeKeyName(key);
		if (declaredByNormalized.has(normalized)) {
			collidedNormalized.add(normalized);
			continue;
		}
		declaredByNormalized.set(normalized, key);
	}
	for (const normalized of collidedNormalized) declaredByNormalized.delete(normalized);

	const declaredSet = new Set(declaredKeys);
	const unknownKeys = Object.keys(args).filter(key => !key.startsWith("__") && !declaredSet.has(key));
	if (unknownKeys.length === 0) return { kind: "none" };

	const proposals = new Map<string, string>();
	const targetSources = new Map<string, string[]>();

	for (const unknownKey of unknownKeys) {
		const normalized = normalizeKeyName(unknownKey);
		const candidates = new Set<string>();

		const normalizedMatch = declaredByNormalized.get(normalized);
		if (normalizedMatch) candidates.add(normalizedMatch);

		const aliasTarget = COMMON_KEY_ALIASES.get(normalized);
		if (aliasTarget && declaredSet.has(aliasTarget)) candidates.add(aliasTarget);

		if (candidates.size === 0) continue;
		if (candidates.size > 1) {
			const candidateList = Array.from(candidates).join(", ");
			return {
				kind: "ambiguous",
				reason:
					`Ambiguous repair for tool arguments: unrecognized field "${unknownKey}" matches multiple ` +
					`declared field(s) [${candidateList}]. Re-send the call with the exact field name.`,
				hints: [`Unrecognized: ${unknownKey}`, `Do not rely on the harness to guess among: ${candidateList}`],
			};
		}

		const [target] = candidates;
		if (args[target] !== undefined) {
			return {
				kind: "ambiguous",
				reason:
					`Ambiguous repair for tool arguments: unrecognized field "${unknownKey}" looks like an alias for ` +
					`"${target}", but "${target}" is already present in the call. Re-send the call without the duplicate field.`,
				hints: [`Duplicate: "${unknownKey}" vs "${target}"`, "Remove one of the two fields and re-send."],
			};
		}

		proposals.set(unknownKey, target);
		const sources = targetSources.get(target) ?? [];
		sources.push(unknownKey);
		targetSources.set(target, sources);
	}

	for (const [target, sources] of targetSources) {
		if (sources.length <= 1) continue;
		return {
			kind: "ambiguous",
			reason:
				`Ambiguous repair for tool arguments: field(s) [${sources.join(", ")}] all look like aliases for ` +
				`"${target}". Re-send the call with only the intended field.`,
			hints: [`Target: ${target}`, `Conflicting sources: ${sources.join(", ")}`],
		};
	}

	if (proposals.size === 0) return { kind: "none" };
	return { kind: "renamed", renames: proposals };
}

function applyAliasKeyRenames(
	args: Record<string, unknown>,
	renames: ReadonlyMap<string, string>,
): Record<string, unknown> {
	if (renames.size === 0) return args;
	const next: Record<string, unknown> = { ...args };
	for (const [unknownKey, target] of renames) {
		next[target] = next[unknownKey];
		delete next[unknownKey];
	}
	return next;
}

export function detectStrictUnknownKeyRepair(
	schema: Record<string, unknown>,
	args: Record<string, unknown>,
): { reason: string; hints: readonly string[] } | undefined {
	if (schema.type !== "object") return undefined;
	if (schema.additionalProperties !== false) return undefined;
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const declaredSet = new Set(Object.keys(properties));
	const unknownKeys = Object.keys(args).filter(key => !key.startsWith("__") && !declaredSet.has(key));
	if (unknownKeys.length === 0) return undefined;
	const allowedList = Array.from(declaredSet).join(", ") || "(none)";
	return {
		reason:
			`Unrecognized tool argument field(s) [${unknownKeys.join(", ")}] are not allowed by this tool's schema ` +
			`(strict: no additional properties). Remove them or use the documented field names.`,
		hints: [`Unrecognized: ${unknownKeys.join(", ")}`, `Allowed fields: ${allowedList}`],
	};
}

export function detectAmbiguousRequiredStringRepair(
	schema: Record<string, unknown>,
	args: Record<string, unknown>,
): { reason: string; hints: readonly string[] } | undefined {
	const missing = missingRequiredStringKeys(schema, args);
	if (missing.length === 0) return undefined;
	const missingSet = new Set(missing);
	const candidates = stringCandidateKeys(args, missingSet);
	if (candidates.length === 0) return undefined;
	if (candidates.length > 1 || missing.length > 1) {
		const reason =
			`Ambiguous repair for tool arguments: missing required field(s) [${missing.join(", ")}] ` +
			`with multiple plausible string source field(s) [${candidates.join(", ")}]. ` +
			`Re-send the call with explicit field names.`;
		return {
			reason,
			hints: [
				`Required: ${missing.join(", ")}`,
				`Do not rely on the harness to guess among: ${candidates.join(", ")}`,
			],
		};
	}
	return undefined;
}

function boundedRawJson(raw: string): string | { error: string } {
	if (raw.length > MAX_REPAIR_INPUT_BYTES) {
		return {
			error: `Tool argument JSON exceeds repair limit (${MAX_REPAIR_INPUT_BYTES} bytes); refusing repair.`,
		};
	}
	return raw;
}

function recoverFromParseSentinel(args: Record<string, unknown>): ToolCallRepairOutcome | undefined {
	if (!("__parseError" in args)) return undefined;
	const rawJson = typeof args.__rawJson === "string" ? args.__rawJson : "";
	if (rawJson.length === 0) {
		return {
			status: "unrepairable",
			reason: `Tool call arguments are not valid JSON: ${String(args.__parseError ?? "parse error")}`,
			hints: ["Fix the JSON syntax and re-send the tool call."],
		};
	}
	const bounded = boundedRawJson(rawJson);
	if (typeof bounded !== "string") {
		return { status: "unrepairable", reason: bounded.error, hints: ["Shorten the payload or fix JSON syntax."] };
	}
	try {
		const parsed = parseJsonWithRepair<unknown>(bounded);
		const objectArgs = asObjectArgs(parsed);
		if (!objectArgs) {
			return {
				status: "unrepairable",
				reason: "Repaired JSON is not an object; tool arguments must be a JSON object.",
				hints: ["Wrap tool arguments in a JSON object with named fields."],
			};
		}
		return {
			status: "repaired",
			arguments: objectArgs,
			hints: ["Recovered tool arguments from malformed JSON (trailing commas / relaxed parse)."],
		};
	} catch (error) {
		const message = errorMessage(error);
		return {
			status: "unrepairable",
			reason: `Tool call arguments are not valid JSON and could not be repaired: ${message}`,
			hints: ["Fix the JSON syntax and re-send the tool call."],
		};
	}
}

function recoverFromStringArguments(raw: string): ToolCallRepairOutcome | undefined {
	const bounded = boundedRawJson(raw);
	if (typeof bounded !== "string") {
		return { status: "unrepairable", reason: bounded.error, hints: ["Shorten the payload or fix JSON syntax."] };
	}
	try {
		const parsed = parseJsonWithRepair<unknown>(bounded);
		const objectArgs = asObjectArgs(parsed);
		if (!objectArgs) {
			return {
				status: "unrepairable",
				reason: "Tool arguments string parsed to a non-object value.",
				hints: ["Send tool arguments as a JSON object."],
			};
		}
		return {
			status: "repaired",
			arguments: objectArgs,
			hints: ["Parsed stringified tool arguments into a JSON object."],
		};
	} catch (error) {
		const message = errorMessage(error);
		return {
			status: "unrepairable",
			reason: `Could not parse stringified tool arguments: ${message}`,
			hints: ["Send tool arguments as a JSON object, not a bare string."],
		};
	}
}

export function repairToolCallArguments(tool: Tool, toolCall: ToolCall): ToolCallRepairOutcome {
	if (isToolCallRepairDisabled()) {
		const passthrough = asObjectArgs(toolCall.arguments) ?? (isRecord(toolCall.arguments) ? toolCall.arguments : {});
		return { status: "clean", arguments: passthrough, hints: [] };
	}

	const wireSchema = toolWireSchema(tool);

	const schemaAuthoredAsPlainJsonSchema = !isZodSchema(tool.parameters) && !isArkSchema(tool.parameters);

	let workingArgs: Record<string, unknown>;
	let hints: string[] = [];
	let repaired = false;

	if (typeof toolCall.arguments === "string") {
		const outcome = recoverFromStringArguments(toolCall.arguments);
		if (!outcome) {
			return {
				status: "unrepairable",
				reason: "Tool arguments must be a JSON object.",
				hints: [],
			};
		}
		if (outcome.status === "unrepairable") return outcome;
		workingArgs = outcome.arguments;
		hints = outcome.hints.slice();
		repaired = outcome.status === "repaired";
	} else {
		const objectArgs = asObjectArgs(toolCall.arguments);
		if (!objectArgs) {
			return {
				status: "unrepairable",
				reason: "Tool arguments must be a JSON object.",
				hints: ["Send a JSON object with the tool's parameter fields."],
			};
		}
		const parseRecovery = recoverFromParseSentinel(objectArgs);
		if (parseRecovery) {
			if (parseRecovery.status === "unrepairable") return parseRecovery;
			workingArgs = parseRecovery.arguments;
			hints = parseRecovery.hints.slice();
			repaired = true;
		} else {
			workingArgs = objectArgs;
		}
	}

	const aliasPlan = planAliasKeyRepairs(wireSchema, workingArgs);
	if (aliasPlan.kind === "ambiguous") {
		return { status: "unrepairable", reason: aliasPlan.reason, hints: aliasPlan.hints };
	}
	if (aliasPlan.kind === "renamed") {
		workingArgs = applyAliasKeyRenames(workingArgs, aliasPlan.renames);
		repaired = true;
		const renameSummary = Array.from(aliasPlan.renames.entries())
			.map(([from, to]) => `${from} -> ${to}`)
			.join(", ");
		hints = hints.concat([`Renamed alias/typo field name(s) to the declared schema name: ${renameSummary}.`]);
	}

	const strictUnknownKey = schemaAuthoredAsPlainJsonSchema
		? detectStrictUnknownKeyRepair(wireSchema, workingArgs)
		: undefined;
	if (strictUnknownKey) {
		return { status: "unrepairable", reason: strictUnknownKey.reason, hints: strictUnknownKey.hints };
	}

	const ambiguity = detectAmbiguousRequiredStringRepair(wireSchema, workingArgs);
	if (ambiguity) {
		return { status: "unrepairable", reason: ambiguity.reason, hints: ambiguity.hints };
	}

	if (repaired) {
		return { status: "repaired", arguments: workingArgs, hints };
	}
	return { status: "clean", arguments: workingArgs, hints: [] };
}

export function formatRepairCoachingHints(hints: readonly string[]): string | undefined {
	if (hints.length === 0) return undefined;
	return ["[Tool argument repair]", ...hints.map(h => `- ${h}`)].join("\n");
}
