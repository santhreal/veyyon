import { createKernelBackend } from "../backend-helpers";
import { executePython, type PythonExecutorOptions } from "./executor";
import { checkPythonKernelAvailability } from "./kernel";
import { PYTHON_SESSION_PREFIX } from "./session-namespace";

/**
 * Re-exported from its leaf, so a caller that only needs to NAME a Python eval session does not
 * load this descriptor and the 510 modules behind it. See `eval/py/session-namespace.ts`.
 */
export { namespaceSessionId, PYTHON_SESSION_PREFIX } from "./session-namespace";

// The descriptor is built once, when this module is evaluated. Naming the kernel
// functions inside a call rather than passing the references keeps the kernel and
// executor modules the single definition of each: the descriptor holds a call, not a
// snapshot of whichever binding existed at import time.
export default createKernelBackend<PythonExecutorOptions>({
	id: "python",
	label: "Python",
	highlightLang: "python",
	settingPrefix: "python",
	sessionPrefix: PYTHON_SESSION_PREFIX,
	checkAvailability: (cwd, interpreter) => checkPythonKernelAvailability(cwd, interpreter),
	execute: (code, options) => executePython(code, options),
});
