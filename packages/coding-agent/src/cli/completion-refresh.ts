/** Keep installed shell completions in step with the binary that generates them. `install.sh` writes a completion script per shell at install time. A later */
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage, escapeRegExp, removeTempPath } from "@veyyon/utils";

/** The shells whose completion file lives in a directory the shell autoloads. PowerShell is deliberately not here: it has no such directory, so its script */
export const AUTOLOADED_COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

/** Every shell `veyyon completions` can emit a script for. */
export type CompletionShell = (typeof AUTOLOADED_COMPLETION_SHELLS)[number] | "powershell";

/** The subset of the environment that decides where completions live. */
export interface CompletionEnv {
	readonly HOME?: string | undefined;
	readonly XDG_DATA_HOME?: string | undefined;
	readonly XDG_CONFIG_HOME?: string | undefined;
}

/** Narrow a full environment to just the variables that decide completion paths. `process.env` is an index-signature type with no declared properties, so */
export function completionEnvFrom(env: Record<string, string | undefined>): CompletionEnv {
	return { HOME: env.HOME, XDG_DATA_HOME: env.XDG_DATA_HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME };
}

/** The directory a shell autoloads user completions from. Mirrors `completions_dir_for` in scripts/install.sh, including the XDG */
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

/** The filename a shell autoloads for a given command name. Mirrors `completion_file_for` in scripts/install.sh. bash and fish key the */
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

/** A completion file the installer could have written, and the shell it serves. */
export interface CompletionTarget {
	shell: CompletionShell;
	/** The command name this file completes (the binary name or its alias). */
	commandName: string;
	filePath: string;
}

/** Every path `install.sh` could have written a completion to, for both the binary name and its alias. */
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

/** The file `install.ps1` writes the PowerShell completion script to: named for the binary, beside the profile that dot-sources it. */
export function powershellCompletionPath(profilePath: string, binName: string): string {
	return path.join(path.dirname(profilePath), `${binName}-completions.ps1`);
}

/** Produces the completion script for a shell, or throws explaining why not. `noAlias` asks for a script that completes only the binary name. It is not a */
export type CompletionGenerator = (shell: CompletionShell, noAlias: boolean) => Promise<string>;

/** Whether the script on disk completes the launch alias. The installer decides this once, at install time, by checking whether the */
export function scriptBindsAlias(script: string, aliasName: string): boolean {
	return new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(aliasName)}([^A-Za-z0-9_.-]|$)`, "m").test(script);
}

export interface CompletionRefreshResult {
	/** Files that were rewritten with freshly generated content. */
	refreshed: string[];
	/** Files that existed but could not be rewritten, with the reason. */
	failed: { filePath: string; reason: string }[];
}

/** Rewrite every already-installed completion file from `generate`. Writes through a temporary file in the same directory and renames into place: */
export async function refreshInstalledCompletions(options: {
	env: CompletionEnv;
	binName: string;
	aliasName: string;
	generate: CompletionGenerator;
	/** Files outside the autoloaded directories, resolved by the caller. Today that is the Windows PowerShell script, whose location only PowerShell can */
	extraTargets?: CompletionTarget[];
}): Promise<CompletionRefreshResult> {
	const result: CompletionRefreshResult = { refreshed: [], failed: [] };

	// One generation per shell, reused across that shell's files: bash and fish
	// write the same script under both the binary name and the alias.
	const scripts = new Map<CompletionShell, string | { error: string }>();

	const targets = [
		...completionTargets(options.env, options.binName, options.aliasName),
		...(options.extraTargets ?? []),
	];
	const present = targets.filter(target => fs.existsSync(target.filePath));

	// The alias decision is per shell, read back from what the installer wrote.
	// A file named for the alias only exists because the installer created it, so
	// its presence alone settles the question for the shells that use one.
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
			// Unreadable here means unwritable below, where it is reported properly.
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
