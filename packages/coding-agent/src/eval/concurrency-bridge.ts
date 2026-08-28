/** Host-side handler for the eval `parallel()` / `pipeline()` worker pool. The pool ceiling is not a kernel-side knob: it tracks the `subagent.maxConcurrency` */
import type { ToolSession } from "../tools";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic bridge name reserved for the parallel-pool ceiling across both runtimes. */
export const EVAL_CONCURRENCY_BRIDGE_NAME = "__concurrency__";

export interface EvalConcurrencyBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalConcurrencyResult {
	/** Worker-pool ceiling; `0` means unbounded (run every item at once). */
	limit: number;
}

/** Resolve the worker-pool ceiling for an eval cell's `parallel()`/`pipeline()` helpers from the live `subagent.maxConcurrency` setting. Negative/non-finite */
export function runEvalConcurrency(_args: unknown, options: EvalConcurrencyBridgeOptions): EvalConcurrencyResult {
	const raw = options.session.settings.get("subagent.maxConcurrency");
	const limit = Number.isFinite(raw) ? Math.trunc(raw) : 0;
	return { limit: limit > 0 ? limit : 0 };
}
