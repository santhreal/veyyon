export { AbortError, isAbortError, isCancellation, isTimeoutError, once, untilAborted } from "./abortable";
export * from "./array";
export * from "./async";
export * from "./atomic-write";
export * from "./backoff";
export * from "./binary";
export * from "./byte-truncate";
export * from "./bytes";
export * from "./collapse-whitespace";
export * from "./color";
export * from "./conformance";
export * from "./content-text";
export * from "./dirs";
export * from "./env";
export * from "./fetch-retry";
export * from "./file-lock";
export * from "./format";
export * from "./frontmatter";
export * from "./fs-error";
export * from "./fs-optional";
export * from "./glob";
export * from "./json";
export * from "./json-parse";
export * from "./jsonl-bytes";
export * from "./jsonl-incremental";
export * from "./jwt";
export * from "./levenshtein";
export * from "./lines";
export * as logger from "./logger";
export * from "./loop-phase";
export * from "./math";
// NOT re-exported: `./mermaid-ascii`.
//
// The vendored diagram renderer is 35 modules, a third of everything this barrel reaches, and it
// has exactly one consumer (`coding-agent/src/modes/theme/mermaid-cache.ts`). Every file that
// imports `@veyyon/utils` for `errorMessage` or `logger` was instantiating a Mermaid parser, and
// the test runner gives each file its own realm, so that cost is paid per file rather than once:
// 664 test files import this barrel. Import it as `@veyyon/utils/mermaid-ascii` instead.
export * from "./mime";
export * from "./path";
export * from "./path-tree";
export * from "./peek-file";
export * as postmortem from "./postmortem";
export * from "./process-liveness";
export * as procmgr from "./procmgr";
export * as prompt from "./prompt";
export * from "./prompt-registry";
export * as ptree from "./ptree";
export { ChildProcess, Exception, NonZeroExitError, ProcessAbortError } from "./ptree";
export * from "./quarantine-file";
export * from "./read-selector";
export * from "./regex";
export * from "./ring";
export * from "./runtime-install";
export * from "./sanitize-text";
export * from "./scoped-timeout";
export * from "./semver";
export * from "./signal-exit";
export * from "./sleep";
export * from "./snowflake";
export * from "./stderr-guard";
export * from "./stream";
export * from "./string-case";
export * from "./string-length";
export * from "./strings";
export * from "./strip-ansi";
export * from "./tab-spacing";
export * from "./temp";
export * from "./theme-store";
export * from "./time";
export * from "./tls-fetch";
export * from "./tokens";
export * from "./type-guards";
export * from "./url";
export * from "./which";
export * from "./yaml-sync";

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
