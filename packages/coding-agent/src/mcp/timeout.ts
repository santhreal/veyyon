import { logger } from "@veyyon/pi-utils";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;

let neverAbortController: AbortController | undefined;

function resolveMcpTimeoutEnv(): string | undefined {
	return Bun.env.VEYYON_MCP_TIMEOUT_MS ?? Bun.env.OMP_MCP_TIMEOUT_MS;
}

export function resolveMCPTimeoutMs(configTimeout?: number): number {
	const raw = resolveMcpTimeoutEnv()?.trim();
	if (raw) {
		const value = Number(raw);
		if (Number.isFinite(value) && value >= 0) return value;
		logger.warn(
			"Ignoring invalid VEYYON_MCP_TIMEOUT_MS / OMP_MCP_TIMEOUT_MS env value; expected a non-negative number",
			{
				value: raw,
			},
		);
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
	const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
	const operationSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;

	return {
		signal: operationSignal,
		clear: () => clearTimeout(timeoutId),
		isTimeoutAbort: error =>
			error instanceof Error && error.name === "AbortError" && abortController.signal.aborted && !signal?.aborted,
	};
}
