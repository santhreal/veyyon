import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@veyyon/utils";

export const CASE_INSENSITIVE_ENV = process.platform === "win32";

export const SECRET_KEY_PATTERN =
	/API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|ACCESS[_-]?KEY|PRIVATE[_-]?KEY/i;

export const BASE_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "VEYYON_"];

export const BASE_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USER",
	"USERNAME",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TMPDIR",
	"TEMP",
	"TMP",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"SSH_CONNECTION",
	"SSH_CLIENT",
	"SSH_TTY",
	"DISPLAY",
	"XAUTHORITY",
	"TZ",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"LD_LIBRARY_PATH",
	"DYLD_LIBRARY_PATH",
];

export const SECRET_ENV_DENYLIST = [
	"VEYYON_API_KEY",
	"VEYYON_TOKEN",
	"VEYYON_PASSWORD",
	"VEYYON_SESSION",
	"VEYYON_TOOL_BRIDGE_TOKEN",
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"PERPLEXITY_API_KEY",
	"PERPLEXITY_COOKIES",
	"EXA_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"MISTRAL_API_KEY",
];

export interface EnvFilterOptions {
	allowList: string[];
	windowsAllowList: string[];
	denyList: string[];
	allowPrefixes: string[];
}

export function createEnvFilter(
	options: EnvFilterOptions,
): (env: Record<string, string | undefined>) => Record<string, string | undefined> {
	const normalizedAllowList = new Set(
		options.allowList.concat(options.windowsAllowList).map(key => (CASE_INSENSITIVE_ENV ? key.toUpperCase() : key)),
	);
	const normalizedDenyList = new Set(options.denyList.map(key => (CASE_INSENSITIVE_ENV ? key.toUpperCase() : key)));
	const normalizedAllowPrefixes = CASE_INSENSITIVE_ENV
		? options.allowPrefixes.map(prefix => prefix.toUpperCase())
		: options.allowPrefixes;

	return (env: Record<string, string | undefined>): Record<string, string | undefined> => {
		const filtered: Record<string, string | undefined> = {};
		for (const key in env) {
			const value = env[key];
			if (value === undefined) continue;
			const normalizedKey = CASE_INSENSITIVE_ENV ? key.toUpperCase() : key;
			if (normalizedDenyList.has(normalizedKey)) continue;
			if (normalizedAllowList.has(normalizedKey)) {
				filtered[normalizedKey === "PATH" ? "PATH" : key] = value;
				continue;
			}
			if (SECRET_KEY_PATTERN.test(normalizedKey)) continue;
			if (normalizedAllowPrefixes.some(prefix => normalizedKey.startsWith(prefix))) {
				filtered[key] = value;
			}
		}
		return filtered;
	};
}

export function resolveExplicitPath(interpreter: string, cwd: string): string {
	const expanded =
		interpreter === "~"
			? os.homedir()
			: interpreter.startsWith("~/")
				? path.join(os.homedir(), interpreter.slice(2))
				: interpreter;
	return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

export function enumerateRuntimes<T>(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	binaryName: string,
	createRuntime: (executablePath: string, env: Record<string, string | undefined>) => T,
	interpreter?: string,
): T[] {
	if (interpreter) {
		const executablePath = resolveExplicitPath(interpreter, cwd);
		return [createRuntime(executablePath, baseEnv)];
	}
	const systemPath = $which(binaryName);
	return systemPath ? [createRuntime(systemPath, baseEnv)] : [];
}

export function resolveRuntime<T>(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	binaryName: string,
	createRuntime: (executablePath: string, env: Record<string, string | undefined>) => T,
	interpreter?: string,
): T {
	const [runtime] = enumerateRuntimes(cwd, baseEnv, binaryName, createRuntime, interpreter);
	if (!runtime) {
		const displayName = binaryName.charAt(0).toUpperCase() + binaryName.slice(1);
		throw new Error(`${displayName} executable not found on PATH`);
	}
	return runtime;
}
