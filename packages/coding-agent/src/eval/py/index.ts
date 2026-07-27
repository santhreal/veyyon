import type { ToolSession } from "../../tools";
import {
	type ExecutorBackend,
	type ExecutorBackendExecOptions,
	type ExecutorBackendResult,
	resolveEvalUrlRoots,
} from "../backend";
import {
	readSetting,
	readInterpreterSetting as sharedReadInterpreterSetting,
	toExecutorBackendResult,
} from "../backend-helpers";
import { executePython, type PythonExecutorOptions } from "./executor";
import { checkPythonKernelAvailability } from "./kernel";
import { namespaceSessionId } from "./session-namespace";

/**
 * Re-exported from its leaf, so a caller that only needs to NAME a Python eval session does not
 * load this descriptor and the 510 modules behind it. See `eval/py/session-namespace.ts`.
 */
export { namespaceSessionId, PYTHON_SESSION_PREFIX } from "./session-namespace";

function readInterpreterSetting(session: ToolSession): string | undefined {
	return sharedReadInterpreterSetting(session, "python.interpreter");
}
export default {
	id: "python",
	label: "Python",
	highlightLang: "python",

	async isAvailable(session: ToolSession): Promise<boolean> {
		const availability = await checkPythonKernelAvailability(session.cwd, readInterpreterSetting(session));
		return availability.ok;
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const kernelMode = readSetting<PythonExecutorOptions["kernelMode"]>(opts.session, "python.kernelMode");
		const executorOptions: PythonExecutorOptions = {
			cwd: opts.cwd,
			idleTimeoutMs: opts.idleTimeoutMs,
			signal: opts.signal,
			sessionId: namespaceSessionId(opts.sessionId),
			kernelMode,
			interpreter: readInterpreterSetting(opts.session),
			sessionFile: opts.sessionFile,
			artifactsDir: opts.session.getArtifactsDir?.() ?? undefined,
			localRoots: resolveEvalUrlRoots(opts.session),
			kernelOwnerId: opts.kernelOwnerId,
			reset: opts.reset,
			onChunk: opts.onChunk,
			onStatus: opts.onStatus,
			toolSession: opts.session,
		};
		const result = await executePython(code, executorOptions);
		return toExecutorBackendResult(result);
	},
} satisfies ExecutorBackend;
