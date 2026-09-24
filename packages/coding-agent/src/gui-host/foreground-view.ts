/**
 * The command a session is waiting on, projected for the window.
 *
 * The bash tool registers a foreground wait in
 * `tools/shell/bash-foreground-registry`, keyed by the session its command
 * runs in. This reads that registry and states the command at a drawable
 * width, so the window's control names what it would move without the host
 * sending a command line wider than the footer it sits in.
 */
import { TRUNCATE_LENGTHS } from "../tools/core/render-utils";
import { foregroundBashCommand } from "../tools/shell/bash-foreground-registry";
import type { ForegroundCommandView } from "./wire";

/** The width a command line is drawn at before it is cut. */
const COMMAND_WIDTH = TRUNCATE_LENGTHS.CONTENT;

/** The view for `session`, or `null` when it is waiting on nothing. */
export function foregroundSection(session: string): ForegroundCommandView | null {
	const command = foregroundBashCommand(session);
	if (command === undefined) return null;
	const truncated = command.length > COMMAND_WIDTH;
	return { command: truncated ? command.slice(0, COMMAND_WIDTH) : command, truncated };
}
