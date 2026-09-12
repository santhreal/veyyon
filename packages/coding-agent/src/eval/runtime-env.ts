/**
 * Generic interpreter environment-filtering and runtime-resolution helpers
 * shared by the per-language eval runtime modules (jl/runtime, rb/runtime).
 */
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@veyyon/utils";

export const CASE_INSENSITIVE_ENV = process.platform === "win32";

// Secret-shaped names that must never leak into eval cells even when they fall
// under a broad allow-prefix.
export const SECRET_KEY_PATTERN =
	/API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|ACCESS[_-]?KEY|PRIVATE[_-]?KEY/i;

/**
 * Cross-language base allow-PREFIXES shared by every eval sandbox (py/rb/jl).
 *
 * A prefix admits any variable whose name starts with it, so this list is the
 * widest part of the sandbox's env surface and the part most worth having one
 * owner for. Locale (`LC_`) and XDG base directories are needed by every
 * interpreter; `VEYYON_` carries our own runtime plumbing (the secret-shaped
 * members of that namespace are refused by `SECRET_ENV_DENYLIST`, which is why
 * the broad prefix is safe here).
 *
 * Each runtime layers its own language prefixes on top: Ruby adds the gem and
 * version-manager namespaces, Julia adds its package and BLAS ones. Those
 * additions are deliberate and differ per language; the base does not, and it
 * was previously retyped in all three files under the same name with three
 * different values, which is exactly the shape that drifts unnoticed.
 */
export const BASE_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "VEYYON_"];

/**
 * Cross-language base allowlist shared by every eval sandbox (py/rb/jl).
 * Covers the common shell/locale/proxy vars every interpreter needs to start
 * up and find libraries. Language-runtime-specific vars (Python's venv/conda
 * layout, etc.) are layered on top by the owning runtime module — only the
 * genuinely shared baseline lives here.
 */
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

/**
 * Cross-language Windows allowlist shared by every eval sandbox (py/rb/jl).
 * Covers standard Windows user/system profile, architecture and session environment variables.
 */
export const BASE_WINDOWS_ENV_ALLOWLIST = [
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

/**
 * Union of internal PI tokens and provider API keys that must never reach an
 * eval sandbox, even under a broad allow-prefix (e.g. the `PI_` prefix admits
 * `VEYYON_SESSION`/`VEYYON_TOKEN` unless explicitly denied here). Single authoritative
 * source for py/rb/jl — see BACKLOG SPEC-ONE-PLACE-AUDIT F3.
 */
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
	allowList?: string[];
	windowsAllowList?: string[];
	denyList?: string[];
	allowPrefixes?: string[];
}

/**
 * Creates an environment filter function based on the provided allowlists, denylists, and prefixes.
 */
export function createEnvFilter(
	options?: EnvFilterOptions,
): (env: Record<string, string | undefined>) => Record<string, string | undefined> {
	const allowList = options?.allowList ?? BASE_ENV_ALLOWLIST;
	const windowsAllowList = options?.windowsAllowList ?? BASE_WINDOWS_ENV_ALLOWLIST;
	const denyList = options?.denyList ?? SECRET_ENV_DENYLIST;
	const allowPrefixes = options?.allowPrefixes ?? BASE_ENV_ALLOW_PREFIXES;

	const normalizedAllowList = new Set(
		(process.platform === "win32" ? allowList.concat(windowsAllowList) : allowList).map(key =>
			CASE_INSENSITIVE_ENV ? key.toUpperCase() : key,
		),
	);
	const normalizedDenyList = new Set(denyList.map(key => (CASE_INSENSITIVE_ENV ? key.toUpperCase() : key)));
	const normalizedAllowPrefixes = CASE_INSENSITIVE_ENV
		? allowPrefixes.map(prefix => prefix.toUpperCase())
		: allowPrefixes;

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

/**
 * Resolve an explicitly configured interpreter path, expanding `~` to the home directory.
 */
export function resolveExplicitPath(interpreter: string, cwd: string): string {
	const expanded =
		interpreter === "~"
			? os.homedir()
			: interpreter.startsWith("~/")
				? path.join(os.homedir(), interpreter.slice(2))
				: interpreter;
	return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

/**
 * Resolves an explicitly configured interpreter path into a runtime object without discovery probing.
 */
export function resolveExplicitRuntime<T>(
	interpreter: string,
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	createRuntime: (executablePath: string, env: Record<string, string | undefined>) => T,
): T {
	const executablePath = resolveExplicitPath(interpreter, cwd);
	return createRuntime(executablePath, { ...baseEnv });
}

/**
 * Enumerates candidate runtimes in priority order.
 */
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

/**
 * Resolves the highest-priority runtime. Throws when none exists.
 */
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

/**
 * Creates standard explicit, candidate-enumeration, and priority-resolution runtime helpers.
 */
export function createSimpleRuntimeResolvers<TKey extends string>(
	binaryName: string,
	pathKey: TKey,
): {
	resolveExplicit: (
		interpreter: string,
		cwd: string,
		baseEnv: Record<string, string | undefined>,
	) => { [K in TKey]: string } & { env: Record<string, string | undefined> };
	enumerate: (
		cwd: string,
		baseEnv: Record<string, string | undefined>,
		interpreter?: string,
	) => Array<{ [K in TKey]: string } & { env: Record<string, string | undefined> }>;
	resolve: (
		cwd: string,
		baseEnv: Record<string, string | undefined>,
		interpreter?: string,
	) => { [K in TKey]: string } & { env: Record<string, string | undefined> };
} {
	const createRuntime = (executablePath: string, env: Record<string, string | undefined>) =>
		({ [pathKey]: executablePath, env }) as { [K in TKey]: string } & { env: Record<string, string | undefined> };
	return {
		resolveExplicit: (interpreter, cwd, baseEnv) => resolveExplicitRuntime(interpreter, cwd, baseEnv, createRuntime),
		enumerate: (cwd, baseEnv, interpreter) => enumerateRuntimes(cwd, baseEnv, binaryName, createRuntime, interpreter),
		resolve: (cwd, baseEnv, interpreter) => resolveRuntime(cwd, baseEnv, binaryName, createRuntime, interpreter),
	};
}
