/** Which builtin slash commands a TEXT client may see, answered without loading a single handler. reading `command.handle !== undefined` off the assembled registry: */

import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { BUILTIN_SLASH_COMMAND_DECLARATIONS, type BuiltinSlashCommandDeclaration } from "./builtin-declarations";

/** Every declaration a text client can drive, in declared order. The widened element type is deliberate: the array is `as const`, so its members are exact literals */
export const TEXT_MODE_BUILTIN_DECLARATIONS: readonly BuiltinSlashCommandDeclaration[] = (
	BUILTIN_SLASH_COMMAND_DECLARATIONS as readonly BuiltinSlashCommandDeclaration[]
).filter(declaration => declaration.textMode === true);

/** All names, primary and alias, reserved by the builtins a text client can drive. Used to drop an extension command that would shadow a builtin or its alias at dispatch time: `models` */
export const ACP_BUILTIN_RESERVED_NAMES: ReadonlySet<string> = new Set(
	TEXT_MODE_BUILTIN_DECLARATIONS.flatMap(declaration => [declaration.name, ...(declaration.aliases ?? [])]),
);

/** Whether an extension command named `name` would be captured by builtin dispatch before it reached the extension's own handler. */
export function isAcpBuiltinShadowedName(name: string): boolean {
	if (ACP_BUILTIN_RESERVED_NAMES.has(name)) return true;
	const colon = name.indexOf(":");
	return colon !== -1 && ACP_BUILTIN_RESERVED_NAMES.has(name.slice(0, colon));
}

/** The commands advertised to ACP clients. Mode-specific copy wins where a declaration sets it: an ACP client gets the concise */
export const ACP_BUILTIN_SLASH_COMMANDS: AvailableCommand[] = TEXT_MODE_BUILTIN_DECLARATIONS.map(declaration => {
	const hint = declaration.acpInputHint ?? declaration.inlineHint;
	return {
		name: declaration.name,
		description: declaration.acpDescription ?? declaration.description,
		input: hint ? { hint } : undefined,
	};
});
