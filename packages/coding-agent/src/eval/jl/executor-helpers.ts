import type { KernelExecutionResult, KernelExecutorBaseOptions } from "../executor-base";
import type { EvalDisplayOutput, EvalStatusEvent } from "../types";

export type { EvalDisplayOutput, EvalStatusEvent };

export interface JuliaExecutorOptions extends KernelExecutorBaseOptions {}

export type JuliaResult = KernelExecutionResult;
