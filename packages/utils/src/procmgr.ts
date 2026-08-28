import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessStatus } from "@veyyon/natives";
import type { Subprocess } from "bun";
import { $env, filterChildShellEnv } from "./env";
import { processHandle } from "./native-process";
import { isProcessAlive } from "./process-liveness";
import { $which } from "./which";

export interface ShellConfig {
	shell: string;
	args: string[];
	env: Record<string, string>;
	prefix: string | undefined;
}
let cachedShellConfig: ShellConfig | null = null;

export function isExecutable(path: string): boolean {
	try {
		fs.accessSync(path, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function buildSpawnEnv(shell: string): Record<string, string> {
	const noCI = $env.VEYYON_BASH_NO_CI || $env.CLAUDE_BASH_NO_CI;
	return {
		...filterChildShellEnv(Bun.env),
		SHELL: shell,
		GIT_EDITOR: "true",
		GPG_TTY: "not a tty",
		OMPCODE: "1",
		CLAUDECODE: "1",
		...(noCI ? {} : { CI: "true" }),
	} as Record<string, string>;
}

function getShellArgs(): string[] {
	const noLogin = $env.VEYYON_BASH_NO_LOGIN || $env.CLAUDE_BASH_NO_LOGIN;
	return noLogin ? ["-c"] : ["-l", "-c"];
}

function getShellPrefix(): string | undefined {
	return $env.VEYYON_SHELL_PREFIX || $env.CLAUDE_CODE_SHELL_PREFIX;
}

function buildConfig(shell: string): ShellConfig {
	return {
		shell,
		args: getShellArgs(),
		env: buildSpawnEnv(shell),
		prefix: getShellPrefix(),
	};
}

export function resolveBasicShell(): string | undefined {
	for (const name of ["bash", "bash.exe", "sh", "sh.exe"]) {
		const resolved = $which(name);
		if (resolved) return resolved;
	}

	if (process.platform !== "win32") {
		const searchPaths = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
		const candidates = ["bash", "sh"];

		for (const name of candidates) {
			for (const dir of searchPaths) {
				const fullPath = path.join(dir, name);
				if (fs.existsSync(fullPath)) return fullPath;
			}
		}
	}

	return undefined;
}

export function getShellConfig(customShellPath?: string): ShellConfig {
	if (cachedShellConfig) {
		return cachedShellConfig;
	}

	if (customShellPath) {
		if (fs.existsSync(customShellPath)) {
			cachedShellConfig = buildConfig(customShellPath);
			return cachedShellConfig;
		}
		throw new Error(
			`Custom shell path not found: ${customShellPath}\nPlease update shellPath in ~/.veyyon/agent/settings.json`,
		);
	}

	if (process.platform === "win32") {
		const paths: string[] = [];
		const programFiles = Bun.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = Bun.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (fs.existsSync(path)) {
				cachedShellConfig = buildConfig(path);
				return cachedShellConfig;
			}
		}

		const bashOnPath = $which("bash.exe");
		if (bashOnPath) {
			cachedShellConfig = buildConfig(bashOnPath);
			return cachedShellConfig;
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				`  3. Set shellPath in ~/.veyyon/agent/settings.json\n\n` +
				`Searched Git Bash in:\n${paths.map(p => `  ${p}`).join("\n")}`,
		);
	}

	const userShell = Bun.env.SHELL;
	const isValidShell = userShell && (userShell.includes("bash") || userShell.includes("zsh"));
	if (isValidShell && isExecutable(userShell)) {
		cachedShellConfig = buildConfig(userShell);
		return cachedShellConfig;
	}

	const basicShell = resolveBasicShell();
	if (basicShell) {
		cachedShellConfig = buildConfig(basicShell);
		return cachedShellConfig;
	}
	cachedShellConfig = buildConfig("sh");
	return cachedShellConfig;
}

export function isPidRunning(pid: number | Subprocess): boolean {
	if (typeof pid !== "number") {
		if (pid.killed) return false;
		if (pid.exitCode !== null) return false;
		return true;
	}

	const handle = processHandle(pid);
	if (!handle) return isProcessAlive(pid);
	return handle.status() === ProcessStatus.Running;
}

const EXIT_POLL_INTERVAL_MS = 100;

async function pollUntilPidExits(pid: number, abortSignal?: AbortSignal): Promise<boolean> {
	while (isProcessAlive(pid)) {
		if (abortSignal?.aborted) return false;
		await delay(EXIT_POLL_INTERVAL_MS);
	}
	return true;
}

export async function onProcessExit(proc: Subprocess | number, abortSignal?: AbortSignal): Promise<boolean> {
	if (typeof proc !== "number") {
		const exited = proc.exited.then(
			() => true,
			() => true,
		);
		if (!abortSignal) return await exited;
		if (abortSignal.aborted) return false;
		const aborted = Promise.withResolvers<boolean>();
		const onAbort = (): void => aborted.resolve(false);
		abortSignal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([exited, aborted.promise]);
		} finally {
			abortSignal.removeEventListener("abort", onAbort);
		}
	}

	const handle = processHandle(proc);
	if (handle) {
		try {
			return (await handle.waitForExit({ signal: abortSignal })) ?? true;
		} catch (error) {
			if (abortSignal?.aborted === true) return false;
			throw error;
		}
	}
	return await pollUntilPidExits(proc, abortSignal);
}
