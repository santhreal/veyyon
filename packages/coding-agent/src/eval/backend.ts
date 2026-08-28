import { buildEvalUrlRoots, type LocalProtocolOptions } from "../internal-urls/local-protocol";
import type { ToolSession } from "../tools";
import type { EvalDisplayOutput, EvalLanguage, EvalStatusEvent } from "./types";

/** Per-cell execute() options. */
export interface ExecutorBackendExecOptions {
	cwd: string;
	sessionId: string;
	sessionFile: string | undefined;
	kernelOwnerId: string | undefined;
	signal?: AbortSignal;
	session: ToolSession;
	/** Runtime-work budget in milliseconds (the cell's `timeout`). Cancellation is driven entirely by `signal`, which the eval tool arms as a watchdog that */
	idleTimeoutMs?: number;
	reset: boolean;
	onChunk: (chunk: string) => void;
	/** Live status events (read/write/agent/…) delivered as they are emitted, before the cell finishes. The same events are also returned in */
	onStatus?: (event: EvalStatusEvent) => void;
}

/** Result returned by a backend's execute(). */
export interface ExecutorBackendResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId: string | undefined;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: EvalDisplayOutput[];
}

/** Pluggable language backend for the eval tool. */
export interface ExecutorBackend {
	readonly id: EvalLanguage;
	readonly label: string;
	/** Source language identifier passed to the syntax highlighter (e.g. "python", "javascript"). */
	readonly highlightLang: string;
	/** Cheap availability check. Used by fallback resolution. */
	isAvailable(session: ToolSession): Promise<boolean>;
	/** Execute one cell. Caller invokes once per cell and aggregates results. */
	execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult>;
}

/** Resolve the on-disk roots that the eval helpers substitute for internal-URL schemes (currently `local://`). Prefers the session's own */
export function resolveEvalUrlRoots(session: ToolSession): Record<string, string> {
	const options: LocalProtocolOptions = session.localProtocolOptions ?? {
		getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
		getSessionId: () => session.getSessionId?.() ?? null,
	};
	return buildEvalUrlRoots(options);
}
