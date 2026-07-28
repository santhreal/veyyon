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
 *
 * AND IT LOADS THEM ONLY WHEN IT RUNS ONE. `./builtin-registry` is 740 modules: every builtin's
 * handler, and behind them the settings store, the MCP client and the session store. This function
 * is called on EVERY message in print and ACP mode, and almost every message is a prompt rather than
 * a command, so a static import made `veyyon -p "hello"` pay for the entire command surface to find
 * out the text did not start with a slash. `modes/print-mode.ts` reached 960 modules against a
 * ceiling of 250 that was measured when this edge did not exist.
 *
 * The order is what makes the deferral safe rather than a guess: `parseSlashCommand` is a leaf with
 * one type import, so the question "is this a command at all" is answered for free, and the registry
 * is loaded only after the answer is yes. A message that IS a command still runs exactly as it did,
 * which is why this is a deferral and not a fallback: nothing is skipped, and nothing is quietly
 * answered by a cheaper path.
 */
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
	const result = await command.handle(parsed, runtime);
	if (result === undefined) return { consumed: true };
	return result;
}
