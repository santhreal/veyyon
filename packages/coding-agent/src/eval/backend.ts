import { buildEvalUrlRoots, type LocalProtocolOptions } from "../internal-urls/local-protocol";
import type { ToolSession } from "../tools";
import type { EvalDisplayOutput, EvalLanguage, EvalStatusEvent } from "./types";

export interface ExecutorBackendExecOptions {
	cwd: string;
	sessionId: string;
	sessionFile: string | undefined;
	kernelOwnerId: string | undefined;
	signal?: AbortSignal;
	session: ToolSession;
	idleTimeoutMs?: number;
	reset: boolean;
	onChunk: (chunk: string) => void;
	onStatus?: (event: EvalStatusEvent) => void;
}

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

export interface ExecutorBackend {
	readonly id: EvalLanguage;
	readonly label: string;
	readonly highlightLang: string;
	isAvailable(session: ToolSession): Promise<boolean>;
	execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult>;
}

export function resolveEvalUrlRoots(session: ToolSession): Record<string, string> {
	const options: LocalProtocolOptions = session.localProtocolOptions ?? {
		getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
		getSessionId: () => session.getSessionId?.() ?? null,
	};
	return buildEvalUrlRoots(options);
}
