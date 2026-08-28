import type { CollabGuestContext } from "../collab/guest";
import type { CollabHostContext } from "../collab/host";
import type { Settings } from "../config/settings";
import type { InteractiveModeContext } from "../modes/types";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";

export interface SubcommandDef {
	name: string;
	description: string;
	usage?: string;
}

export interface BuiltinSlashCommand {
	name: string;
	aliases?: string[];
	description: string;
	allowArgs?: boolean;
	subcommands?: SubcommandDef[];
	bareAction?: "picker" | "distinct";
	inlineHint?: string;
	getTuiAutocompleteDescription?: (runtime: TuiSlashCommandRuntime) => string | undefined;
	category?: string;
}

export interface ParsedSlashCommand {
	name: string;
	args: string;
	text: string;
}

export type SlashCommandResult = undefined | { consumed: true } | { prompt: string };

export interface SlashCommandRuntime {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	cwd: string;
	output: (text: string) => Promise<void> | void;
	refreshCommands: () => Promise<void> | void;
	reloadPlugins: () => Promise<void>;
	notifyTitleChanged?: () => Promise<void> | void;
	notifyConfigChanged?: () => Promise<void> | void;
}

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

export interface TuiSlashCommandRuntime {
	ctx: TuiSlashCommandHostContext;
}

export interface SlashCommandSpec extends BuiltinSlashCommand {
	allowArgs?: boolean;
	acpDescription?: string;
	acpInputHint?: string;
	handle?:
		| ((
				command: ParsedSlashCommand,
				runtime: SlashCommandRuntime,
		  ) => SlashCommandResult | Promise<SlashCommandResult>)
		| ((command: ParsedSlashCommand, runtime: SlashCommandRuntime) => void | Promise<void>);
	handleTui?:
		| ((
				command: ParsedSlashCommand,
				runtime: TuiSlashCommandRuntime,
		  ) => SlashCommandResult | Promise<SlashCommandResult>)
		| ((command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime) => void | Promise<void>);
}

export type AcpBuiltinSlashCommandResult = false | { consumed: true } | { prompt: string };
