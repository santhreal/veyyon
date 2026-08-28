import { createKernelBackend } from "../backend-helpers";
import { executePython, type PythonExecutorOptions } from "./executor";
import { checkPythonKernelAvailability } from "./kernel";
import { namespaceSessionId, PYTHON_SESSION_PREFIX } from "./session-namespace";

/**
 * Re-exported from its leaf, so a caller that only needs to NAME a Python eval session does not
 * load this descriptor and the 510 modules behind it. See `eval/py/session-namespace.ts`.
 */
export { namespaceSessionId, PYTHON_SESSION_PREFIX } from "./session-namespace";

export default createKernelBackend<PythonExecutorOptions>({
	id: "python",
	label: "Python",
	highlightLang: "python",
	settingPrefix: "python",
	sessionPrefix: PYTHON_SESSION_PREFIX,
	checkAvailability: checkPythonKernelAvailability,
	execute: executePython,
});
