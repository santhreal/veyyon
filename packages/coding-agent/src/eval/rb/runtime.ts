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
	"APPDATA",
	"COMPUTERNAME",
	"COMSPEC",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PATH",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"SESSIONNAME",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"USERDOMAIN",
	"USERPROFILE",
	"USERNAME",
	"WINDIR",
];

const RUBY_ENV_ALLOW_PREFIXES = [...BASE_ENV_ALLOW_PREFIXES, "GEM_", "BUNDLE", "RBENV_", "RUBY", "CHRUBY_", "ASDF_"];

export interface RubyRuntime {
	rubyPath: string;
	env: Record<string, string | undefined>;
}

export const filterEnv = createEnvFilter({
	allowList: BASE_ENV_ALLOWLIST,
	windowsAllowList: WINDOWS_ENV_ALLOWLIST,
	denyList: SECRET_ENV_DENYLIST,
	allowPrefixes: RUBY_ENV_ALLOW_PREFIXES,
});

export function resolveExplicitRubyRuntime(
	interpreter: string,
	cwd: string,
	baseEnv: Record<string, string | undefined>,
): RubyRuntime {
	const rubyPath = resolveExplicitPath(interpreter, cwd);
	return { rubyPath, env: { ...baseEnv } };
}

export function enumerateRubyRuntimes(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): RubyRuntime[] {
	return enumerateRuntimes(cwd, baseEnv, "ruby", (rubyPath, env) => ({ rubyPath, env }), interpreter);
}

export function resolveRubyRuntime(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): RubyRuntime {
	return resolveRuntime(cwd, baseEnv, "ruby", (rubyPath, env) => ({ rubyPath, env }), interpreter);
}
