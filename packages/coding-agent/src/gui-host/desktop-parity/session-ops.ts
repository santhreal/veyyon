/**
 * How the desktop performs every session operation the terminal offers.
 *
 * Member ids: a terminal keybinding by its action id (`app.session.new`), a
 * slash command by its name (`/branch`) and a subcommand by both (`/session
 * delete`). The slash commands that operate on a session's lifecycle are listed
 * in `SESSION_OPERATION_COMMANDS`; their subcommands and the `app.session.*`
 * keybindings are enumerated from the terminal's own registries.
 */
import type { DesktopCarrier } from "./carrier";

/** The slash commands that create, open, reshape, share or remove a session. */
export const SESSION_OPERATION_COMMANDS = [
	"new",
	"resume",
	"branch",
	"fork",
	"tree",
	"rename",
	"move",
	"drop",
	"export",
	"dump",
	"share",
	"collab",
	"join",
	"leave",
	"compact",
	"shake",
	"handoff",
	"session",
] as const;

export const SESSION_OPERATION_CARRIERS: Readonly<Record<string, DesktopCarrier>> = {
	"app.session.new": { action: "CreateSession" },
	"app.session.resume": { action: "OpenSession" },
	// The terminal opens a picker of earlier user messages; `BranchSession`
	// takes the chosen entry.
	"app.session.fork": { action: "BranchSession" },
	"app.session.tree": {
		gap: "The desktop cannot browse a session tree or switch to another branch; its transcript shows the active branch only.",
	},
	"app.session.observe": { section: "Agents" },
	"/new": { action: "CreateSession" },
	"/resume": { action: "OpenSession" },
	"/branch": { action: "BranchSession" },
	"/fork": {
		gap: "The desktop cannot duplicate a whole session into a new file; BranchSession starts a branch from one message instead.",
	},
	"/tree": {
		gap: "The desktop cannot browse a session tree or switch to another branch; its transcript shows the active branch only.",
	},
	"/rename": { action: "RenameSession" },
	"/move": { action: "RunCommand" },
	// Deleting the open session leaves the window on the session list, where
	// `CreateSession` starts the next one.
	"/drop": { action: "DeleteSession" },
	"/export": { action: "ExportSession" },
	"/dump": { action: "RunCommand" },
	"/share": { action: "RunCommand" },
	"/collab": { section: "Share" },
	"/collab start": { action: "StartShare" },
	"/collab view": { action: "StartShare" },
	"/collab status": { action: "RefreshShare" },
	"/collab stop": { action: "StopShare" },
	"/join": { action: "JoinShare" },
	"/leave": { action: "LeaveShare" },
	"/compact": { action: "CompactSession" },
	"/compact summary": { action: "CompactSession" },
	"/shake": { action: "RunCommand" },
	"/shake elide": { action: "RunCommand" },
	"/shake images": { action: "RunCommand" },
	"/handoff": { action: "HandoffSession" },
	"/session": { action: "RunCommand" },
	"/session info": { action: "RunCommand" },
	"/session delete": { action: "DeleteSession" },
};
