import { YAML } from "bun";
import { truncate } from "./format";
import * as logger from "./logger";
import { kebabToCamel } from "./string-case";

function stripHtmlComments(content: string): string {
	return content.replace(/<!--[\s\S]*?-->/g, "");
}

/** Recursively normalize object keys from kebab-case to camelCase */
function normalizeKeys<T>(obj: T): T {
	if (obj === null || typeof obj !== "object") return obj;
	return (Array.isArray(obj) ? normalizeArrayKeys(obj) : normalizeRecordKeys(obj as Record<string, unknown>)) as T;
}

/** `items` with every element's keys normalized; `items` itself when no element changed. */
function normalizeArrayKeys(items: unknown[]): unknown[] {
	let changed = false;
	const out: unknown[] = new Array(items.length);
	for (let i = 0; i < items.length; i++) {
		const v = items[i];
		const nv = normalizeKeys(v);
		out[i] = nv;
		if (nv !== v) changed = true;
	}
	return changed ? out : items;
}

/** `record` with kebab-case keys in camelCase at every depth; `record` itself when no key or value changed. */
function normalizeRecordKeys(record: Record<string, unknown>): Record<string, unknown> {
	let changed = false;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(record)) {
		const value = record[key];
		const nk = key.includes("-") ? kebabToCamel(key) : key;
		const nv = normalizeKeys(value);
		result[nk] = nv;
		if (nk !== key || nv !== value) changed = true;
	}
	return changed ? result : record;
}

const PLAIN_SCALAR_KEY_VALUE = /^(\s*[A-Za-z_][\w-]*:\s+)(\S.*?)(\s*)$/;
const FLOW_OR_EXPLICIT_VALUE_START = new Set(['"', "'", "[", "{", "|", ">", "!", "&", "*", "#"]);

function quoteAmbiguousPlainScalars(metadata: string): string | undefined {
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

function parseYamlRecord(metadata: string): Record<string, unknown> | null {
	const loaded = YAML.parse(metadata.replaceAll("\t", "  "));
	if (loaded === null || loaded === undefined) return null;
	if (typeof loaded !== "object" || Array.isArray(loaded)) return null;
	return loaded as Record<string, unknown>;
}

const KEY_VALUE_LINE = /^([\w-]+):\s*(.*)$/;

/**
 * Report the YAML failure `error` at `level`, thrown as a `FrontmatterError` at
 * `fatal`, then read `metadata` as plain `key: value` lines over `frontmatter`.
 */
function keyValueFrontmatter(
	metadata: string,
	frontmatter: Record<string, unknown>,
	error: unknown,
	source: unknown,
	level: "off" | "warn" | "fatal",
): Record<string, unknown> {
	const err = new FrontmatterError(error instanceof Error ? error : new Error(`YAML: ${error}`), source);
	if (level === "warn" || level === "fatal") {
		logger.warn("Failed to parse YAML frontmatter", { err: err.toString() });
	}
	if (level === "fatal") {
		throw err;
	}
	for (const line of metadata.split("\n")) {
		const match = line.match(KEY_VALUE_LINE);
		if (match) {
			frontmatter[match[1]] = match[2].trim();
		}
	}
	return normalizeKeys(frontmatter);
}

export class FrontmatterError extends Error {
	constructor(
		error: Error,
		readonly source?: unknown,
	) {
		super(`Failed to parse YAML frontmatter (${source}): ${error.message}`, { cause: error });
		this.name = "FrontmatterError";
	}

	toString(): string {
		// Format the error with stack and detail, including the error message, stack, and source if present
		const details: string[] = [this.message];
		if (this.source !== undefined) {
			details.push(`Source: ${JSON.stringify(this.source)}`);
		}
		if (this.cause && typeof this.cause === "object" && "stack" in this.cause && this.cause.stack) {
			details.push(`Stack:\n${this.cause.stack}`);
		} else if (this.stack) {
			details.push(`Stack:\n${this.stack}`);
		}
		return details.join("\n\n");
	}
}

export interface FrontmatterOptions {
	/** Source of the content (alias: source) */
	location?: unknown;
	/** Source of the content (alias for location) */
	source?: unknown;
	/** Fallback frontmatter values */
	fallback?: Record<string, unknown>;
	/** Normalize the content */
	normalize?: boolean;
	/** Level of error handling */
	level?: "off" | "warn" | "fatal";
}

/**
 * Parse YAML frontmatter from markdown content
 * Returns { frontmatter, body } where body has frontmatter stripped
 */
export function parseFrontmatter(
	content: string,
	options?: FrontmatterOptions,
): { frontmatter: Record<string, unknown>; body: string } {
	const { location, source, fallback, normalize = true, level = "warn" } = options ?? {};
	const loc = location ?? source;
	const frontmatter: Record<string, unknown> = { ...fallback };

	const normalized = normalize ? stripHtmlComments(content.replace(/\r\n?/g, "\n")) : content;
	if (!normalized.startsWith("---")) {
		return { frontmatter, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, body: normalized };
	}

	const metadata = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	try {
		const loaded = parseYamlRecord(metadata);
		return { frontmatter: normalizeKeys({ ...frontmatter, ...loaded }), body };
	} catch (error) {
		const quotedMetadata = quoteAmbiguousPlainScalars(metadata);
		if (quotedMetadata) {
			try {
				const loaded = parseYamlRecord(quotedMetadata);
				return { frontmatter: normalizeKeys({ ...frontmatter, ...loaded }), body };
			} catch {
				// Fall through to the existing warning + simple key/value fallback.
			}
		}

		const errorSource = loc ?? `Inline '${truncate(content, 64)}'`;
		return { frontmatter: keyValueFrontmatter(metadata, frontmatter, error, errorSource, level), body };
	}
}
