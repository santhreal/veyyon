/** Helpers shared by the per-language eval backend definitions (jl/js/py/rb index modules): session-id namespacing, settings access, and projection of */
import type { ToolSession } from "../tools";
import {
	type ExecutorBackend,
	type ExecutorBackendExecOptions,
	type ExecutorBackendResult,
	resolveEvalUrlRoots,
} from "./backend";
import type { KernelExecutionResult, KernelExecutorBaseOptions, KernelMode } from "./executor-base";
import type { EvalDisplayOutput, EvalLanguage } from "./types";

export function namespaceSessionId(sessionId: string, prefix: string): string {
	return sessionId.startsWith(prefix) ? sessionId : `${prefix}${sessionId}`;
}

export function readSetting<T>(session: ToolSession, key: string): T | undefined {
	const settings = session.settings as { get?: (key: string) => T | undefined } | undefined;
	return settings?.get?.(key);
}

export function readInterpreterSetting(session: ToolSession, key: string): string | undefined {
	const value = readSetting<unknown>(session, key);
	return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function toExecutorBackendResult(result: {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId?: string | undefined;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: EvalDisplayOutput[];
}): ExecutorBackendResult {
	return {
		output: result.output,
		exitCode: result.exitCode,
		cancelled: result.cancelled,
		truncated: result.truncated,
		artifactId: result.artifactId,
		totalLines: result.totalLines,
		totalBytes: result.totalBytes,
		outputLines: result.outputLines,
		outputBytes: result.outputBytes,
		displayOutputs: result.displayOutputs,
	};
}

export interface CreateKernelBackendOptions<TOptions extends KernelExecutorBaseOptions> {
	id: EvalLanguage;
	label: string;
	highlightLang: string;
	settingPrefix: string;
	sessionPrefix: string;
	checkAvailability: (cwd: string, interpreter?: string) => Promise<{ ok: boolean }>;
	execute: (code: string, options: TOptions) => Promise<KernelExecutionResult>;
}

export function createKernelBackend<TOptions extends KernelExecutorBaseOptions>(
	config: CreateKernelBackendOptions<TOptions>,
): ExecutorBackend {
	const { id, label, highlightLang, settingPrefix, sessionPrefix, checkAvailability, execute } = config;
	return {
		id,
		label,
		highlightLang,
		async isAvailable(session: ToolSession): Promise<boolean> {
			const interpreter = readInterpreterSetting(session, `${settingPrefix}.interpreter`);
			const availability = await checkAvailability(session.cwd, interpreter);
			return availability.ok;
		},
		async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
			const interpreter = readInterpreterSetting(opts.session, `${settingPrefix}.interpreter`);
			const kernelMode = readSetting<KernelMode>(opts.session, `${settingPrefix}.kernelMode`);
			const executorOptions = {
				cwd: opts.cwd,
				kernelMode,
				idleTimeoutMs: opts.idleTimeoutMs,
				signal: opts.signal,
				sessionId: namespaceSessionId(opts.sessionId, sessionPrefix),
				interpreter,
				sessionFile: opts.sessionFile,
				artifactsDir: opts.session.getArtifactsDir?.() ?? undefined,
				localRoots: resolveEvalUrlRoots(opts.session),
				kernelOwnerId: opts.kernelOwnerId,
				reset: opts.reset,
				onChunk: opts.onChunk,
				onStatus: opts.onStatus,
				toolSession: opts.session,
			} as TOptions;
			const result = await execute(code, executorOptions);
			return toExecutorBackendResult(result);
		},
	};
}
