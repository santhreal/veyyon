import { parseJsonWithRepair } from "@veyyon/utils";

export interface YieldDetails {
	data?: unknown;
	status: "success" | "aborted";
	error?: string;
	type?: string | string[];
	useLastTurn?: boolean;
	schemaOverridden?: boolean;
}

export function formatSchema(schema: unknown): string {
	if (schema === undefined) return "No schema provided.";
	if (typeof schema === "string") return schema;
	try {
		return JSON.stringify(schema, null, 2);
	} catch {
		return "[unserializable schema]";
	}
}

export function looseRecordSchema(description: string): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: true,
		description,
	};
}

export function hasUnresolvedRefs(schema: unknown): boolean {
	if (schema == null) return false;
	if (Array.isArray(schema)) {
		for (const item of schema) {
			if (hasUnresolvedRefs(item)) return true;
		}
		return false;
	}
	if (typeof schema !== "object") return false;
	const record = schema as Record<string, unknown>;
	if (typeof record.$ref === "string") return true;
	for (const key in record) {
		if (key === "const" || key === "default" || key === "enum" || key === "examples") continue;
		if (hasUnresolvedRefs(record[key])) return true;
	}
	return false;
}

export const yieldTypeSchema: Record<string, unknown> = {
	anyOf: [
		{ type: "string" },
		{
			type: "array",
			minItems: 1,
			items: { type: "string" },
		},
	],
	description: "Optional result type. A non-empty string array is incremental; a string is terminal.",
};

export function isYieldType(value: unknown): value is string | string[] {
	return (
		typeof value === "string" ||
		(Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string"))
	);
}

export function parseYieldType(value: unknown): string | string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (isYieldType(value)) return value;
	throw new Error("type must be a string or non-empty array of strings");
}

export function formatYieldLabels(labels: readonly string[]): string {
	if (labels.length === 0) return '""';
	return labels.map(label => `"${label}"`).join(", ");
}

export function withSectionVariants(dataSchema: Record<string, unknown>): Record<string, unknown> {
	if (dataSchema.type !== "object") return dataSchema;
	const props = dataSchema.properties;
	if (props === null || typeof props !== "object") return dataSchema;
	const propRecord = props as Record<string, unknown>;
	const { description, ...fullWithoutDescription } = dataSchema;
	const branches: unknown[] = [];
	const seen = new Set<string>();
	const add = (schema: unknown): void => {
		if (schema === null || typeof schema !== "object") return;
		const key = JSON.stringify(schema);
		if (seen.has(key)) return;
		seen.add(key);
		branches.push(schema);
	};
	add(fullWithoutDescription);
	for (const name in propRecord) {
		const prop = propRecord[name];
		add(prop);
		if (prop !== null && typeof prop === "object") {
			const propObj = prop as Record<string, unknown>;
			if (propObj.type === "array") add(propObj.items);
		}
	}
	if (branches.length <= 1) return dataSchema;
	return description !== undefined ? { description, anyOf: branches } : { anyOf: branches };
}

export function wrapYieldParameters(dataSchema: Record<string, unknown>): Record<string, unknown> {
	const successResultSchema = {
		type: "object",
		additionalProperties: false,
		description: "task succeeded",
		properties: { data: dataSchema },
		required: ["data"],
	};
	const errorResultSchema = {
		type: "object",
		additionalProperties: false,
		properties: {
			error: { type: "string", description: "error message" },
		},
		required: ["error"],
	};
	const lastTurnResultSchema = {
		type: "object",
		additionalProperties: false,
		description: "typed task succeeded; data omitted so the last assistant turn is used",
		properties: {},
		required: [],
	};
	return {
		type: "object",
		additionalProperties: false,
		description: "submit data or error",
		properties: {
			type: yieldTypeSchema,
			result: {
				anyOf: [successResultSchema, errorResultSchema, lastTurnResultSchema],
			},
		},
		required: ["result"],
	};
}

export const MAX_SCHEMA_RETRIES = 3;

export const MAX_EMPTY_RESULT_RETRIES = 3;

export const RESULT_SHAPES =
	'Send success as `{ "result": { "data": <your output> } }` or failure as `{ "result": { "error": "message" } }`.';

export function coerceResultObject(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const text = value.trim();
	if (!text.startsWith("{")) return value;
	try {
		return parseJsonWithRepair<unknown>(text);
	} catch {
		return value;
	}
}

export function describeResultShape(value: unknown): string {
	if (value === undefined) return "nothing";
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value === "string") return "a string";
	return `a ${typeof value}`;
}
