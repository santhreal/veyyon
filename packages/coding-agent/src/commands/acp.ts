/**
 * Run Veyyon as an ACP (Agent Client Protocol) server over stdio.
 *
 * Thin wrapper around the launch flow that forces `mode: "acp"` unless the
 * ACP terminal-auth flag asks the same command to open the interactive TUI.
 */
import { Command } from "@veyyon/utils/cli";
import { type Args as ParsedArgs, parseArgs, reportCliUsageError } from "../cli/args";
import { EXIT_USAGE } from "../cli/exit-codes";
import { runRootCommand } from "../main";
import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";

export default class Acp extends Command {
	// One line, because the root COMMANDS list prints this verbatim and a
	// four-line entry there buries the twenty commands under it. What acp accepts
	// belongs in its own help, which is what the examples below are for.
	static description = "Run Veyyon as an ACP (Agent Client Protocol) server over stdio";

	// `strict = false` plus the hand-rolled `parseArgs` below mean this command
	// declares no `static flags`, so the generated FLAGS block is empty. It is not
	// that acp takes no flags: it takes EVERY launch flag, because it runs the
	// launch parser. A USAGE line reading `$ veyyon acp` with nothing under it
	// says the opposite, and `docs/approval-mode.md` documents four acp flags
	// this help never mentioned, so the examples say it instead.
	static strict = false;

	static examples = [
		"# Serve ACP over stdio\n  veyyon acp",
		"# acp takes the same flags as a bare `veyyon` launch; run `veyyon --help` for the full list\n  veyyon acp --model anthropic/claude-sonnet-4-5",
		"# Skip approval prompts for a client that has its own gate\n  veyyon acp --approval-mode yolo",
		"# Apply a config overlay for this run\n  veyyon acp --config ./acp.yml",
	];

	async run(): Promise<void> {
		const { args, terminalAuth } = prepareAcpTerminalAuthArgs(this.argv);
		let parsed: ParsedArgs;
		try {
			parsed = parseArgs(args);
		} catch (error) {
			if (reportCliUsageError(error)) {
				process.exitCode = EXIT_USAGE;
				return;
			}
			throw error;
		}
		if (!terminalAuth) {
			parsed.mode = "acp";
		}
		await runRootCommand(parsed, args);
	}
}
