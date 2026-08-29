import { isAbortError } from "@veyyon/utils/abortable";
import { errorMessage } from "@veyyon/utils/type-guards";
import { ToolError } from "../../tools/tool-errors";
import type { RuntimeHooks } from "./shared/runtime";
import type { EvalRunErrorPayload, EvalWorkerOutbound } from "./worker-protocol";

export interface PendingTool {
	runId: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
}

export interface ActiveRun {
	runId: string;
	filename: string;
	pendingTools: Map<string, PendingTool>;
	floatingRejections: unknown[];
}

export type RunResult = Extract<EvalWorkerOutbound, { type: "result" }>;

export type WorkerCoreOptions =
	| {
			mode: "isolated";
			chdir?: (cwd: string) => void;
			interceptUnhandledRejections?: (handler: (reason: unknown) => boolean) => () => void;
	  }
	| {
			mode: "inline";
			interceptUnhandledRejections(handler: (reason: unknown) => boolean): () => void;
	  };

export const RECENT_CELL_FILES_MAX = 256;

export function errorPayload(error: unknown): EvalRunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: isAbortError(error),
			isToolError: error.name === "ToolError" || error instanceof ToolError,
		};
	}
	return { message: errorMessage(error) };
}

export function errorFromPayload(payload: EvalRunErrorPayload): Error {
	const ctor = payload.isToolError ? ToolError : Error;
	const error = new ctor(payload.message);
	if (payload.name) error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

export function foldFloatingRejections(active: ActiveRun, result: RunResult, hooks: RuntimeHooks): RunResult {
	const rejections = active.floatingRejections;
	if (rejections.length === 0) return result;
	let folded = result;
	let reported = rejections;
	if (result.ok) {
		const error = errorPayload(rejections[0]);
		error.message = `Unhandled rejection (missing await?): ${error.message}`;
		folded = { type: "result", runId: active.runId, ok: false, error };
		reported = rejections.slice(1);
	}
	for (const reason of reported) {
		const payload = errorPayload(reason);
		hooks.onText(`[unhandled rejection] ${payload.name ?? "Error"}: ${payload.message}\n`);
	}
	return folded;
}
