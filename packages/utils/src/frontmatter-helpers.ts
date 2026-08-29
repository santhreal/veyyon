import { YAML } from "bun";
import { kebabToCamel } from "./string-case";

export function stripHtmlComments(content: string): string {
	return content.replace(/<!--[\s\S]*?-->/g, "");
}

export function normalizeKeys<T>(obj: T): T {
	if (obj === null || typeof obj !== "object") return obj;
	if (Array.isArray(obj)) {
		let changed = false;
		const out: unknown[] = new Array(obj.length);
		for (let i = 0; i < obj.length; i++) {
			const v = obj[i];
			const nv = normalizeKeys(v);
			out[i] = nv;
			if (nv !== v) changed = true;
		}
		return (changed ? (out as unknown) : obj) as T;
	}
	let changed = false;
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		const nk = key.includes("-") ? kebabToCamel(key) : key;
		const nv = normalizeKeys(value);
		result[nk] = nv;
		if (nk !== key || nv !== value) changed = true;
	}
	return (changed ? result : obj) as T;
}

export const PLAIN_SCALAR_KEY_VALUE = /^(\s*[A-Za-z_][\w-]*:\s+)(\S.*?)(\s*)$/;
export const FLOW_OR_EXPLICIT_VALUE_START = new Set(['"', "'", "[", "{", "|", ">", "!", "&", "*", "#"]);

export function quoteAmbiguousPlainScalars(metadata: string): string | undefined {
	let changed = false;
	const lines = metadata.split("\n").map(line => {
		const match = line.match(PLAIN_SCALAR_KEY_VALUE);
		if (!match) return line;
		const [, prefix, rawValue, suffix] = match;
		const value = rawValue.trimEnd();
		if (!value.includes(": ")) return line;
		if (FLOW_OR_EXPLICIT_VALUE_START.has(value[0])) return line;
		changed = true;
		return `${prefix}${JSON.stringify(value)}${suffix}`;
	});
	return changed ? lines.join("\n") : undefined;
}

export function parseYamlRecord(metadata: string): Record<string, unknown> | null {
	const loaded = YAML.parse(metadata.replaceAll("\t", "  "));
	if (loaded === null || loaded === undefined) return null;
	if (typeof loaded !== "object" || Array.isArray(loaded)) return null;
	return loaded as Record<string, unknown>;
}
