import { lookupBuiltinSlashCommand } from "./builtin-registry";
import { parseSlashCommand } from "./helpers/parse";
import type { AcpBuiltinSlashCommandResult, SlashCommandRuntime } from "./types";

/**
 * The metadata half moved to `text-mode-builtins.ts`, which reaches four modules instead of 941.
 *
 * These re-exports keep every existing import path working. Prefer importing from
 * `./text-mode-builtins` directly: coming through this module still loads `builtin-registry.ts` and
 * every handler behind it, which is the cost the split exists to avoid.
 */
export {
	ACP_BUILTIN_RESERVED_NAMES,
	ACP_BUILTIN_SLASH_COMMANDS,
	isAcpBuiltinShadowedName,
} from "./text-mode-builtins";
export type { AcpBuiltinSlashCommandResult } from "./types";

/**
 * Dispatch a slash command in ACP/text mode. Returns:
 * - `false` when no builtin matched (or matched a TUI-only entry); the caller
 *   should forward the input as a prompt.
 * - `{ consumed: true }` when the command handled the input entirely.
 * - `{ prompt }` when the command was handled but a residual prompt should be
 *   sent to the model.
 *
 * This is the one thing here that genuinely needs the handlers, because it RUNS one.
 */
export async function executeAcpBuiltinSlashCommand(
	text: string,
	runtime: SlashCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;
	const command = lookupBuiltinSlashCommand(parsed.name);
	if (!command?.handle) return false;
	const result = await command.handle(parsed, runtime);
	if (result === undefined) return { consumed: true };
	return result;
}
