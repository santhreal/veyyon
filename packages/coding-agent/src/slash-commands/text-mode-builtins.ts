/**
 * Which builtin slash commands a TEXT client may see, answered without loading a single handler.
 *
 * WHY THIS FILE EXISTS. Three questions are really one question, and all three used to be answered by
 * reading `command.handle !== undefined` off the assembled registry:
 *
 *   - what to ADVERTISE to an ACP client, which must not be shown a command it cannot drive;
 *   - which names are RESERVED, so an extension cannot register one that dispatch would capture first;
 *   - what goes in the available-commands list a client renders.
 *
 * Reading `handle` means loading all 67 handler bodies, and a handler body reaches the model resolver,
 * the collab host, the OAuth providers and the session store: `available-commands.ts` measured 959
 * modules and `acp-builtins.ts` 941, for three facts that are pure metadata. The answer now comes from
 * `textMode` in `builtin-declarations.ts`, so this module reaches FOUR: itself, the declarations, and
 * the two one-module leaves the declarations already needed.
 *
 * WHY THE FLAG CANNOT DRIFT. `textMode` is not a second copy of "has a handler" that a test compares.
 * The registry's handler table is TYPED against it: a declaration with `textMode: true` must supply
 * `handle` and one without it may not, both enforced by `HandlerSetFor` in `builtin-registry.ts`. There
 * is nothing here for a gate to keep in sync.
 *
 * WHAT STAYS IN `acp-builtins.ts` is dispatch, `executeAcpBuiltinSlashCommand`, which runs a handler
 * and therefore legitimately loads them. That is a fact about the handler table, not about the
 * declarations.
 */

import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { BUILTIN_SLASH_COMMAND_DECLARATIONS, type BuiltinSlashCommandDeclaration } from "./builtin-declarations";

/**
 * Every declaration a text client can drive, in declared order.
 *
 * The widened element type is deliberate: the array is `as const`, so its members are exact literals
 * and the optional fields exist only on the ones that set them, which is what makes the name union
 * closed. Consumers want to read `aliases` or `subcommands` off any member, so they read them through
 * the declared interface.
 */
export const TEXT_MODE_BUILTIN_DECLARATIONS: readonly BuiltinSlashCommandDeclaration[] = (
	BUILTIN_SLASH_COMMAND_DECLARATIONS as readonly BuiltinSlashCommandDeclaration[]
).filter(declaration => declaration.textMode === true);

/**
 * All names, primary and alias, reserved by the builtins a text client can drive.
 *
 * Used to drop an extension command that would shadow a builtin or its alias at dispatch time: `models`
 * is an alias for `/model`, so an extension registering `models` would appear in the palette and then
 * execute the builtin.
 */
export const ACP_BUILTIN_RESERVED_NAMES: ReadonlySet<string> = new Set(
	TEXT_MODE_BUILTIN_DECLARATIONS.flatMap(declaration => [declaration.name, ...(declaration.aliases ?? [])]),
);

/**
 * Whether an extension command named `name` would be captured by builtin dispatch before it reached
 * the extension's own handler.
 *
 * Beyond exact name and alias collisions, `parseSlashCommand` treats `:` as the separator between a
 * name and its arguments, so a colon-namespaced name whose prefix is a text-mode builtin, `model:foo`
 * for instance, runs `/model` with `foo` as its arguments. Such names must not be advertised.
 */
export function isAcpBuiltinShadowedName(name: string): boolean {
	if (ACP_BUILTIN_RESERVED_NAMES.has(name)) return true;
	const colon = name.indexOf(":");
	return colon !== -1 && ACP_BUILTIN_RESERVED_NAMES.has(name.slice(0, colon));
}

/**
 * The commands advertised to ACP clients.
 *
 * Mode-specific copy wins where a declaration sets it: an ACP client gets the concise
 * `acpDescription` and `acpInputHint` when they are declared, and the unified `description` and
 * `inlineHint` otherwise.
 */
export const ACP_BUILTIN_SLASH_COMMANDS: AvailableCommand[] = TEXT_MODE_BUILTIN_DECLARATIONS.map(declaration => {
	const hint = declaration.acpInputHint ?? declaration.inlineHint;
	return {
		name: declaration.name,
		description: declaration.acpDescription ?? declaration.description,
		input: hint ? { hint } : undefined,
	};
});
