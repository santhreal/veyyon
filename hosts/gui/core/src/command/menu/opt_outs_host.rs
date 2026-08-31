//! Pinned opt-outs for host boundary, terminal, task, and daemon commands.

use super::OptOut;

pub fn host_opt_outs() -> &'static [OptOut] {
	&[
		OptOut {
			command_name: "Attach",
			reason:       "host connection initiated with optional endpoint",
		},
		OptOut { command_name: "Detach", reason: "host connection closed" },
		OptOut {
			command_name: "RetryConnection",
			reason:       "reconnection triggered after connection drop",
		},
		OptOut { command_name: "RequestShutdown", reason: "host process shutdown requested" },
		OptOut { command_name: "LoadSessions", reason: "session index requested from host" },
		OptOut {
			command_name: "LoadTranscript",
			reason:       "transcript history paginated for a specific session and entry",
		},
		OptOut {
			command_name: "RetryTranscript",
			reason:       "transcript fetch retried for a specific session ID",
		},
		OptOut { command_name: "OpenSession", reason: "session opened by specific session ID" },
		OptOut {
			command_name: "RenameSession",
			reason:       "session renamed with specific session ID and string",
		},
		OptOut {
			command_name: "DeleteSession",
			reason:       "session deleted by specific session ID",
		},
		OptOut {
			command_name: "BranchSession",
			reason:       "session branched from specific session ID and entry ID",
		},
		OptOut {
			command_name: "ExportSession",
			reason:       "session exported to file for specific session ID",
		},
		OptOut {
			command_name: "CompactSession",
			reason:       "session context compaction triggered with instructions",
		},
		OptOut {
			command_name: "HandoffSession",
			reason:       "session handed off to another agent with instructions",
		},
		OptOut {
			command_name: "SubmitPrompt",
			reason:       "prompt turn submitted for specific session ID",
		},
		OptOut {
			command_name: "Steer",
			reason:       "steering prompt injected into running turn for session ID",
		},
		OptOut { command_name: "FollowUp", reason: "follow-up prompt enqueued for session ID" },
		OptOut {
			command_name: "AbortTurn",
			reason:       "running generation aborted for session ID",
		},
		OptOut {
			command_name: "SetQueueMode",
			reason:       "prompt delivery queue mode configured for session ID",
		},
		OptOut {
			command_name: "CancelTool",
			reason:       "tool execution canceled for specific tool ID",
		},
		OptOut {
			command_name: "SelectInteractionOption",
			reason:       "interaction option radio selected by index",
		},
		OptOut {
			command_name: "ToggleInteractionOption",
			reason:       "interaction option checkbox toggled by index",
		},
		OptOut {
			command_name: "SubmitInteraction",
			reason:       "interaction response submitted with typed payload",
		},
		OptOut {
			command_name: "CancelInteraction",
			reason:       "interaction dismissed with timeout flag",
		},
		OptOut {
			command_name: "LoadFileTree",
			reason:       "file hierarchy loaded for workspace and parent directory",
		},
		OptOut {
			command_name: "ReadFile",
			reason:       "file contents loaded for specific file ID and range",
		},
		OptOut {
			command_name: "SearchFiles",
			reason:       "file content search executed for workspace and query",
		},
		OptOut {
			command_name: "OpenExternal",
			reason:       "external URI opened in system browser",
		},
		OptOut {
			command_name: "RefreshChanges",
			reason:       "git diff recalculated for workspace change scope",
		},
		OptOut {
			command_name: "SelectChangeScope",
			reason:       "git diff change scope selected in changes view",
		},
		OptOut {
			command_name: "CreateTerminal",
			reason:       "new shell terminal created with optional cwd",
		},
		OptOut {
			command_name: "AttachTerminal",
			reason:       "terminal stream connected for specific terminal ID",
		},
		OptOut {
			command_name: "WriteTerminal",
			reason:       "raw byte stream written to terminal PTY",
		},
		OptOut {
			command_name: "ResizeTerminal",
			reason:       "terminal PTY dimension synchronized with cols and rows",
		},
		OptOut {
			command_name: "RestartTerminal",
			reason:       "terminal shell restarted for specific terminal ID",
		},
		OptOut {
			command_name: "ClearTerminal",
			reason:       "terminal scrollback cleared for specific terminal ID",
		},
		OptOut {
			command_name: "CloseTerminal",
			reason:       "terminal PTY closed for specific terminal ID",
		},
		OptOut {
			command_name: "StartProcess",
			reason:       "background process spawned with JSON spec",
		},
		OptOut {
			command_name: "WaitProcess",
			reason:       "process completion awaited for specific process ID",
		},
		OptOut {
			command_name: "DescribeProcess",
			reason:       "process metadata queried for specific process ID",
		},
		OptOut { command_name: "RefreshProcesses", reason: "process list refreshed from host" },
		OptOut {
			command_name: "FetchProcessLogs",
			reason:       "process stdout/stderr logs read from byte offset",
		},
		OptOut {
			command_name: "SendProcessInput",
			reason:       "stdin text sent to running process ID",
		},
		OptOut {
			command_name: "SignalProcess",
			reason:       "POSIX signal sent to running process ID",
		},
		OptOut {
			command_name: "StopProcess",
			reason:       "process termination requested for process ID",
		},
		OptOut {
			command_name: "RestartProcess",
			reason:       "process restarted with existing spec for process ID",
		},
		OptOut {
			command_name: "RefreshModels",
			reason:       "model catalog refreshed from provider APIs",
		},
		OptOut {
			command_name: "SelectModel",
			reason:       "active model selected with provider and model IDs",
		},
		OptOut {
			command_name: "SetThinkingLevel",
			reason:       "model thinking budget configured by string value",
		},
		OptOut {
			command_name: "RefreshProviders",
			reason:       "provider credentials refreshed from host",
		},
		OptOut {
			command_name: "StartProviderAuth",
			reason:       "OAuth login flow started for provider ID",
		},
		OptOut {
			command_name: "RefreshAuth",
			reason:       "authentication tokens refreshed from keychain",
		},
		OptOut {
			command_name: "SubmitAuthSecret",
			reason:       "API key secret submitted for provider ID",
		},
		OptOut {
			command_name: "OpenAuthUrl",
			reason:       "OAuth authorization URL opened in browser",
		},
		OptOut {
			command_name: "CancelAuthFlow",
			reason:       "in-flight OAuth login canceled for provider ID",
		},
		OptOut {
			command_name: "RetryAuthFlow",
			reason:       "failed OAuth login retried for provider ID",
		},
		OptOut { command_name: "RefreshMcp", reason: "MCP server status refreshed from host" },
		OptOut {
			command_name: "ConnectMcp",
			reason:       "MCP server connection initiated for server ID",
		},
		OptOut {
			command_name: "DisconnectMcp",
			reason:       "MCP server connection terminated for server ID",
		},
		OptOut {
			command_name: "SetMcpEnabled",
			reason:       "MCP server enabled state toggled for server ID",
		},
		OptOut {
			command_name: "CallMcpTool",
			reason:       "MCP tool invoked with server ID, tool name, and JSON args",
		},
		OptOut {
			command_name: "ReadMcpResource",
			reason:       "MCP resource read by server ID and URI",
		},
		OptOut {
			command_name: "GetMcpPrompt",
			reason:       "MCP prompt fetched by server ID, name, and arguments",
		},
		OptOut {
			command_name: "RefreshExtensions",
			reason:       "extension registry refreshed from host",
		},
		OptOut {
			command_name: "InvokeExtensionAction",
			reason:       "extension action executed with typed input",
		},
		OptOut {
			command_name: "SetExtensionEnabled",
			reason:       "extension enabled state toggled for extension ID",
		},
		OptOut {
			command_name: "SetToolEnabled",
			reason:       "built-in tool enabled state toggled by tool name",
		},
		OptOut { command_name: "RefreshAgents", reason: "subagent roster refreshed from host" },
		OptOut {
			command_name: "FetchAgentTranscript",
			reason:       "agent transcript fetched from byte offset",
		},
		OptOut { command_name: "ChatAgent", reason: "message sent directly to subagent ID" },
		OptOut {
			command_name: "KillAgent",
			reason:       "running subagent process terminated by ID",
		},
		OptOut { command_name: "ReviveAgent", reason: "stopped subagent restarted by ID" },
		OptOut {
			command_name: "SpawnTask",
			reason:       "subagent task spawned with prompt and agent ID",
		},
		OptOut { command_name: "CancelTask", reason: "running task canceled by task ID" },
		OptOut {
			command_name: "LoadSettings",
			reason:       "user settings file reloaded from disk",
		},
		OptOut {
			command_name: "EditSetting",
			reason:       "user setting edited with path and JSON value",
		},
		OptOut {
			command_name: "SetSetting",
			reason:       "user setting persisted with path and JSON value",
		},
		OptOut {
			command_name: "ResetSetting",
			reason:       "user setting reset to default by path",
		},
		OptOut {
			command_name: "LoadThemes",
			reason:       "theme directory scanned for theme files",
		},
		OptOut { command_name: "SetTheme", reason: "active theme applied by name" },
		OptOut {
			command_name: "LoadKeybindings",
			reason:       "keymap configuration reloaded from disk",
		},
		OptOut { command_name: "SetKeybinding", reason: "shortcut assigned to command string" },
		OptOut {
			command_name: "RefreshDiagnostics",
			reason:       "language server diagnostics refreshed from host",
		},
		OptOut {
			command_name: "RetryDiagnosticSource",
			reason:       "failed language server restarted by source name",
		},
		OptOut {
			command_name: "NextDiagnostic",
			reason:       "diagnostic cursor stepped forward or backward",
		},
		OptOut {
			command_name: "DismissNotice",
			reason:       "notification toast dismissed by notice ID",
		},
		OptOut { command_name: "ClearOutput", reason: "output panel buffer cleared" },
		OptOut { command_name: "GetUsage", reason: "token and credit usage queried from host" },
		OptOut {
			command_name: "GetContextBreakdown",
			reason:       "context window token breakdown queried from host",
		},
	]
}
