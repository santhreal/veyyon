import { PRIORITY_TIER_LABEL } from "../config/service-tier";
import { COMPACT_MODES } from "../session/compact-modes";

export interface BuiltinSlashCommandDeclaration {
	readonly name: string;
	readonly description: string;
	readonly textMode?: true;
	readonly aliases?: readonly string[];
	readonly allowArgs?: boolean;
	readonly inlineHint?: string;
	readonly acpDescription?: string;
	readonly acpInputHint?: string;
	readonly bareAction?: "picker" | "distinct";
	readonly subcommands?: ReadonlyArray<{
		readonly name: string;
		readonly description: string;
		readonly usage?: string;
	}>;
}

export const BUILTIN_SLASH_COMMAND_DECLARATIONS = [
	{
		name: "settings",
		description: "Open settings menu",
	},

	{
		name: "statusline",
		description: "Configure the status line (opens Settings at the Status Line group)",
	},

	{
		name: "welcome",
		aliases: ["help"],
		description: "Show the full welcome screen (actions, recent sessions)",
	},

	{
		name: "lsp",
		description: "Show language server status",
	},

	{
		name: "setup",
		description: "Open provider setup",
		allowArgs: true,
		bareAction: "distinct",
		subcommands: [{ name: "providers", description: "Configure sign-in and web search providers" }],
	},

	{
		name: "providers",
		description: "Manage accounts for every provider",
	},

	{
		name: "account",
		textMode: true,
		description: "Accounts this session is using, per provider",
		acpDescription: "Show the accounts this session is using",
		acpInputHint: "[status|manager|switch|use|name|refresh|usage|login|logout]",
		allowArgs: true,
		subcommands: [
			{ name: "status", description: "Show the account each provider is serving this session with" },
			{ name: "manager", description: "Open the account manager" },
			{ name: "switch", description: "Open the account manager focused on one provider", usage: "[provider]" },
			{
				name: "use",
				description: "Switch a provider to one account, everywhere on this machine",
				usage: "<provider> <account>",
			},
			{ name: "name", description: "Name this session's active account for its provider", usage: "<text>" },
			{ name: "refresh", description: "Re-probe the credentials this session is using" },
			{ name: "usage", description: "Show provider usage and limits" },
			{ name: "login", description: "Log in and add an account for a provider", usage: "[provider]" },
			{ name: "logout", description: "Log an account out", usage: "[provider]" },
		],
	},

	{
		name: "plan",
		description: "Toggle plan mode (agent plans before executing)",
		inlineHint: "[prompt]",
		allowArgs: true,
	},

	{
		name: "plan-review",
		description: "Re-open the plan review for the latest plan (plan mode only)",
	},

	{
		name: "vibe",
		description: "Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)",
		inlineHint: "[prompt]",
		allowArgs: true,
	},

	{
		name: "goal",
		description: "Toggle goal mode (persistent autonomous objective for this session)",
		bareAction: "distinct",
		subcommands: [
			{ name: "set", description: "Set or replace the goal", usage: "<objective>" },
			{ name: "show", description: "Show current goal details" },
			{ name: "pause", description: "Pause the current goal" },
			{ name: "resume", description: "Resume a paused goal" },
			{ name: "drop", description: "Drop the current goal" },
		],
		inlineHint: "[objective]",
		allowArgs: true,
	},

	{
		name: "guided-goal",
		description: "Interview and refine a goal before enabling goal mode",
		inlineHint: "[rough objective]",
		allowArgs: true,
	},

	{
		name: "loop",
		description:
			"Toggle loop mode. While enabled, the next prompt you send re-submits after every yield. Esc cancels the current iteration; /loop again to disable.",
		inlineHint: "[count|duration] [prompt]",
		allowArgs: true,
	},

	{
		name: "queue",
		description: "Queue a message for after the agent yields",
		inlineHint: "<message>",
		allowArgs: true,
	},

	{
		name: "model",
		textMode: true,
		aliases: ["models"],
		description: "Switch model for this session",
		acpDescription: "Show current model selection",
		allowArgs: true,
	},

	{
		name: "switch",
		description: "Try a model for this session only, without saving it as default (same as alt+p)",
	},

	{
		name: "effort",
		textMode: true,
		aliases: ["thinking"],
		description: "Set the effort for this session (saved defaults live in /settings)",
		acpDescription: "Set thinking effort",
		acpInputHint: "[level]",
		allowArgs: true,
	},

	{
		name: "fast",
		textMode: true,
		description: "Toggle priority service tier (OpenAI service_tier=priority, Anthropic speed=fast)",
		acpDescription: "Toggle fast mode",
		acpInputHint: "[on|off|status]",
		bareAction: "distinct",
		subcommands: [
			{ name: "on", description: `Enable the ${PRIORITY_TIER_LABEL} tier` },
			{ name: "off", description: `Disable the ${PRIORITY_TIER_LABEL} tier` },
			{ name: "status", description: `Show whether the ${PRIORITY_TIER_LABEL} tier is on` },
		],
		allowArgs: true,
	},

	{
		name: "permissions",
		textMode: true,
		aliases: ["approval"],
		description:
			"Set how much the agent may do unasked, for this session only (the saved default lives in /settings)",
		acpDescription: "Set the tool approval mode for this session",
		acpInputHint: "[status|ask|ask-command|auto|yolo|plan|reset]",
		subcommands: [
			{ name: "status", description: "Show the approval rung this session enforces, and where it came from" },
			{ name: "ask", description: "Ask about everything, reads included" },
			{ name: "ask-command", description: "Reads and edits run; anything that executes asks" },
			{ name: "auto", description: "Every tier runs, with the guards still on (the default)" },
			{ name: "yolo", description: "No prompts except blatantly destructive commands" },
			{ name: "plan", description: "Read-only planning" },
			{ name: "reset", description: "Drop the session override and use the saved default" },
		],
		allowArgs: true,
	},

	{
		name: "yolo",
		textMode: true,
		description:
			"Remove this session's permission prompts (a blatantly destructive command, an explicit deny, and plan mode still block)",
		acpDescription: "Toggle full permission bypass",
		acpInputHint: "[on|off|status]",
		bareAction: "distinct",
		subcommands: [
			{ name: "on", description: "Turn full bypass on (needs confirmation in the TUI)" },
			{ name: "off", description: "Turn full bypass off" },
			{ name: "status", description: "Show whether full bypass is on" },
		],
		allowArgs: true,
	},

	{
		name: "cpu-limit",
		textMode: true,
		aliases: ["cpu"],
		description: "Set this session's CPU budget for spawned commands (the saved default lives in /settings)",
		acpDescription: "Set the session CPU budget",
		acpInputHint: "[status|<cores>|remove|reset|kill on|kill off]",
		subcommands: [
			{ name: "status", description: "Show the budget, where it came from, and what it is enforcing" },
			{ name: "remove", description: "Lift the cap for this session, leaving the saved setting alone" },
			{ name: "reset", description: "Drop the session override and use the saved default" },
			{ name: "kill", description: "on|off: kill over-budget commands instead of refusing new ones" },
		],
		allowArgs: true,
	},

	{
		name: "prewalk",
		textMode: true,
		description:
			"Switch to the cheap model at the next action; /prewalk <model> or prewalk.cheapModel picks it (works even without --prewalk)",
		inlineHint: "[model]",
		acpDescription: "Prewalk at the next action",
		allowArgs: true,
	},

	{
		name: "export",
		textMode: true,
		description: "Export session to HTML file",
		inlineHint: "[path]",
		allowArgs: true,
	},

	{
		name: "dump",
		textMode: true,
		description: "Copy session transcript to clipboard (and write LLM request JSON to tmp)",
		acpDescription: "Return full transcript as plain text, with LLM request JSON path",
		allowArgs: true,
	},

	{
		name: "share",
		textMode: true,
		description: "Share session via an encrypted link (share server or secret gist)",
	},
	{
		name: "secret",
		textMode: true,
		description: "Store a credential the agent can use without ever seeing it",
		acpDescription: "Manage credentials; new values are accepted only from environment variables",
		allowArgs: true,
		inlineHint: "add <value> | from-env VAR | list | rm | rename | value | extend | log",
		acpInputHint: "from-env <VAR> <name>",
		bareAction: "distinct",
		subcommands: [
			{
				name: "add",
				description: "Store a credential, prompting for the value with it hidden as you type",
				usage: "/secret add <value>",
			},
			{
				name: "from-env",
				description: "Store the value of an environment variable, typing the credential nowhere",
				usage: "/secret from-env <VAR> <name> [7d] [profile|project|global]",
			},
			{ name: "list", description: "Show active secrets, never their values", usage: "/secret list" },
			{
				name: "rm",
				description: "Remove a stored secret",
				usage: "/secret rm <name> [profile|project|global]",
			},
			{
				name: "clear",
				description: "Remove every secret in one vault, or in all three, naming what it removed",
				usage: "/secret clear profile|project|global|everywhere",
			},
			{
				name: "rename",
				description: "Give a stored secret a different name, keeping its value and lifetime",
				usage: "/secret rename <name> <new-name>",
			},
			{
				name: "value",
				description: "Replace a stored secret's value, keeping its name and deadline",
				usage: "/secret value <name> [from-env <VAR>]",
			},
			{
				name: "scope",
				description: "Move a stored secret to another vault",
				usage: "/secret scope <name> profile|project|global",
			},
			{
				name: "copy",
				description: "Copy #NAME#, the placeholder, never the value",
				usage: "/secret copy <name>",
			},
			{
				name: "extend",
				description: "Give a stored secret a fresh lifetime",
				usage: "/secret extend <name> 7d",
			},
			{
				name: "log",
				description: "Show which secrets were used, in which command, and when",
				usage: "/secret log [<name>] [50]",
			},
			{
				name: "discard",
				description: "Move a vault file aside that could not be read",
				usage: "/secret discard profile|project|global",
			},
			{ name: "help", description: "Show every way to store and manage a credential", usage: "/secret help" },
		],
	},

	{
		name: "collab",
		description: "Share this session live via a relay",
		inlineHint: "[start|view|stop|status] [relayUrl]",
		subcommands: [
			{ name: "start", description: "Start sharing this session", usage: "[relayUrl]" },
			{ name: "view", description: "Share a read-only link (guests can watch, not prompt)" },
			{ name: "status", description: "Show link + participants" },
			{ name: "stop", description: "Stop sharing" },
		],
		allowArgs: true,
	},

	{
		name: "join",
		description: "Join a shared collab session",
		inlineHint: "<link>",
		allowArgs: true,
	},

	{
		name: "leave",
		description: "Leave the collab session",
	},

	{
		name: "browser",
		textMode: true,
		description: "Toggle browser headless vs visible mode",
		acpInputHint: "[headless|visible]",
		bareAction: "distinct",
		subcommands: [
			{ name: "headless", description: "Switch to headless mode" },
			{ name: "visible", description: "Switch to visible mode" },
		],
		allowArgs: true,
	},

	{
		name: "copy",
		description: "Pick text or code from the conversation to copy",
		allowArgs: true,
	},

	{
		name: "todo",
		textMode: true,
		description: "View or modify the agent's todo list",
		acpDescription: "Manage todos",
		acpInputHint: "<subcommand>",
		bareAction: "distinct",
		subcommands: [
			{ name: "edit", description: "Open todos in $EDITOR (Markdown round-trip)" },
			{ name: "copy", description: "Copy todos as Markdown to clipboard" },
			{ name: "export", description: "Write todos as Markdown to a file (default: TODO.md)", usage: "[<path>]" },
			{ name: "import", description: "Replace todos from a Markdown file (default: TODO.md)", usage: "[<path>]" },
			{
				name: "append",
				description: "Append a task; phase fuzzy-matched or auto-created",
				usage: "[<phase>] <task...>",
			},
			{ name: "start", description: "Mark task in_progress (fuzzy-matched)", usage: "<task>" },
			{ name: "done", description: "Mark task/phase/all completed (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "drop", description: "Mark task/phase/all abandoned (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "rm", description: "Remove task/phase/all (fuzzy-matched)", usage: "[<task|phase>]" },
		],
		allowArgs: true,
	},

	{
		name: "session",
		textMode: true,
		description: "Session management commands",
		acpDescription: "Show session information",
		acpInputHint: "info|delete",
		subcommands: [
			{ name: "info", description: "Show session info and stats" },
			{ name: "delete", description: "Delete current session and return to selector" },
		],
		allowArgs: true,
	},

	{
		name: "jobs",
		textMode: true,
		description: "Show async background jobs status",
		acpDescription: "Show background jobs",
	},

	{
		name: "usage",
		textMode: true,
		description: "Show provider usage and limits",
		acpDescription: "Show token usage",
		acpInputHint: "[show|reset [account|active]]",
		subcommands: [
			{ name: "show", description: "Show provider usage and limits" },
			{ name: "reset", description: "Spend a saved Codex rate-limit reset", usage: "[account|active]" },
		],
		allowArgs: true,
	},

	{
		name: "changelog",
		textMode: true,
		description: "Open the release notes on the web",
		acpDescription: "Open the release notes on the web",
	},

	{
		name: "hotkeys",
		description: "Show all keyboard shortcuts",
	},

	{
		name: "tools",
		textMode: true,
		description: "Show tools currently visible to the agent",
		acpDescription: "Show available tools",
	},

	{
		name: "context",
		textMode: true,
		description: "Show estimated context usage breakdown",
		acpDescription: "Show context usage",
	},

	{
		name: "extensions",
		aliases: ["status"],
		description: "Open Extension Control Center dashboard",
	},

	{
		name: "agents",
		aliases: ["cockpit", "hub"],
		description: "Agent Control Center: live agent roster and comms stream",
	},
	{
		name: "process-manager",
		description: "Agent Control Center across every conversation this process is running",
	},

	{
		name: "branch",
		description: "Create a new branch from a previous message",
	},

	{
		name: "fork",
		description: "Duplicate the entire current session into a new file",
	},

	{
		name: "tree",
		description: "Navigate session tree (switch branches)",
	},

	{
		name: "login",
		description: "Log in and add an account for a provider (alias of /account login)",
		inlineHint: "[provider|redirect URL]",
		allowArgs: true,
	},

	{
		name: "logout",
		description: "Logout from OAuth provider",
		inlineHint: "[provider]",
		allowArgs: true,
	},

	{
		name: "mcp",
		textMode: true,
		description: "Manage MCP servers (add, list, remove, test)",
		acpDescription: "Manage MCP servers",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add a new MCP server",
				usage: "<name> [http|sse] [url <url>] [token <token>] [run <command...>]",
			},
			{ name: "list", description: "List all configured MCP servers" },
			{ name: "remove", description: "Remove an MCP server", usage: "<name>" },
			{ name: "test", description: "Test connection to a server", usage: "<name>" },
			{ name: "reauth", description: "Reauthorize OAuth for a server", usage: "<name>" },
			{ name: "unauth", description: "Remove OAuth auth from a server", usage: "<name>" },
			{ name: "enable", description: "Enable an MCP server", usage: "<name>" },
			{ name: "disable", description: "Disable an MCP server", usage: "<name>" },
			{
				name: "smithery-search",
				description: "Search Smithery registry and deploy an MCP server",
				usage: "<keyword...> [<limit 1-100>] [semantic]",
			},
			{ name: "smithery-login", description: "Login to Smithery and cache API key" },
			{ name: "smithery-logout", description: "Remove cached Smithery API key" },
			{ name: "reconnect", description: "Reconnect to a specific MCP server", usage: "<name>" },
			{ name: "reload", description: "Force reload MCP runtime tools" },
			{ name: "resources", description: "List available resources from connected servers" },
			{ name: "prompts", description: "List available prompts from connected servers" },
			{ name: "notifications", description: "Show notification capabilities and subscriptions" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
	},

	{
		name: "ssh",
		textMode: true,
		description: "Manage SSH hosts (add, list, remove)",
		acpDescription: "Manage SSH connections",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add an SSH host",
				usage: "<name> <host> [user <user>] [<port>] [key <keyPath>]",
			},
			{ name: "list", description: "List all configured SSH hosts" },
			{ name: "remove", description: "Remove an SSH host", usage: "<name>" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
	},

	{
		name: "stats",
		textMode: true,
		description: "Open the usage dashboard in a browser",
		acpDescription: "Open the usage statistics dashboard",
		inlineHint: "[<port>]",
		allowArgs: true,
	},

	{
		name: "new",
		description: "Start a new session",
	},

	{
		name: "fresh",
		textMode: true,
		description: "Reset provider stream state without changing the local transcript",
	},

	{
		name: "drop",
		description: "Delete the current session and start a new one",
	},

	{
		name: "compact",
		textMode: true,
		description: "Summarize session context in place",
		acpDescription: "Summarize the conversation in place",
		bareAction: "distinct",
		subcommands: COMPACT_MODES.map(mode => ({
			name: mode.name,
			description: mode.description,
			usage: "[focus]",
		})),
		acpInputHint: "[summary] [focus]",
		allowArgs: true,
	},

	{
		name: "shake",
		textMode: true,
		description: "Drop heavy content from context (tool results, large blocks)",
		acpDescription: "Shake heavy content out of the conversation context",
		subcommands: [
			{ name: "elide", description: "Strip tool results + large blocks (default)" },
			{ name: "images", description: "Strip image blocks" },
		],
		acpInputHint: "[elide|images]",
		allowArgs: true,
	},

	{
		name: "handoff",
		textMode: true,
		description: "Hand off session context to a new session",
		acpDescription: "Generate a handoff document and continue in a new session",
		inlineHint: "[focus instructions]",
		acpInputHint: "[focus instructions]",
		allowArgs: true,
	},

	{
		name: "resume",
		description: "Resume a different session",
		inlineHint: "[session id]",
		allowArgs: true,
	},

	{
		name: "btw",
		description: "Ask an ephemeral side question using the current session context",
		inlineHint: "<question>",
		allowArgs: true,
	},

	{
		name: "tan",
		description: "Run a full background agent on tangential work",
		inlineHint: "<work>",
		allowArgs: true,
	},

	{
		name: "omfg",
		description: "Forge a TTSR rule from a complaint to stop a recurring behavior",
		inlineHint: "<complaint>",
		allowArgs: true,
	},

	{
		name: "retry",
		description: "Retry the last failed agent turn",
	},

	{
		name: "debug",
		description: "Open debug tools selector",
	},

	{
		name: "memory",
		textMode: true,
		description: "Inspect and operate memory maintenance",
		acpDescription: "Manage memory",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "view", description: "Show current memory injection payload" },
			{ name: "stats", description: "Show memory backend statistics" },
			{ name: "diagnose", description: "Run memory backend diagnostics" },
			{ name: "clear", description: "Clear persisted memory data and artifacts" },
			{ name: "reset", description: "Alias for clear" },
			{ name: "enqueue", description: "Enqueue memory consolidation maintenance" },
			{ name: "rebuild", description: "Alias for enqueue" },
			{ name: "mm list", description: "List mental models on the active bank" },
			{ name: "mm show", description: "Show one mental model (id required)" },
			{
				name: "mm refresh",
				description: "Refresh auto-refresh models bank-wide, or one model by id",
			},
			{ name: "mm history", description: "Diff the change history of a mental model" },
			{ name: "mm seed", description: "Create any built-in mental models that are missing" },
			{ name: "mm delete", description: "Delete a mental model from the bank (id required)" },
			{ name: "mm reload", description: "Re-pull the cached <mental_models> block" },
		],
		allowArgs: true,
	},

	{
		name: "rename",
		textMode: true,
		description: "Rename the current session",
		inlineHint: "<title>",
		allowArgs: true,
	},

	{
		name: "move",
		textMode: true,
		description: "Move the current session to a different directory",
		acpDescription: "Move the current session to a different directory",
		inlineHint: "[<path>]",
		allowArgs: true,
	},

	{
		name: "cwd",
		textMode: true,
		description: "Show or set the session working directory (session-scoped; does not write profile settings)",
		acpDescription: "Show or set the session working directory",
		inlineHint: "[<path>]",
		allowArgs: true,
	},

	{
		name: "exit",
		description: "Exit the application",
	},

	{
		name: "profile",
		aliases: ["profiles"],
		description:
			"Open the profile picker, or /profile <name> to switch, /profile <name> rename to <new>, /profile new <name>, /profile rm <name>",
		allowArgs: true,
	},

	{
		name: "plugins",
		textMode: true,
		description: "View installed npm/link plugins",
		acpDescription: "Manage plugins",
		acpInputHint: "[list]",
		bareAction: "distinct",
		subcommands: [{ name: "list", description: "List installed npm/link plugins" }],
		allowArgs: true,
	},

	{
		name: "reload-plugins",
		textMode: true,
		description: "Reload all plugins (skills, commands, hooks, tools, agents, MCP)",
		acpDescription: "Reload all plugins",
	},

	{
		name: "trust",
		textMode: true,
		description: "Decide whether the code this project carries may run (plugins, extensions, hooks, MCP)",
		acpDescription: "Decide whether project code may run",
		acpInputHint: "[approve|deny|forget]",
		subcommands: [
			{ name: "approve", description: "Approve the project files exactly as they are now" },
			{ name: "deny", description: "Refuse this project, and remember the refusal" },
			{ name: "forget", description: "Drop the decision so it is asked again" },
		],
		allowArgs: true,
	},

	{
		name: "force",
		textMode: true,
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
	},

	{
		name: "advisor",
		textMode: true,
		description: "Show, configure, start or stop the advisor that reviews this session",
		acpDescription: "Inspect and configure the advisor",
		acpInputHint: "[status|configure|on|off|dump]",
		allowArgs: true,
		subcommands: [
			{ name: "status", description: "Show whether the advisor is running, on what model, and what it has spent" },
			{ name: "configure", description: "Edit the WATCHDOG.yml advisor roster and apply it to this session" },
			{ name: "on", description: "Start the advisor for this session" },
			{ name: "off", description: "Stop the advisor for this session" },
			{ name: "dump", description: "Copy the advisor's own transcript to the clipboard" },
		],
	},

	{
		name: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
	},

	{
		name: "quit",
		description: "Quit the application",
	},
] as const satisfies readonly BuiltinSlashCommandDeclaration[];

export type BuiltinSlashCommandName = (typeof BUILTIN_SLASH_COMMAND_DECLARATIONS)[number]["name"];

export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: ReadonlySet<string> = new Set(
	BUILTIN_SLASH_COMMAND_DECLARATIONS.flatMap((command: BuiltinSlashCommandDeclaration) => [
		command.name,
		...(command.aliases ?? []),
	]),
);
