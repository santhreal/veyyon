/**
 * Python runtime resolution utilities.
 *
 * Centralizes environment filtering, venv detection, and Python executable resolution
 * for both the shared gateway and local kernel spawning.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env, $which, getPythonEnvDir } from "@veyyon/pi-utils";
import { BASE_ENV_ALLOWLIST, CASE_INSENSITIVE_ENV, createEnvFilter, SECRET_ENV_DENYLIST } from "../runtime-env";

// Python-specific runtime-state vars not shared by the other language
// sandboxes (venv/conda layout, import path).
const PYTHON_ENV_ALLOWLIST = ["CONDA_PREFIX", "CONDA_DEFAULT_ENV", "VIRTUAL_ENV", "PYTHONPATH"];

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
	"USERDOMAIN_ROAMINGPROFILE",
	"USERPROFILE",
	"USERNAME",
	"WINDIR",
];

const DEFAULT_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "PI_"];

function resolvePathKey(env: Record<string, string | undefined>): string {
	if (!CASE_INSENSITIVE_ENV) return "PATH";
	const match = Object.keys(env).find(candidate => candidate.toLowerCase() === "path");
	return match ?? "PATH";
}

function resolveManagedPythonEnv(): string {
	return getPythonEnvDir();
}

function resolveManagedPythonCandidate(): { venvPath: string; pythonPath: string } {
	const venvPath = resolveManagedPythonEnv();
	const binDir = process.platform === "win32" ? path.join(venvPath, "Scripts") : path.join(venvPath, "bin");
	const pythonPath = path.join(binDir, process.platform === "win32" ? "python.exe" : "python");
	return { venvPath, pythonPath };
}

export interface PythonRuntime {
	/** Path to python executable */
	pythonPath: string;
	/** Filtered environment variables */
	env: Record<string, string | undefined>;
	/** Path to virtual environment, if detected */
	venvPath?: string;
}

export const filterEnv = createEnvFilter({
	allowList: [...BASE_ENV_ALLOWLIST, ...PYTHON_ENV_ALLOWLIST],
	windowsAllowList: WINDOWS_ENV_ALLOWLIST,
	denyList: SECRET_ENV_DENYLIST,
	allowPrefixes: DEFAULT_ENV_ALLOW_PREFIXES,
});

/**
 * Detect virtual environment path from VIRTUAL_ENV or common locations.
 */
export function resolveVenvPath(cwd: string): string | undefined {
	if ($env.VIRTUAL_ENV) return $env.VIRTUAL_ENV;
	if ($env.CONDA_PREFIX) return $env.CONDA_PREFIX;
	const candidates = [path.join(cwd, ".venv"), path.join(cwd, "venv")];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Apply a venv-style PATH/VIRTUAL_ENV layout onto a fresh copy of `baseEnv` for
 * the interpreter living in `binDir`.
 */
function applyVenvEnv(
	baseEnv: Record<string, string | undefined>,
	venvPath: string,
	binDir: string,
): Record<string, string | undefined> {
	const env = { ...baseEnv };
	env.VIRTUAL_ENV = venvPath;
	const pathKey = resolvePathKey(env);
	const currentPath = env[pathKey];
	env[pathKey] = currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir;
	return env;
}

function venvBinDir(venvPath: string): string {
	return process.platform === "win32" ? path.join(venvPath, "Scripts") : path.join(venvPath, "bin");
}

function detectExplicitVenv(pythonPath: string): { venvPath: string; binDir: string } | undefined {
	const binDir = path.dirname(pythonPath);
	const venvPath = path.dirname(binDir);
	if (fs.existsSync(path.join(venvPath, "pyvenv.cfg"))) {
		return { venvPath, binDir };
	}
	return undefined;
}

/**
 * Resolve an explicitly configured interpreter (`python.interpreter`) into a
 * runtime, bypassing discovery. Does not probe or validate the executable —
 * callers must check it actually runs. `~` expands to the home directory and
 * relative paths resolve against `cwd`. When the interpreter sits inside a
 * virtualenv (a `pyvenv.cfg` above its bin dir), the venv activation env is
 * applied so subprocesses and `pip` resolve consistently.
 */
export function resolveExplicitPythonRuntime(
	interpreter: string,
	cwd: string,
	baseEnv: Record<string, string | undefined>,
): PythonRuntime {
	const expanded =
		interpreter === "~"
			? os.homedir()
			: interpreter.startsWith("~/")
				? path.join(os.homedir(), interpreter.slice(2))
				: interpreter;
	const pythonPath = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
	const venv = detectExplicitVenv(pythonPath);
	if (venv) {
		return { pythonPath, env: applyVenvEnv(baseEnv, venv.venvPath, venv.binDir), venvPath: venv.venvPath };
	}
	return { pythonPath, env: { ...baseEnv } };
}

/**
 * Enumerate candidate Python runtimes in priority order: an active/project venv,
 * the managed `~/.veyyon/python-env`, then the system interpreter on PATH. Every
 * candidate that physically exists is returned so callers can probe each in turn
 * rather than committing to the first — a managed env left behind by a removed
 * `uv` install no longer shadows a working system Python.
 */
export function enumeratePythonRuntimes(cwd: string, baseEnv: Record<string, string | undefined>): PythonRuntime[] {
	const runtimes: PythonRuntime[] = [];
	const seen = new Set<string>();
	const push = (runtime: PythonRuntime): void => {
		if (seen.has(runtime.pythonPath)) return;
		seen.add(runtime.pythonPath);
		runtimes.push(runtime);
	};

	const venvPath = baseEnv.VIRTUAL_ENV ?? resolveVenvPath(cwd);
	if (venvPath) {
		const binDir = venvBinDir(venvPath);
		const pythonCandidate = path.join(binDir, process.platform === "win32" ? "python.exe" : "python");
		if (fs.existsSync(pythonCandidate)) {
			push({ pythonPath: pythonCandidate, env: applyVenvEnv(baseEnv, venvPath, binDir), venvPath });
		}
	}

	const managed = resolveManagedPythonCandidate();
	if (fs.existsSync(managed.pythonPath)) {
		const managedBin = path.dirname(managed.pythonPath);
		push({
			pythonPath: managed.pythonPath,
			env: applyVenvEnv(baseEnv, managed.venvPath, managedBin),
			venvPath: managed.venvPath,
		});
	}

	const systemPath = $which("python") ?? $which("python3");
	if (systemPath) {
		push({ pythonPath: systemPath, env: { ...baseEnv } });
	}

	return runtimes;
}

/**
 * Resolve the highest-priority Python runtime. Prefer {@link enumeratePythonRuntimes}
 * when you can probe candidates; this returns only the first one and throws when
 * no interpreter exists.
 */
export function resolvePythonRuntime(cwd: string, baseEnv: Record<string, string | undefined>): PythonRuntime {
	const [runtime] = enumeratePythonRuntimes(cwd, baseEnv);
	if (!runtime) {
		throw new Error("Python executable not found on PATH");
	}
	return runtime;
}
