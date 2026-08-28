import type { CollabGuestContext } from "../collab/guest";
import type { CollabHostContext } from "../collab/host";
import type { Settings } from "../config/settings";
import type { InteractiveModeContext } from "../modes/types";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";

/** Declarative subcommand definition for commands like /mcp. */
export interface SubcommandDef {
	name: string;
	description: string;
	/** Usage hint shown as dim ghost text, e.g. "<name> [project|user]". */
	usage?: string;
}

/** Declarative builtin slash command metadata used by autocomplete and help UI. */
export interface BuiltinSlashCommand {
	name: string;
	aliases?: string[];
	description: string;
	/** Whether the command consumes text after the command name. */
	allowArgs?: boolean;
	/** Subcommands for dropdown completion (e.g. /mcp add, /mcp list). */
	subcommands?: SubcommandDef[];
	/** What a bare `/cmd` does when `subcommands` is set: open the picker (the default) or run the command's own bare behavior. Declared on `BuiltinSlashCommandDeclaration`, which documents */
	bareAction?: "picker" | "distinct";
	/** Static inline hint when command takes a simple argument (no subcommands). */
	inlineHint?: string;
	/** TUI-only dynamic status text for command-name autocomplete. Static `description` remains canonical for ACP/help. */
	getTuiAutocompleteDescription?: (runtime: TuiSlashCommandRuntime) => string | undefined;
	/** Group header the command renders under when the / menu is browsed with no filter. Assigned centrally from BUILTIN_SLASH_COMMAND_CATEGORIES (one */
	category?: string;
}

/** Parsed slash-command text after stripping the leading "/". */
export interface ParsedSlashCommand {
	name: string;
	args: string;
	text: string;
}

/** Result returned by a slash-command handler. - `undefined` (and the implicit `void` return) — command was handled and */
export type SlashCommandResult = undefined | { consumed: true } | { prompt: string };

/** Runtime visible to slash-command handlers that run in text/ACP mode. Both the TUI dispatcher (when invoking a `handle` via its adapter) and the */
export interface SlashCommandRuntime {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	cwd: string;
	/** Emit text to the operator. TUI maps to `ctx.showStatus`, ACP to `sessionUpdate`. */
	output: (text: string) => Promise<void> | void;
	/** Re-advertise the available command list (no-op outside ACP). */
	refreshCommands: () => Promise<void> | void;
	/** Reload plugin state (caches, slash command registry, project registries) and re-emit available commands. Used by `/reload-plugins`, `/move`, and */
	reloadPlugins: () => Promise<void>;
	notifyTitleChanged?: () => Promise<void> | void;
	notifyConfigChanged?: () => Promise<void> | void;
}

/** The exact slice of `InteractiveModeContext` the TUI slash-command host reads (78 of its 215 members). This is the whole surface every `handleTui` handler */
export type TuiSlashCommandHostContext = CollabHostContext &
	CollabGuestContext &
	Pick<
		InteractiveModeContext,
		| "collabGuest"
		| "collabHost"
		| "editor"
		| "goalModeEnabled"
		| "handleAdvisorDumpCommand"
		| "handleAdvisorStatusCommand"
		| "handleBtwCommand"
		| "handleChangelogCommand"
		| "handleClearCommand"
		| "handleCompactCommand"
		| "handleContextCommand"
		| "handleDropCommand"
		| "handleDumpCommand"
		| "handleExportCommand"
		| "handleForkCommand"
		| "handleFreshCommand"
		| "handleGoalModeCommand"
		| "handleGuidedGoalCommand"
		| "handleHandoffCommand"
		| "handleHotkeysCommand"
		| "handleJobsCommand"
		| "handleLoopCommand"
		| "handleMCPCommand"
		| "handleMemoryCommand"
		| "handleMoveCommand"
		| "handleOmfgCommand"
		| "handlePlanModeCommand"
		| "handleQueueCommand"
		| "handleRenameCommand"
		| "handleResumeSession"
		| "handleSessionCommand"
		| "handleSessionDeleteCommand"
		| "handleShakeCommand"
		| "handleShareCommand"
		| "handleSSHCommand"
		| "handleTanCommand"
		| "handleTodoCommand"
		| "handleToolsCommand"
		| "handleUsageCommand"
		| "handleVibeModeCommand"
		| "loopLimit"
		| "loopModeEnabled"
		| "loopPrompt"
		| "lspServers"
		| "oauthManualInput"
		| "openPlanReview"
		| "planModeEnabled"
		| "planModePlanFilePath"
		| "present"
		| "refreshSlashCommandState"
		| "requestRelaunch"
		| "session"
		| "sessionManager"
		| "settings"
		| "showAccountManager"
		| "showAdvisorConfigure"
		| "showAgentsDashboard"
		| "showAskDialog"
		| "showCopySelector"
		| "showDebugSelector"
		| "showError"
		| "showExtensionsDashboard"
		| "showFullWelcome"
		| "showHookConfirm"
		| "showHookInput"
		| "showLogin"
		| "showLogout"
		| "showModelSelector"
		| "showProviderSetup"
		| "showResetUsageSelector"
		| "showSessionSelector"
		| "showSettingsSelector"
		| "showStatus"
		| "showSubcommandPicker"
		| "showThinkingSelector"
		| "showTreeSelector"
		| "showUserMessageSelector"
		| "showWarning"
		| "shutdown"
		| "statusLine"
		| "todoPhases"
		| "ui"
		| "updateEditorBorderColor"
		| "vibeModeEnabled"
	>;

/** Runtime visible to TUI-only handlers (`handleTui`). Carries the interactive mode context. Intentionally narrower than `SlashCommandRuntime` so existing */
export interface TuiSlashCommandRuntime {
	ctx: TuiSlashCommandHostContext;
}

/** Unified slash-command spec consumed by both TUI and ACP dispatchers. */
export interface SlashCommandSpec extends BuiltinSlashCommand {
	/** When false, the dispatcher refuses to handle invocations that include arguments. */
	allowArgs?: boolean;
	/** ACP-specific override for `description`. Used by `ACP_BUILTIN_SLASH_COMMANDS` when building `available_commands_update` payloads so the client receives */
	acpDescription?: string;
	/** ACP-specific override for the advertised input hint. `subcommands`-only specs that historically advertised `<subcommand>` / `[on|off|status]` / */
	acpInputHint?: string;
	/** Text/ACP-mode handler. The same body is invoked from the ACP dispatcher and, via the TUI adapter, when no `handleTui` override is provided. */
	handle?:
		| ((
				command: ParsedSlashCommand,
				runtime: SlashCommandRuntime,
		  ) => SlashCommandResult | Promise<SlashCommandResult>)
		| ((command: ParsedSlashCommand, runtime: SlashCommandRuntime) => void | Promise<void>);
	/** TUI-only handler that supersedes `handle` when both are present. Use for selectors, wizards, dashboards, and anything else that requires */
	handleTui?:
		| ((
				command: ParsedSlashCommand,
				runtime: TuiSlashCommandRuntime,
		  ) => SlashCommandResult | Promise<SlashCommandResult>)
		| ((command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime) => void | Promise<void>);
}

/** Result returned by `executeAcpBuiltinSlashCommand`. */
export type AcpBuiltinSlashCommandResult = false | { consumed: true } | { prompt: string };
