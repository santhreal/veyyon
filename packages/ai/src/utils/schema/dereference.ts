import { isRecord } from "@veyyon/utils/type-guards";
import type { JsonObject } from "./types";

function resolveLocalRef(ref: string, root: JsonObject): JsonObject | undefined {
	const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
	if (!match) return undefined;

	const [, defsKey, name] = match;
	const defs = root[defsKey!];
	if (!isRecord(defs)) return undefined;

	const resolved = defs[name!];
	return isRecord(resolved) ? resolved : undefined;
}

function dereferenceNode(node: unknown, root: JsonObject, visiting: Set<string>): unknown {
	if (!isRecord(node)) return node;
	if (Array.isArray(node)) return node.map(item => dereferenceNode(item, root, visiting));

	const ref = node.$ref;
	if (typeof ref === "string") {
		if (visiting.has(ref)) return {};
		const resolved = resolveLocalRef(ref, root);
		if (!resolved) return node; // External ref — leave as-is
		visiting.add(ref);
		const inlined = dereferenceNode(resolved, root, visiting);
		visiting.delete(ref);

		let hasSiblings = false;
		for (const k in node) {
			if (k !== "$ref") {
				hasSiblings = true;
				break;
			}
		}
		if (!hasSiblings || !isRecord(inlined)) return inlined;
		const merged: JsonObject = { ...inlined, ...node };
		delete merged.$ref;
		return merged;
	}

	const result: JsonObject = {};
	for (const key in node) {
		const value = node[key];
		if (key === "$defs" || key === "definitions") continue;

		if (Array.isArray(value)) {
			result[key] = value.map(item => dereferenceNode(item, root, visiting));
		} else if (isRecord(value)) {
			result[key] = dereferenceNode(value, root, visiting);
		} else {
			result[key] = value;
		}
	}
	return result;
}

export function dereferenceJsonSchema(schema: unknown): unknown {
	if (!isRecord(schema)) return schema;

	const hasDefs = schema.$defs !== undefined || schema.definitions !== undefined;
	if (!hasDefs) return schema;

	return dereferenceNode(schema, schema, new Set());
}
