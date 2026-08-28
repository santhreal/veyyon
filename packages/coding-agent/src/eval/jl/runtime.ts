import {
	BASE_ENV_ALLOW_PREFIXES,
	BASE_ENV_ALLOWLIST,
	createEnvFilter,
	enumerateRuntimes,
	resolveExplicitPath,
	resolveRuntime,
	SECRET_ENV_DENYLIST,
} from "../runtime-env";

const WINDOWS_ENV_ALLOWLIST = [
	"ALLUSERSPROFILE",
	"APPDATA",
	"COMMONPROGRAMFILES",
	"COMMONPROGRAMFILES(X86)",
	"COMMONPROGRAMW6432",
	"COMPUTERNAME",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"PROCESSOR_LEVEL",
	"PROCESSOR_REVISION",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"PUBLIC",
	"SESSIONNAME",
	"SYSTEMDRIVE",
	"USERDOMAIN",
	"USERDOMAIN_ROAMING_PC",
	"USERPROFILE",
];

const JULIA_ENV_ALLOW_PREFIXES = [...BASE_ENV_ALLOW_PREFIXES, "JULIA_", "OPENBLAS_", "MKL_"];

export interface JuliaRuntime {
	juliaPath: string;
	env: Record<string, string | undefined>;
}

export const filterEnv = createEnvFilter({
	allowList: BASE_ENV_ALLOWLIST,
	windowsAllowList: WINDOWS_ENV_ALLOWLIST,
	denyList: SECRET_ENV_DENYLIST,
	allowPrefixes: JULIA_ENV_ALLOW_PREFIXES,
});

export function resolveExplicitJuliaRuntime(
	interpreter: string,
	cwd: string,
	baseEnv: Record<string, string | undefined>,
): JuliaRuntime {
	const juliaPath = resolveExplicitPath(interpreter, cwd);
	return { juliaPath, env: { ...baseEnv } };
}

export function enumerateJuliaRuntimes(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): JuliaRuntime[] {
	return enumerateRuntimes(cwd, baseEnv, "julia", (juliaPath, env) => ({ juliaPath, env }), interpreter);
}

export function resolveJuliaRuntime(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): JuliaRuntime {
	return resolveRuntime(cwd, baseEnv, "julia", (juliaPath, env) => ({ juliaPath, env }), interpreter);
}
