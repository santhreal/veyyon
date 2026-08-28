/** One owner for the question "does a bare `/cmd` hide a subcommand", asked by both dispatchers. A command that declares `subcommands` must never silently behave as one of them. The TUI answers */

import type { SlashCommandSpec, SubcommandDef } from "./types";

/** Whether this invocation should show the subcommand surface instead of running the handler. Three conditions, all required: no arguments were given, the command declares subcommands, and */
export function bareInvocationShowsSubcommands(
	command: Pick<SlashCommandSpec, "subcommands" | "bareAction">,
	args: string,
): boolean {
	if (args.trim().length > 0) return false;
	if (!command.subcommands || command.subcommands.length === 0) return false;
	return command.bareAction !== "distinct";
}

/** The text-mode answer: the subcommand list, one row each, with usage and description. The text path cannot show a picker, so it prints the same information the picker would carry. */
export function formatSubcommandList(name: string, subcommands: readonly SubcommandDef[]): string {
	const width = Math.max(...subcommands.map(sub => sub.name.length));
	const rows = subcommands.map(sub => {
		const usage = sub.usage ? ` ${sub.usage}` : "";
		return `  /${name} ${sub.name.padEnd(width)}${usage}  ${sub.description}`;
	});
	return [`/${name} has ${subcommands.length} subcommands:`, ...rows].join("\n");
}
