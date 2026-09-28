/**
 * How the desktop reaches each builtin slash command the terminal offers
 * outside text mode.
 *
 * A command with `textMode: true` reaches the window through the command
 * catalogue the host advertises, so it has no row here. Every other builtin
 * has one: a host action, a host-answered command (the set in
 * `DESKTOP_HOST_COMMAND_NAMES`), a window surface, or a recorded gap.
 */
import type { HostActionTag } from "../wire";
import type { DesktopCarrier, SurfaceClaim } from "./carrier";

/** A command carrier whose window claim names a desktop surface. */
export type CommandCarrier = Exclude<DesktopCarrier, { window: string }> | { window: SurfaceClaim };

export const COMMAND_CARRIERS: Readonly<Record<string, CommandCarrier>> = {
	settings: { window: "Settings" },
	statusline: { window: "Settings, Status Line group" },
	welcome: { window: "Empty state" },
	lsp: { window: "Diagnostics panel" },
	setup: { window: "Settings, Providers page" },
	providers: { window: "Settings, Providers page" },
	login: { action: "StartProviderAuth" },
	logout: {
		gap: "a provider account cannot be signed out from the window: no host action removes stored credentials",
	},
	plan: { action: "SetSessionMode" },
	"plan-review": { action: "ReviewPlan" },
	vibe: { action: "SetSessionMode" },
	goal: { host: "answered by the host through GoalDriver, drawn in the goal card of the interaction dock" },
	"guided-goal": { host: "the goal interview, asked as question cards, ending in the goal it drafted" },
	loop: { action: "SetSessionMode" },
	queue: { action: "FollowUp" },
	switch: { action: "SelectModel" },
	collab: { action: "StartShare" },
	join: { host: "the room the link names, joined on the window that asked" },
	leave: { host: "out of the share this window is in, either side of it" },
	copy: { window: "Transcript, text selection and per-block copy" },
	hotkeys: { window: "Settings, Keybindings page" },
	extensions: {
		gap: "installed extensions, skills and hooks cannot be listed or toggled from the window: no snapshot section or host action carries them",
	},
	agents: { window: "Agents panel" },
	branch: { action: "BranchSession" },
	fork: { action: "BranchSession" },
	tree: { window: "Sidebar, branch children indented under their parent" },
	new: { action: "CreateSession" },
	drop: { action: "DeleteSession" },
	resume: { window: "Sidebar, thread search" },
	btw: { host: "answered on the session's own context, drawn as a side pair" },
	tan: { host: "forked to a background agent, drawn in the transcript and the agent roster" },
	omfg: { host: "the rule the complaint forges, reviewed on a card that saves, amends or leaves it" },
	retry: { action: "RetryTurn" },
	rephrase: { action: "RephraseReply" },
	debug: { host: "the debug tools that read nothing of the terminal, chosen in a question and drawn as command output" },
	exit: { window: "Command palette, Quit" },
	profile: { window: "Sidebar, profile switcher" },
	pause: { action: "PauseAgents" },
	quit: { window: "Command palette, Quit" },
};

/**
 * The host actions each window-carried command's surface sends. A surface
 * that sends none answers the command inside the window alone.
 */
export const COMMAND_WINDOW_ACTIONS: Readonly<Record<string, readonly HostActionTag[]>> = {
	settings: ["LoadSettings", "SetSetting", "ResetSetting"],
	statusline: ["LoadSettings", "SetSetting", "ResetSetting"],
	welcome: ["ListSessions", "CreateSession"],
	lsp: ["RefreshDiagnostics", "RetryDiagnosticSource"],
	setup: ["RefreshProviders", "StartProviderAuth", "SubmitAuthSecret", "OpenAuthUrl"],
	providers: ["RefreshProviders", "StartProviderAuth", "SubmitAuthSecret", "CancelAuthFlow", "RetryAuthFlow"],
	copy: [],
	hotkeys: ["LoadKeybindings", "SetKeybinding"],
	agents: ["RefreshAgents", "ReviveAgent", "CancelTask"],
	tree: ["ListSessions", "OpenSession"],
	resume: ["SearchSessions", "PreviewSessionTranscript", "OpenSession"],
	exit: ["Detach"],
	profile: ["RefreshProfiles", "CreateProfile", "RenameProfile", "DeleteProfile", "Attach"],
	quit: ["Detach"],
};
