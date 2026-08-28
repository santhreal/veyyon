import { clampLow } from "@veyyon/utils/math";

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

/** Clamp a raw timeout to the allowed range for a tool. When `rawTimeout` is undefined the tool's `default` is used. A positive */
export function clampTimeout(tool: ToolWithTimeout, rawTimeout?: number, maxTimeout?: number): number {
	const config = TOOL_TIMEOUTS[tool];
	const timeout = rawTimeout ?? config.default;
	const capped = maxTimeout !== undefined && maxTimeout > 0 ? Math.min(timeout, maxTimeout) : timeout;
	return clampLow(capped, config.min, config.max);
}

/** A human-readable notice when a requested timeout was clamped, so the clamp is surfaced to the caller instead of silently changing the requested budget */
export function formatTimeoutClampNotice(
	tool: ToolWithTimeout,
	requestedSec: number | undefined,
	effectiveSec: number,
): string | undefined {
	// `undefined` means the caller requested no specific timeout (the field was omitted), so nothing was clamped from anything: the tool's default applies
	if (requestedSec === undefined || requestedSec === effectiveSec) return undefined;
	const { min, max } = TOOL_TIMEOUTS[tool];
	return `Timeout clamped to ${effectiveSec}s (requested ${requestedSec}s; allowed range ${min}-${max}s).`;
}

/** The model-facing description for a tool's `timeout` schema parameter, built from {@link TOOL_TIMEOUTS} so the default and range the model is told always */
export function describeTimeoutParam(tool: ToolWithTimeout, opts?: { zeroDisablesNoun?: string }): string {
	const { default: def, min, max } = TOOL_TIMEOUTS[tool];
	const zero = opts?.zeroDisablesNoun ? `; 0 disables the ${opts.zeroDisablesNoun}` : "";
	return `timeout in seconds${zero}; default ${def}, clamped to ${min}-${max}`;
}
