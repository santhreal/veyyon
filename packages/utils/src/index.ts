export { once, untilAborted } from "./abortable";
export * from "./array";
export * from "./async";
export * from "./atomic-write";
export * from "./backoff";
export * from "./binary";
export * from "./collapse-whitespace";
export * from "./color";
export * from "./content-text";
export * from "./dirs";
export * from "./env";
export * from "./fetch-retry";
export * from "./file-lock";
export * from "./format";
export * from "./frontmatter";
export * from "./fs-error";
export * from "./glob";
export * from "./json";
export * from "./json-parse";
export * from "./jwt";
export * from "./levenshtein";
export * from "./lines";
export * as logger from "./logger";
export * from "./loop-phase";
export * from "./math";
export * from "./mermaid-ascii";
export * from "./mime";
export * from "./path";
export * from "./path-tree";
export * from "./peek-file";
export * as postmortem from "./postmortem";
export * as procmgr from "./procmgr";
export * as prompt from "./prompt";
export * as ptree from "./ptree";
export { AbortError, ChildProcess, Exception, NonZeroExitError } from "./ptree";
export * from "./regex";
export * from "./runtime-install";
export * from "./sanitize-text";
export * from "./scoped-timeout";
export * from "./sleep";
export * from "./snowflake";
export * from "./stderr-guard";
export * from "./stream";
export * from "./string-case";
export * from "./strip-ansi";
export * from "./tab-spacing";
export * from "./temp";
export * from "./time";
export * from "./tls-fetch";
export * from "./tokens";
export * from "./type-guards";
export * from "./url";
export * from "./which";

function isPlainObject(val: object): val is Record<string, unknown> {
	return Object.getPrototypeOf(val) === Object.prototype || Array.isArray(val);
}

export function structuredCloneJSON<T>(value: T): T {
	// primitives|null|undefined, copy
	if (!value || typeof value !== "object") {
		return value;
	}

	// deep clone
	if (isPlainObject(value)) {
		try {
			return structuredClone(value);
		} catch {
			// might still fail due to nested structures
		}
	}
	return JSON.parse(JSON.stringify(value)) as T;
}
