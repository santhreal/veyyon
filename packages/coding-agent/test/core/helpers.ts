import type { KernelExecutor } from "@veyyon/coding-agent/eval/kernel-base";
import type { KernelExecuteOptions, KernelExecuteResult } from "@veyyon/coding-agent/eval/py/kernel";

/**
 * The one fake kernel for `executePythonWithKernel` tests: it hands back a fixed
 * result and lets the test observe (or drive) the options it was called with.
 *
 * `onExecute` is optional because a suite that only cares about how a result is
 * MAPPED has no callback to give, and three suites each grew their own near-identical
 * copy of this class rather than widen the shared one by one default value.
 */
export class FakeKernel implements KernelExecutor {
	private result: KernelExecuteResult;
	private onExecute: (options?: KernelExecuteOptions) => Promise<void> | void;

	constructor(
		result: KernelExecuteResult,
		onExecute: (options?: KernelExecuteOptions) => Promise<void> | void = () => {},
	) {
		this.result = result;
		this.onExecute = onExecute;
	}

	async execute(_code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		await this.onExecute(options);
		return this.result;
	}
}
