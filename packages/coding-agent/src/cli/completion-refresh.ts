/**
 * Keep installed shell completions in step with the binary that generates them.
 *
 * `install.sh` writes a completion script per shell at install time. A later
 * `veyyon update` swapped the binary and left those files untouched, so every
 * subcommand and flag added by the update was missing from tab completion until
 * the user happened to re-run the installer. The completion script is generated
 * from the CLI's own metadata, so the fix is to regenerate it from the binary
 * that was just installed.
 *
 * Two rules keep this from being destructive:
 *
 * - Only files that ALREADY exist are rewritten. A user who never installed
 *   completions, or who deliberately removed one shell's file, does not get it
 *   created behind their back by an update. Creating them is the installer's
 *   job.
 * - The paths come from one place here and mirror `completions_dir_for` /
 *   `completion_file_for` in `scripts/install.sh`. If the two disagree, the
 *   update rewrites files the installer never wrote and misses the ones it did.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** The shells `veyyon completions` can emit a script for. */
export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** The subset of the environment that decides where completions live. */
export interface CompletionEnv {
	readonly HOME?: string | undefined;
	readonly XDG_DATA_HOME?: string | undefined;
	readonly XDG_CONFIG_HOME?: string | undefined;
}

/**
 * Narrow a full environment to just the variables that decide completion paths.
 *
 * `process.env` is an index-signature type with no declared properties, so
 * assigning it to a type whose members are all optional is rejected outright.
 * Naming the three variables here keeps one conversion point instead of three
 * inline reads at every call site.
 */
export function completionEnvFrom(env: Record<string, string | undefined>): CompletionEnv {
	return { HOME: env.HOME, XDG_DATA_HOME: env.XDG_DATA_HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME };
}

/**
 * The directory a shell autoloads user completions from.
 *
 * Mirrors `completions_dir_for` in scripts/install.sh, including the XDG
 * defaults, so both sides resolve the same directory for the same environment.
 */
export function completionsDirFor(shell: CompletionShell, env: CompletionEnv): string {
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

/**
 * The filename a shell autoloads for a given command name.
 *
 * Mirrors `completion_file_for` in scripts/install.sh. bash and fish key the
 * file on the command being completed, so an alias needs its own file; zsh
 * binds every name listed on the generated script's `#compdef` line, so it gets
 * exactly one file regardless of how many names it serves.
 */
export function completionFileFor(shell: CompletionShell, commandName: string): string {
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

/**
 * Every path `install.sh` could have written a completion to, for both the
 * binary name and its alias.
 *
 * zsh is listed once, under the binary name only: a second zsh file for the
 * alias would be dead weight the installer deliberately does not write.
 */
export function completionTargets(env: CompletionEnv, binName: string, aliasName: string): CompletionTarget[] {
	const targets: CompletionTarget[] = [];
	for (const shell of COMPLETION_SHELLS) {
		const dir = completionsDirFor(shell, env);
		const names = shell === "zsh" ? [binName] : [binName, aliasName];
		for (const commandName of names) {
			targets.push({ shell, commandName, filePath: path.join(dir, completionFileFor(shell, commandName)) });
		}
	}
	return targets;
}

/** Produces the completion script for a shell, or throws explaining why not. */
export type CompletionGenerator = (shell: CompletionShell) => Promise<string>;

export interface CompletionRefreshResult {
	/** Files that were rewritten with freshly generated content. */
	refreshed: string[];
	/** Files that existed but could not be rewritten, with the reason. */
	failed: { filePath: string; reason: string }[];
}

/**
 * Rewrite every already-installed completion file from `generate`.
 *
 * Writes through a temporary file in the same directory and renames into place:
 * a completion file is sourced at shell startup, so a half-written one breaks
 * every new shell the user opens. This is the same treatment install.sh gives
 * the file it writes.
 *
 * Never throws. A completion that cannot be regenerated is reported, not fatal:
 * the binary itself updated successfully, and failing the update over a stale
 * completion file would be worse than the staleness.
 */
export async function refreshInstalledCompletions(options: {
	env: CompletionEnv;
	binName: string;
	aliasName: string;
	generate: CompletionGenerator;
}): Promise<CompletionRefreshResult> {
	const result: CompletionRefreshResult = { refreshed: [], failed: [] };

	// One generation per shell, reused across that shell's files: bash and fish
	// write the same script under both the binary name and the alias.
	const scripts = new Map<CompletionShell, string | { error: string }>();

	for (const target of completionTargets(options.env, options.binName, options.aliasName)) {
		if (!fs.existsSync(target.filePath)) {
			continue;
		}
		let script = scripts.get(target.shell);
		if (script === undefined) {
			try {
				script = await options.generate(target.shell);
				if (script.length === 0) {
					script = { error: `${target.shell} completion script generated empty` };
				}
			} catch (err) {
				script = { error: err instanceof Error ? err.message : String(err) };
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
			await fs.promises.rm(tempPath, { force: true }).catch(() => {});
			result.failed.push({ filePath: target.filePath, reason: err instanceof Error ? err.message : String(err) });
		}
	}
	return result;
}
