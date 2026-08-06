/**
 * One owner for the question "does a bare `/cmd` hide a subcommand", asked by both dispatchers.
 *
 * A command that declares `subcommands` must never silently behave as one of them. The TUI answers
 * that with a picker and the text path with a list, but the QUESTION has to be answered the same
 * way on both, or a command would open a picker in the terminal and still print status over ACP.
 * That is why the predicate lives here rather than in either dispatcher.
 *
 * This module is a leaf on purpose: two type imports and no runtime dependency. `acp-builtins.ts`
 * defers loading the registry until it knows the text is a command, and that deferral only holds
 * if the modules it reaches for first stay cheap.
 */

import type { SlashCommandSpec, SubcommandDef } from "./types";

/**
 * Whether this invocation should show the subcommand surface instead of running the handler.
 *
 * Three conditions, all required: no arguments were given, the command declares subcommands, and
 * the declaration did not claim the distinct-bare-form exception. `args` is the raw argument text, trimmed
 * here so a caller cannot get the answer wrong by passing `" "`.
 */
export function bareInvocationShowsSubcommands(
	command: Pick<SlashCommandSpec, "subcommands" | "bareAction">,
	args: string,
): boolean {
	if (args.trim().length > 0) return false;
	if (!command.subcommands || command.subcommands.length === 0) return false;
	return command.bareAction !== "distinct";
}

/**
 * The text-mode answer: the subcommand list, one row each, with usage and description.
 *
 * The text path cannot show a picker, so it prints the same information the picker would carry.
 * Anything less would leave a client that has no terminal exactly where the TUI used to be.
 */
export function formatSubcommandList(name: string, subcommands: readonly SubcommandDef[]): string {
	const width = Math.max(...subcommands.map(sub => sub.name.length));
	const rows = subcommands.map(sub => {
		const usage = sub.usage ? ` ${sub.usage}` : "";
		return `  /${name} ${sub.name.padEnd(width)}${usage}  ${sub.description}`;
	});
	return [`/${name} has ${subcommands.length} subcommands:`, ...rows].join("\n");
}
