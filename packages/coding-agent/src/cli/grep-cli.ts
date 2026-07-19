/**
 * Grep CLI command handlers.
 *
 * Handles `veyyon grep` subcommand for testing grep tool on Windows.
 */
import * as path from "node:path";
import { GrepOutputMode, grep } from "@veyyon/natives";
import { errorMessage } from "@veyyon/utils";

import chalk from "chalk";

export interface GrepCommandArgs {
	pattern: string;
	path: string;
	glob?: string;
	limit: number;
	context: number;
	mode: GrepOutputMode;
	gitignore: boolean;
}

export async function runGrepCommand(cmd: GrepCommandArgs): Promise<void> {
	if (!cmd.pattern) {
		console.error(chalk.red("Error: Pattern is required"));
		console.error(chalk.dim('Usage: veyyon grep <pattern> [path] — e.g. `veyyon grep "TODO" src/`'));
		process.exit(1);
	}

	const searchPath = path.resolve(cmd.path);
	console.log(chalk.dim(`Searching in: ${searchPath}`));
	console.log(chalk.dim(`Pattern: ${cmd.pattern}`));
	console.log(
		chalk.dim(`Mode: ${cmd.mode}, Limit: ${cmd.limit}, Context: ${cmd.context}, Gitignore: ${cmd.gitignore}`),
	);

	console.log("");

	try {
		const result = await grep({
			pattern: cmd.pattern,
			path: searchPath,
			glob: cmd.glob,
			mode: cmd.mode,
			maxCount: cmd.limit,
			context: cmd.mode === GrepOutputMode.Content ? cmd.context : undefined,
			hidden: true,
			gitignore: cmd.gitignore,
		});

		// The pattern did not compile as a regex on either engine, so it was
		// searched literally. Say so loudly (Law 10: no silent fallback) — matches
		// reflect exact text, not the intended pattern.
		if (result.patternTreatedAsLiteral) {
			console.log(
				chalk.yellow(
					`Warning: pattern did not compile as a regex (${result.patternTreatedAsLiteral}); searched literally instead.`,
				),
			);
			console.log(chalk.yellow("Matches reflect the exact text — fix the regex or escape it for a literal search."));
			console.log("");
		}

		console.log(chalk.green(`Total matches: ${result.totalMatches}`));
		console.log(chalk.green(`Files with matches: ${result.filesWithMatches}`));
		console.log(chalk.green(`Files searched: ${result.filesSearched}`));
		if (result.limitReached) {
			console.log(chalk.yellow(`Limit reached: true`));
		}
		console.log("");

		for (const match of result.matches) {
			const displayPath = match.path.replace(/\\/g, "/");

			if (cmd.mode === GrepOutputMode.Content) {
				if (match.contextBefore) {
					for (const ctx of match.contextBefore) {
						console.log(chalk.dim(`${displayPath}-${ctx.lineNumber}- ${ctx.line}`));
					}
				}
				console.log(`${chalk.cyan(displayPath)}:${chalk.yellow(String(match.lineNumber))}: ${match.line}`);
				if (match.contextAfter) {
					for (const ctx of match.contextAfter) {
						console.log(chalk.dim(`${displayPath}-${ctx.lineNumber}- ${ctx.line}`));
					}
				}
				console.log("");
			} else if (cmd.mode === GrepOutputMode.Count) {
				console.log(`${chalk.cyan(displayPath)}: ${match.matchCount ?? 0} matches`);
			} else {
				console.log(chalk.cyan(displayPath));
			}
		}
	} catch (err) {
		console.error(chalk.red(`Error: ${errorMessage(err)}`));
		process.exit(1);
	}
}
