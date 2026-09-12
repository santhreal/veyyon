/**
 * Julia runtime resolution utilities.
 */
import {
	BASE_ENV_ALLOW_PREFIXES,
	BASE_WINDOWS_ENV_ALLOWLIST,
	createEnvFilter,
	createSimpleRuntimeResolvers,
} from "../runtime-env";

// Julia version managers and package layout live behind these prefixes; passing them
// through lets Julia discover packages and configure its runtime consistently.
const JULIA_ENV_ALLOW_PREFIXES = [...BASE_ENV_ALLOW_PREFIXES, "JULIA_", "OPENBLAS_", "MKL_"];

export interface JuliaRuntime {
	/** Path to the julia executable. */
	juliaPath: string;
	/** Filtered environment variables. */
	env: Record<string, string | undefined>;
}

export const filterEnv = createEnvFilter({
	windowsAllowList: [
		...BASE_WINDOWS_ENV_ALLOWLIST,
		"ALLUSERSPROFILE",
		"COMMONPROGRAMFILES",
		"COMMONPROGRAMFILES(X86)",
		"COMMONPROGRAMW6432",
		"PROCESSOR_LEVEL",
		"PROCESSOR_REVISION",
		"PUBLIC",
		"USERDOMAIN_ROAMING_PC",
	],
	allowPrefixes: JULIA_ENV_ALLOW_PREFIXES,
});

export const {
	resolveExplicit: resolveExplicitJuliaRuntime,
	enumerate: enumerateJuliaRuntimes,
	resolve: resolveJuliaRuntime,
} = createSimpleRuntimeResolvers("julia", "juliaPath");
