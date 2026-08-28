import { bareInvocationShowsSubcommands, formatSubcommandList } from "./bare-subcommand";
import { parseSlashCommand } from "./helpers/parse";
import type { AcpBuiltinSlashCommandResult, SlashCommandRuntime } from "./types";

/** The metadata half moved to `text-mode-builtins.ts`, which reaches four modules instead of 941. These re-exports keep every existing import path working. Prefer importing from */
export {
	ACP_BUILTIN_RESERVED_NAMES,
	ACP_BUILTIN_SLASH_COMMANDS,
	isAcpBuiltinShadowedName,
} from "./text-mode-builtins";
export type { AcpBuiltinSlashCommandResult } from "./types";

/** Dispatch a slash command in ACP/text mode. Returns: - `false` when no builtin matched (or matched a TUI-only entry); the caller */
export async function executeAcpBuiltinSlashCommand(
	text: string,
	runtime: SlashCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;
	const { lookupBuiltinSlashCommand } = await import("./builtin-registry");
	const command = lookupBuiltinSlashCommand(parsed.name);
	if (!command?.handle) return false;
	if (parsed.args.length > 0 && !command.allowArgs) return false;
	// The same rule the TUI answers with a picker: a bare `/cmd` must never silently behave as one
	// of its subcommands. There is no picker to open here, so the list IS the answer, and a client
	// with no terminal learns what the command can do rather than being handed one of eight.
	if (command.subcommands && bareInvocationShowsSubcommands(command, parsed.args)) {
		await runtime.output(formatSubcommandList(command.name, command.subcommands));
		return { consumed: true };
	}
	const result = await command.handle(parsed, runtime);
	if (result === undefined) return { consumed: true };
	return result;
}
