export { isAbortOrTimeoutError, once, untilAborted } from "./abortable";
export * from "./async";
export * from "./atomic-write";
export * from "./binary";
export * from "./color";
export * from "./dirs";
export * from "./env";
export * from "./fetch-retry";
export * from "./format";
export * from "./frontmatter";
export * from "./fs-error";
export * from "./glob";
export * from "./json";
export * from "./json-parse";
export * from "./levenshtein";
export * from "./lines";
export * as logger from "./logger";
export * from "./loop-phase";
export * from "./mermaid-ascii";
export * from "./mime";
export * from "./path";
export * from "./path-tree";
export * from "./peek-file";
export * as postmortem from "./postmortem";
export * from "./process";
export * as procmgr from "./procmgr";
export * as prompt from "./prompt";
export * as ptree from "./ptree";
export { AbortError, ChildProcess, Exception, NonZeroExitError } from "./ptree";
export * from "./regex";
export * from "./runtime-install";
export * from "./sanitize-text";
export * from "./search";
export * from "./similarity";
export * from "./snowflake";
export * from "./stderr-guard";
export * from "./stream";
export * from "./strip-ansi";
export * from "./tab-spacing";
export * from "./task-result";
export * from "./temp";
export * from "./text-blocks";
export * from "./tls-fetch";
export * from "./tokens";
export * from "./type-guards";
export * from "./url";
export * from "./which";

// Deliberately includes arrays: "safe to hand to structuredClone" — NOT an
// isRecord/isPlainObject guard (those live in type-guards.ts).
function isPlainJsonContainer(val: object): val is Record<string, unknown> {
	return Object.getPrototypeOf(val) === Object.prototype || Array.isArray(val);
}

export function structuredCloneJSON<T>(value: T): T {
	// primitives|null|undefined, copy
	if (!value || typeof value !== "object") {
		return value;
	}

	// deep clone
	if (isPlainJsonContainer(value)) {
		try {
			return structuredClone(value);
		} catch {
			// might still fail due to nested structures
		}
	}
	return JSON.parse(JSON.stringify(value)) as T;
}
