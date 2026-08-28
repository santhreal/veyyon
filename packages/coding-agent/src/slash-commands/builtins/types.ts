import type { BUILTIN_SLASH_COMMAND_DECLARATIONS, BuiltinSlashCommandName } from "../builtin-declarations";
import type { SlashCommandSpec } from "../types";

export type DeclarationNamed<Name extends BuiltinSlashCommandName> = Extract<
	(typeof BUILTIN_SLASH_COMMAND_DECLARATIONS)[number],
	{ readonly name: Name }
>;

export type HandlerSetFor<Name extends BuiltinSlashCommandName> =
	DeclarationNamed<Name> extends { readonly textMode: true }
		? Required<Pick<SlashCommandSpec, "handle">> &
				Pick<SlashCommandSpec, "handleTui" | "getTuiAutocompleteDescription">
		: Pick<SlashCommandSpec, "handleTui" | "getTuiAutocompleteDescription"> & { readonly handle?: never };
