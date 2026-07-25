import { isAbortError, isTimeoutError, logger } from "@veyyon/utils";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;

let neverAbortController: AbortController | undefined;

function resolveMcpTimeoutEnv(): string | undefined {
	return Bun.env.VEYYON_MCP_TIMEOUT_MS;
}

export function resolveMCPTimeoutMs(configTimeout?: number): number {
	const raw = resolveMcpTimeoutEnv()?.trim();
	if (raw) {
		const value = Number(raw);
		if (Number.isFinite(value) && value >= 0) return value;
		logger.warn("Ignoring invalid VEYYON_MCP_TIMEOUT_MS env value; expected a non-negative number", {
			value: raw,
		});
	}
	return configTimeout ?? DEFAULT_MCP_TIMEOUT_MS;
}

export function isMCPTimeoutEnabled(timeoutMs: number): boolean {
	return timeoutMs > 0;
}

export function describeMCPTimeout(timeoutMs: number): string {
	return isMCPTimeoutEnabled(timeoutMs) ? `${timeoutMs}ms` : "disabled";
}

export function getNeverAbortSignal(): AbortSignal {
	neverAbortController ??= new AbortController();
	return neverAbortController.signal;
}

export function createMCPTimeout(
	timeoutMs: number,
	signal?: AbortSignal,
): {
	signal?: AbortSignal;
	clear: () => void;
	isTimeoutAbort: (error: unknown) => boolean;
} {
	if (!isMCPTimeoutEnabled(timeoutMs)) {
		return {
			signal,
			clear: () => {},
			isTimeoutAbort: () => false,
		};
	}

	const abortController = new AbortController();
	// Abort WITH a reason that names itself. A bare `abort()` raises the
	// platform's generic "AbortError", so the only way left to tell "the deadline
	// expired" from "the user pressed Ctrl-C" was to inspect both signals after
	// the fact, and that inference is wrong the moment the two race: a user abort
	// landing microseconds before the timer reads as a timeout. A named reason
	// travels with the error, so the error itself carries the answer.
	const timeoutId = setTimeout(
		() => abortController.abort(new DOMException(`MCP call exceeded ${timeoutMs}ms`, "TimeoutError")),
		timeoutMs,
	);
	const operationSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;

	return {
		signal: operationSignal,
		clear: () => clearTimeout(timeoutId),
		// Ask the error first. The second test is not a fallback in the banned
		// sense — it is the case where a transport swallows the reason and throws
		// its own generic AbortError, which the MCP SDK's fetch wrappers do, and
		// it stays narrow: our controller fired and the caller's signal did not.
		isTimeoutAbort: error =>
			isTimeoutError(error) || (isAbortError(error) && abortController.signal.aborted && !signal?.aborted),
	};
}
