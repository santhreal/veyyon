import { errorMessage, isCancellation, isTimeoutError } from "@veyyon/utils";
import { OutputSink } from "../../session/streaming-output";
import type { ToolSession } from "../../tools";
import { inlineBudgetFor } from "../../tools/output-artifact";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../../tools/output-meta";
import { scopedTimeoutSignal } from "../../utils/fetch-timeout";
import { isEvalTimeoutControlEvent } from "../bridge-timeout";
import { executeInVmContext, type JsDisplayOutput } from "./context-manager";
import type { JsStatusEvent } from "./shared/types";

export interface JsExecutorOptions {
	cwd?: string;
	timeoutMs?: number;
	deadlineMs?: number;
	idleTimeoutMs?: number;
	onChunk?: (chunk: string) => Promise<void> | void;
	onStatus?: (event: JsStatusEvent) => void;
	signal?: AbortSignal;
	sessionId: string;
	kernelOwnerId?: string;
	reset?: boolean;
	sessionFile?: string;
	artifactPath?: string;
	artifactId?: string;
	session: ToolSession;
	localRoots?: Record<string, string>;
	artifactsDir?: string | null;
}

export interface JsResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId?: string;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: JsDisplayOutput[];
}

function getExecutionTimeoutMs(options: Pick<JsExecutorOptions, "deadlineMs" | "timeoutMs">): number | undefined {
	if (options.deadlineMs !== undefined) {
		return Math.max(1, options.deadlineMs - Date.now());
	}
	return options.timeoutMs;
}

function formatJsTimeoutAnnotation(timeoutMs: number | undefined): string {
	const reset = "The JS worker was force-killed and its VM state was reset; variables from earlier cells are gone.";
	if (timeoutMs === undefined) return `Command timed out. ${reset}`;
	const secs = Math.max(1, Math.round(timeoutMs / 1000));
	return `Command timed out after ${secs} seconds. ${reset}`;
}

export async function executeJs(code: string, options: JsExecutorOptions): Promise<JsResult> {
	const displayOutputs: JsDisplayOutput[] = [];
	const outputSink = new OutputSink({
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		spillThreshold: inlineBudgetFor(options.session),
		headBytes: resolveOutputSinkHeadBytes(options.session.settings),
		maxColumns: resolveOutputMaxColumns(options.session.settings),
		onChunk: chunk => options.onChunk?.(chunk),
	});
	const legacyTimeoutMs = getExecutionTimeoutMs(options);
	const scopedTimeout =
		typeof legacyTimeoutMs === "number" && Number.isFinite(legacyTimeoutMs) && legacyTimeoutMs > 0
			? scopedTimeoutSignal(legacyTimeoutMs, options.signal)
			: undefined;
	const signal = scopedTimeout ? scopedTimeout.signal : options.signal;
	const acquireBudgetMs = legacyTimeoutMs ?? options.idleTimeoutMs;

	try {
		await executeInVmContext({
			sessionKey: options.sessionId,
			sessionId: options.sessionId,
			ownerId: options.kernelOwnerId,
			cwd: options.cwd ?? options.session.cwd,
			session: options.session,
			localRoots: options.localRoots,
			artifactsDir: options.artifactsDir,
			reset: options.reset,
			code,
			filename: `js-cell-${crypto.randomUUID()}.js`,
			timeoutMs: acquireBudgetMs,
			runState: {
				signal,
				onText: chunk => outputSink.push(chunk),
				onDisplay: output => {
					if (output.type === "status") {
						options.onStatus?.(output.event);
						if (isEvalTimeoutControlEvent(output.event)) return;
					}
					displayOutputs.push(output);
				},
			},
		});
		const summary = await outputSink.dump();
		return {
			output: summary.output,
			exitCode: 0,
			cancelled: false,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			displayOutputs,
		};
	} catch (error) {
		if (signal?.aborted || isCancellation(error)) {
			const timedOut = isTimeoutError(signal?.reason) || isTimeoutError(options.signal?.reason);
			if (timedOut) {
				outputSink.push(formatJsTimeoutAnnotation(legacyTimeoutMs ?? options.idleTimeoutMs));
			}
			const summary = await outputSink.dump();
			return {
				output: summary.output,
				exitCode: undefined,
				cancelled: true,
				truncated: summary.truncated,
				artifactId: summary.artifactId,
				totalLines: summary.totalLines,
				totalBytes: summary.totalBytes,
				outputLines: summary.outputLines,
				outputBytes: summary.outputBytes,
				displayOutputs,
			};
		}
		const message = error instanceof Error ? (error.stack ?? error.message) : errorMessage(error);
		outputSink.push(message);
		const summary = await outputSink.dump();
		return {
			output: summary.output,
			exitCode: 1,
			cancelled: false,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			displayOutputs,
		};
	}
}
