import { dereferenceJsonSchema } from "@veyyon/ai/utils/schema";
import { isRecord } from "@veyyon/utils";
import { buildOutputValidator } from "../tools/output-schema-validator";
import type { YieldItem } from "./types";

interface AssembledYieldResult {
	data: unknown;
	schemaOverridden: boolean;
	rawText: boolean;
	missingData: boolean;
}

function isIncrementalYieldType(type: YieldItem["type"]): type is string[] {
	return Array.isArray(type) && type.length > 0;
}

function getYieldLabels(type: YieldItem["type"]): string[] {
	if (typeof type === "string") {
		const label = type.trim();
		return label ? [label] : [];
	}
	if (!Array.isArray(type)) return [];
	const labels: string[] = [];
	for (const value of type) {
		if (typeof value !== "string") continue;
		const label = value.trim();
		if (label) labels.push(label);
	}
	return labels;
}

function resolveYieldPayload(
	item: YieldItem,
	lastAssistantText: string | undefined,
	labels: string[],
): { value: unknown; fromLastAssistantText: boolean; missingData: boolean } {
	const hasData = item.data !== undefined;
	const shouldUseLastTurn = item.useLastTurn === true || (labels.length > 0 && !hasData);
	if (shouldUseLastTurn && lastAssistantText !== undefined) {
		return {
			value: lastAssistantText,
			fromLastAssistantText: true,
			missingData: lastAssistantText.length === 0,
		};
	}
	return {
		value: item.data,
		fromLastAssistantText: false,
		missingData: item.data === undefined || item.data === null,
	};
}

function appendYieldSection(
	sections: Record<string, unknown>,
	sectionCounts: Map<string, number>,
	label: string,
	value: unknown,
	forceArray: boolean,
): void {
	const count = sectionCounts.get(label) ?? 0;
	const existing = sections[label];
	if (count === 0) {
		sections[label] = forceArray ? [value] : value;
	} else if (Array.isArray(existing)) {
		existing.push(value);
	} else {
		sections[label] = [existing, value];
	}
	sectionCounts.set(label, count + 1);
}

function isArrayTypedSchema(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.type === "array") return true;
	if (Array.isArray(record.type) && record.type.includes("array")) return true;
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const variants = record[key];
		if (Array.isArray(variants) && variants.some(isArrayTypedSchema)) return true;
	}
	return false;
}

export function arrayValuedLabels(outputSchema: unknown): ReadonlySet<string> {
	const labels = new Set<string>();
	const { jsonSchema } = buildOutputValidator(outputSchema);
	if (jsonSchema === undefined) return labels;
	const dereferenced = dereferenceJsonSchema(jsonSchema);
	const labelSchema = isRecord(dereferenced) ? dereferenced : jsonSchema;
	const properties = labelSchema.properties;
	if (!isRecord(properties)) return labels;
	for (const key in properties) {
		if (isArrayTypedSchema(properties[key])) labels.add(key);
	}
	return labels;
}

export function assembleYieldResult(
	yieldItems: YieldItem[],
	lastAssistantText?: string,
	arrayLabels?: ReadonlySet<string>,
): AssembledYieldResult | undefined {
	if (yieldItems.length === 0) return undefined;

	let terminalItem: YieldItem | undefined;
	for (let index = yieldItems.length - 1; index >= 0; index--) {
		const item = yieldItems[index];
		if (item && !isIncrementalYieldType(item.type)) {
			terminalItem = item;
			break;
		}
	}

	const sections: Record<string, unknown> = {};
	const sectionCounts = new Map<string, number>();
	let schemaOverridden = false;
	let missingData = false;
	let hasSections = false;
	for (const item of yieldItems) {
		if (item.status === "aborted") continue;
		if (!isIncrementalYieldType(item.type)) continue;
		schemaOverridden ||= item.schemaOverridden === true;
		const labels = getYieldLabels(item.type);
		const resolved = resolveYieldPayload(item, lastAssistantText, labels);
		missingData ||= resolved.missingData;
		for (const label of labels) {
			appendYieldSection(sections, sectionCounts, label, resolved.value, arrayLabels?.has(label) ?? false);
			hasSections = true;
		}
	}

	if (terminalItem && terminalItem.data !== undefined) {
		const resolved = resolveYieldPayload(terminalItem, lastAssistantText, []);
		const value = resolved.value;
		const merged =
			terminalItem.type === "result" && hasSections && isRecord(value) ? { ...sections, ...value } : value;
		return {
			data: merged,
			schemaOverridden: schemaOverridden || terminalItem.schemaOverridden === true,
			rawText: resolved.fromLastAssistantText && typeof merged === "string",
			missingData: resolved.missingData,
		};
	}

	if (hasSections) {
		return { data: sections, schemaOverridden, rawText: false, missingData };
	}

	if (!terminalItem) return undefined;
	const resolved = resolveYieldPayload(terminalItem, lastAssistantText, getYieldLabels(terminalItem.type));
	return {
		data: resolved.value,
		schemaOverridden: terminalItem.schemaOverridden === true,
		rawText: resolved.fromLastAssistantText && typeof resolved.value === "string",
		missingData: resolved.missingData,
	};
}
