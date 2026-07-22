import { clampLow } from "@veyyon/utils";

export interface ToolTimeoutConfig {
	/** Default timeout in seconds when agent omits the field */
	default: number;
	/** Minimum allowed timeout in seconds */
	min: number;
	/** Maximum allowed timeout in seconds (per-tool ceiling) */
	max: number;
}

export const TOOL_TIMEOUTS = {
	bash: { default: 300, min: 1, max: 3600 },
	eval: { default: 30, min: 1, max: 3600 },
	browser: { default: 30, min: 1, max: 300 },
	ssh: { default: 60, min: 1, max: 3600 },
	fetch: { default: 30, min: 1, max: 45 },
	lsp: { default: 20, min: 5, max: 60 },
	debug: { default: 30, min: 5, max: 300 },
} as const satisfies Record<string, ToolTimeoutConfig>;

export type ToolWithTimeout = keyof typeof TOOL_TIMEOUTS;

/**
 * Clamp a raw timeout to the allowed range for a tool.
 * If rawTimeout is undefined, returns the tool's default.
 */
export function clampTimeout(tool: ToolWithTimeout, rawTimeout?: number): number {
	const config = TOOL_TIMEOUTS[tool];
	const timeout = rawTimeout ?? config.default;
	return clampLow(timeout, config.min, config.max);
}

/**
 * A human-readable notice when a requested timeout was clamped, so the clamp is
 * surfaced to the caller instead of silently changing the requested budget
 * (Law 10: no silent adjustment of a requested parameter). Returns `undefined`
 * when the request was honored unchanged. Co-located with {@link clampTimeout}
 * and {@link TOOL_TIMEOUTS} so the allowed range in the message always matches
 * the range that actually clamped, for every tool.
 */
export function formatTimeoutClampNotice(
	tool: ToolWithTimeout,
	requestedSec: number | undefined,
	effectiveSec: number,
): string | undefined {
	// `undefined` means the caller requested no specific timeout (the field was
	// omitted), so nothing was clamped from anything: the tool's default applies
	// and there is nothing to report. Handling it here — rather than each caller
	// pre-massaging the value with `?? effectiveSec` or a destructuring default —
	// keeps every tool on one call idiom and stops an omitted timeout from
	// rendering as the garbage notice "requested undefineds".
	if (requestedSec === undefined || requestedSec === effectiveSec) return undefined;
	const { min, max } = TOOL_TIMEOUTS[tool];
	return `Timeout clamped to ${effectiveSec}s (requested ${requestedSec}s; allowed range ${min}-${max}s).`;
}

/**
 * The model-facing description for a tool's `timeout` schema parameter, built
 * from {@link TOOL_TIMEOUTS} so the default and range the model is told always
 * match the values {@link clampTimeout} actually enforces. Stating the range up
 * front lets the model pick an in-range value instead of learning it was clamped
 * only after the fact (the notice from {@link formatTimeoutClampNotice} is the
 * safety net, not the primary channel). Pass `zeroDisablesNoun` for the tools
 * whose `0` is an explicit no-deadline contract (bash, eval); the others clamp
 * `0` up to `min` like any below-floor value.
 */
export function describeTimeoutParam(tool: ToolWithTimeout, opts?: { zeroDisablesNoun?: string }): string {
	const { default: def, min, max } = TOOL_TIMEOUTS[tool];
	const zero = opts?.zeroDisablesNoun ? `; 0 disables the ${opts.zeroDisablesNoun}` : "";
	return `timeout in seconds${zero}; default ${def}, clamped to ${min}-${max}`;
}
