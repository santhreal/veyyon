import { createKernelBackend, namespaceSessionId as sharedNamespace } from "../backend-helpers";
import { executeJulia, type JuliaExecutorOptions } from "./executor";
import { checkJuliaKernelAvailability } from "./kernel";

export const JULIA_SESSION_PREFIX = "julia:";

export function namespaceSessionId(sessionId: string): string {
	return sharedNamespace(sessionId, JULIA_SESSION_PREFIX);
}

export default createKernelBackend<JuliaExecutorOptions>({
	id: "julia",
	label: "Julia",
	highlightLang: "julia",
	settingPrefix: "julia",
	sessionPrefix: JULIA_SESSION_PREFIX,
	checkAvailability: (cwd, interpreter) => checkJuliaKernelAvailability(cwd, interpreter),
	execute: (code, options) => executeJulia(code, options),
});
