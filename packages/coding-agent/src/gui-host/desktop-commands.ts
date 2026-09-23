/**
 * The commands this host answers for a window, beyond the text-mode set.
 *
 * `textMode` states which builtins a TEXT client can drive, and a command
 * whose terminal handler draws a panel is not one of them. A window is not a
 * text client: it draws panels of its own, so a command the terminal answers
 * with one is reachable here as long as the host carries the behaviour rather
 * than the terminal's component.
 *
 * The metadata is the declaration's own. A row listed here with a different
 * description than the terminal's would be a second copy of the command, and
 * `every-command-the-terminal-offers-has-a-desktop-decision.test.ts` reads
 * both from the same declarations for that reason.
 */
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
} from "../slash-commands/builtin-declarations";

/** Every command the host answers itself when a window runs it. */
const ANSWERED = {
	btw: true,
	debug: true,
	goal: true,
	"guided-goal": true,
	omfg: true,
	tan: true,
} as const satisfies Record<string, true>;

export type DesktopHostCommandName = keyof typeof ANSWERED;

export const DESKTOP_HOST_COMMAND_NAMES = Object.keys(ANSWERED) as readonly DesktopHostCommandName[];

/**
 * Those commands' declarations, in the order they are declared in.
 *
 * A name with no declaration behind it would list nothing and run nothing,
 * which is why the catalogue is derived rather than written out here.
 */
export const DESKTOP_HOST_COMMAND_DECLARATIONS: readonly BuiltinSlashCommandDeclaration[] = (
	BUILTIN_SLASH_COMMAND_DECLARATIONS as readonly BuiltinSlashCommandDeclaration[]
).filter(declaration => Object.hasOwn(ANSWERED, declaration.name));

/** Whether `name` is one this host answers rather than passing to the model. */
export function isDesktopHostCommand(name: string): name is DesktopHostCommandName {
	return Object.hasOwn(ANSWERED, name);
}
