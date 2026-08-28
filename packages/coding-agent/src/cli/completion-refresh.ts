import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage, escapeRegExp, removeTempPath } from "@veyyon/utils";

export const AUTOLOADED_COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

export type CompletionShell = (typeof AUTOLOADED_COMPLETION_SHELLS)[number] | "powershell";

export interface CompletionEnv {
	readonly HOME?: string | undefined;
	readonly XDG_DATA_HOME?: string | undefined;
	readonly XDG_CONFIG_HOME?: string | undefined;
}

export function completionEnvFrom(env: Record<string, string | undefined>): CompletionEnv {
	return { HOME: env.HOME, XDG_DATA_HOME: env.XDG_DATA_HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME };
}

export function completionsDirFor(shell: (typeof AUTOLOADED_COMPLETION_SHELLS)[number], env: CompletionEnv): string {
	const home = env.HOME ?? "";
	const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
	const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
	switch (shell) {
		case "bash":
			return path.join(dataHome, "bash-completion", "completions");
		case "zsh":
			return path.join(dataHome, "zsh", "site-functions");
		case "fish":
			return path.join(configHome, "fish", "completions");
	}
}

export function completionFileFor(shell: (typeof AUTOLOADED_COMPLETION_SHELLS)[number], commandName: string): string {
	switch (shell) {
		case "bash":
			return commandName;
		case "zsh":
			return `_${commandName}`;
		case "fish":
			return `${commandName}.fish`;
	}
}

export interface CompletionTarget {
	shell: CompletionShell;
	commandName: string;
	filePath: string;
}

export function completionTargets(env: CompletionEnv, binName: string, aliasName: string): CompletionTarget[] {
	const targets: CompletionTarget[] = [];
	for (const shell of AUTOLOADED_COMPLETION_SHELLS) {
		const dir = completionsDirFor(shell, env);
		const names = shell === "zsh" ? [binName] : [binName, aliasName];
		for (const commandName of names) {
			targets.push({ shell, commandName, filePath: path.join(dir, completionFileFor(shell, commandName)) });
		}
	}
	return targets;
}

export function powershellCompletionPath(profilePath: string, binName: string): string {
	return path.join(path.dirname(profilePath), `${binName}-completions.ps1`);
}

export type CompletionGenerator = (shell: CompletionShell, noAlias: boolean) => Promise<string>;

export function scriptBindsAlias(script: string, aliasName: string): boolean {
	return new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(aliasName)}([^A-Za-z0-9_.-]|$)`, "m").test(script);
}

export interface CompletionRefreshResult {
	refreshed: string[];
	failed: { filePath: string; reason: string }[];
}

export async function refreshInstalledCompletions(options: {
	env: CompletionEnv;
	binName: string;
	aliasName: string;
	generate: CompletionGenerator;
	extraTargets?: CompletionTarget[];
}): Promise<CompletionRefreshResult> {
	const result: CompletionRefreshResult = { refreshed: [], failed: [] };

	const scripts = new Map<CompletionShell, string | { error: string }>();

	const targets = [
		...completionTargets(options.env, options.binName, options.aliasName),
		...(options.extraTargets ?? []),
	];
	const present = targets.filter(target => fs.existsSync(target.filePath));

	const aliasBound = new Map<CompletionShell, boolean>();
	for (const target of present) {
		if (aliasBound.get(target.shell)) continue;
		if (target.commandName === options.aliasName) {
			aliasBound.set(target.shell, true);
			continue;
		}
		let existing: string;
		try {
			existing = await fs.promises.readFile(target.filePath, "utf8");
		} catch {
			continue;
		}
		aliasBound.set(target.shell, scriptBindsAlias(existing, options.aliasName));
	}

	for (const target of present) {
		let script = scripts.get(target.shell);
		if (script === undefined) {
			try {
				script = await options.generate(target.shell, aliasBound.get(target.shell) === false);
				if (script.length === 0) {
					script = { error: `${target.shell} completion script generated empty` };
				}
			} catch (err) {
				script = { error: errorMessage(err) };
			}
			scripts.set(target.shell, script);
		}
		if (typeof script !== "string") {
			result.failed.push({ filePath: target.filePath, reason: script.error });
			continue;
		}
		const tempPath = `${target.filePath}.${process.pid}.new`;
		try {
			await fs.promises.writeFile(tempPath, script);
			await fs.promises.rename(tempPath, target.filePath);
			result.refreshed.push(target.filePath);
		} catch (err) {
			await removeTempPath(tempPath, "completion-write-failed");
			result.failed.push({ filePath: target.filePath, reason: errorMessage(err) });
		}
	}
	return result;
}
