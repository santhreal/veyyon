/**
 * Every builtin slash command's NAME, description and argument shape, with no handler in sight.
 *
 * WHY THIS FILE EXISTS. `builtin-registry.ts` used to hold both halves in one array of 67 objects:
 * the metadata AND the handler body, and a handler body reaches the whole application. Two modules
 * want only the metadata and paid for all of it:
 *
 *   - `extensibility/extensions/get-commands-handler.ts` imports `BUILTIN_SLASH_COMMAND_RESERVED_NAMES`
 *     and nothing else, to refuse an extension that would shadow a builtin. That one import measured
 *     770 modules of marginal cost, and it propagated: `modes/runtime-init.ts` paid 870 for the
 *     handler and `modes/print-mode.ts` 823 for runtime-init.
 *   - `slash-commands/acp-builtins.ts` builds the ACP command list from the same array, 856 marginal.
 *
 * WHY IT IS NOT A SECOND LIST. The names are declared HERE, once. `builtin-registry.ts` imports this
 * array and attaches handlers to it by name, through a `Record` keyed by the declared names, so a
 * handler for a command that does not exist and a command with no handler are both compile errors.
 * There is no list to keep in sync, and no test standing in for a type.
 *
 * WHAT BELONGS HERE. Data only: name, aliases, description, whether the command takes arguments, the
 * inline hint, the ACP description and input hint, and the subcommand table. Anything that runs, or
 * that reads runtime state to decide what to say, is a handler and belongs in the registry.
 *
 * The two runtime imports are both leaves that reach ONE module each, and both are values this file
 * must not restate: the priority-tier LABEL, which several surfaces print and which has one owner, and
 * the compaction mode table, which `/compact` advertises as subcommands and the parser reads back. A
 * third import that pulled in anything larger would undo the split, so weigh one before adding it.
 */

import { PRIORITY_TIER_LABEL } from "../config/service-tier";
import { COMPACT_MODES } from "../session/compact-modes";

/** One command's declared surface. The handler side is `SlashCommandSpec` in the registry. */
export interface BuiltinSlashCommandDeclaration {
	readonly name: string;
	readonly description: string;
	/**
	 * Whether this command can be driven from TEXT mode, meaning ACP and RPC clients and not only the
	 * TUI. It is declared rather than discovered, and the registry's handler table is typed against it:
	 * a command with `textMode: true` MUST supply `handle`, and a command without it must NOT. Both
	 * mistakes are compile errors, so this is one fact with one owner rather than a flag mirroring a
	 * runtime property.
	 *
	 * WHY IT IS DECLARED. Three consumers ask only "which commands can a text client drive": the ACP
	 * advertisement, the reserved-name set that stops an extension shadowing a builtin, and the
	 * available-commands list. Each used to answer it with `command.handle !== undefined`, which meant
	 * loading all 67 handler bodies, and a handler body reaches the whole application. Asking the
	 * declaration instead costs three modules.
	 */
	readonly textMode?: true;
	readonly aliases?: readonly string[];
	readonly allowArgs?: boolean;
	readonly inlineHint?: string;
	readonly acpDescription?: string;
	readonly acpInputHint?: string;
	/**
	 * What a BARE `/cmd` does when the command also declares `subcommands`.
	 *
	 * `"picker"` (the default) opens a modal list of the subcommands. `"distinct"` runs the command's
	 * own bare behavior, and is a claim you have to earn: bare invocation must do something that is
	 * NOT one of the declared subcommands (a switch, a wizard, a view), or the declared list must
	 * hold nothing the bare form already does.
	 *
	 * The default is the safe one, so a new command that says nothing gets the picker rather than a
	 * hidden default nobody noticed. `test/slash-commands/bare-command-opens-a-picker.test.ts`
	 * enforces the pair: bare opens the picker, or the declaration says `"distinct"`.
	 *
	 * The value is `"distinct"` rather than `"toggle"` because only three of the commands claiming
	 * it are switches. `/todo` renders a list, `/setup` opens a wizard, `/secret` opens a field. All
	 * of them share the one property that matters, which is that bare does something DISTINCT from
	 * every subcommand, and naming it after the rarer case invites the next author to file a hidden
	 * default under a word that does not fit and have nobody notice.
	 *
	 * A `"distinct"` granted because the subcommand list is a synonym of the bare form stops being
	 * true the moment someone adds a second subcommand. Each one carries a comment saying what bare
	 * does; re-read it when you extend the list.
	 */
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
		// `help` must resolve to SOMETHING: it's the first command a new user
		// types, and the welcome screen is the orientation hub (actions, recent
		// sessions, tips). Without it the palette fuzzy-matched random skills.
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
		// Bare /setup opens provider setup, which is what `providers` does. It is the only
		// subcommand, so the list hides nothing. Adding a second one makes this a picker.
		bareAction: "distinct",
		subcommands: [{ name: "providers", description: "Configure sign-in and web search providers" }],
	},

	// `/providers` is its own command, NOT an alias of `/setup`. It used to be one, so typing it
	// opened the onboarding wizard's provider scene: one row per provider with a bare "logged in"
	// tag, no account identity, and no way to see which of several stored credentials the session
	// was actually spending. The account manager is the answer to that question, so the name a
	// user reaches for now leads there and `/setup` keeps the wizard.
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
		// Bare /goal enters goal mode (asks for an objective) or opens the goal menu when one is
		// running. Neither is any of the subcommands below.
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
		// Static fallback only: the advertised hint is derived per session from
		// the active model's accepted levels (available-commands.ts).
		acpInputHint: "[level]",
		allowArgs: true,
	},

	{
		name: "fast",
		textMode: true,
		description: "Toggle priority service tier (OpenAI service_tier=priority, Anthropic speed=fast)",
		acpDescription: "Toggle fast mode",
		acpInputHint: "[on|off|status]",
		// Bare /fast flips the tier. A menu in front of a switch costs a keystroke on the common act.
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
			// The handler always accepted `status`, and the bare form was it. Now that bare opens the
			// picker, the verb has to be declared or the enforced-rung report becomes unreachable.
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
		// Bare /yolo flips the bypass, behind a danger confirmation in the TUI.
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
		description: "Switch to a fast/cheap model at the next action (works even without --prewalk)",
		acpDescription: "Prewalk at the next action",
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
		// A command comes first, and `add` leads because it is the one an operator arrives to run. The
		// rest of the grammar is in the dropdown rather than the ghost text: one line cannot carry
		// twelve commands.
		inlineHint: "add <value> | add --from-env VAR | list | rm | rename | value | extend | log",
		acpInputHint: "add <name> --from-env <VAR>",
		// Bare /secret prints this command's own usage rather than the generic subcommand list, which
		// is the same text `/secret help` prints and is not a hidden default: it runs no subcommand and
		// stores nothing. The generic list cannot stand in for it, because a `SubcommandDef.usage` is
		// one string for every surface and `add`'s shape is not — a terminal is shown `add <value>`
		// and a client `add <name> --from-env <VAR>`. Printing the declaration's spelling in a terminal
		// would advertise typing a NAME where the value goes, which is the exposure this feature exists
		// to remove.
		bareAction: "distinct",
		subcommands: [
			{
				name: "add",
				description: "Store a credential, prompting for the value with it hidden as you type",
				usage: "/secret add <name> [--from-env <VAR>] [--ttl 7d] [--scope profile|project|global]",
			},
			{ name: "list", description: "Show active secrets, never their values", usage: "/secret list" },
			{
				name: "rm",
				description: "Remove a stored secret",
				usage: "/secret rm <name> [--scope profile|project|global]",
			},
			{
				name: "clear",
				description: "Remove every secret in one vault, naming what it removed",
				usage: "/secret clear --scope profile|project|global",
			},
			{
				name: "rename",
				description: "Give a stored secret a different name, keeping its value and lifetime",
				usage: "/secret rename <name> <new-name>",
			},
			{
				name: "value",
				description: "Replace a stored secret's value, keeping its name and deadline",
				usage: "/secret value <name> [--from-env <VAR>]",
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
				usage: "/secret extend <name> --ttl 7d",
			},
			{
				name: "log",
				description: "Show which secrets were used, in which command, and when",
				usage: "/secret log [--name <name>] [--limit 50]",
			},
			{
				name: "discard",
				description: "Move a vault file aside that could not be read",
				usage: "/secret discard --scope profile|project|global",
			},
			{ name: "help", description: "Show every way to store and manage a credential", usage: "/secret help" },
		],
	},

	{
		name: "collab",
		description: "Share this session live via a relay",
		inlineHint: "[start|view|stop|status] [relayUrl]",
		subcommands: [
			// `start` is declared because bare /collab does it. Leaving it out did not make the
			// bare form innocent, it made the declaration untrue.
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
		// Bare /browser flips headless vs visible.
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
		// Bare /todo renders the current list. Every subcommand below mutates or exports it, so
		// none of them is what bare does.
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
		// `/cockpit` and `/hub` are ALIASES, not commands of their own. They opened a
		// separate "Agent Hub" overlay that rendered the same registry a second way,
		// so "which agents are running" had two answers that could disagree. One
		// command, one description, one screen.
		name: "agents",
		aliases: ["cockpit", "hub"],
		description: "Agent Control Center: live agent roster and comms stream",
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

	// `/login` is a permanent alias of `/account login`: both spellings reach ONE handler, so the
	// paste path (`/login <redirect URL>`) and the provider path behave identically whichever is
	// typed. Accounts have one surface now, and the alias exists because it is what a decade of
	// other tools taught people to type.
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
				usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]",
			},
			{ name: "list", description: "List all configured MCP servers" },
			{ name: "remove", description: "Remove an MCP server", usage: "<name> [--scope project|user]" },
			{ name: "test", description: "Test connection to a server", usage: "<name>" },
			{ name: "reauth", description: "Reauthorize OAuth for a server", usage: "<name>" },
			{ name: "unauth", description: "Remove OAuth auth from a server", usage: "<name>" },
			{ name: "enable", description: "Enable an MCP server", usage: "<name>" },
			{ name: "disable", description: "Disable an MCP server", usage: "<name>" },
			{
				name: "smithery-search",
				description: "Search Smithery registry and deploy an MCP server",
				usage: "<keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
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
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>]",
			},
			{ name: "list", description: "List all configured SSH hosts" },
			{ name: "remove", description: "Remove an SSH host", usage: "<name> [--scope project|user]" },
			{ name: "help", description: "Show help message" },
		],
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
		// Bare /compact compacts. COMPACT_MODES holds exactly one mode, and it is the bare
		// behavior, so the list hides nothing. A second mode makes this a picker.
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
		// TEXT MODE, because the operation needs no terminal. `AgentSession.handoff` generates the
		// document with a oneshot request and swaps the session manager onto a new transcript, and
		// the RPC surface has always driven exactly that (`rpc-mode.ts`, command "handoff"). Only the
		// spinner and the transcript repaint were TUI-bound. Leaving it TUI-only meant `/compact
		// handoff` refused an ACP client by naming `/handoff`, a command that client could not reach.
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
		// Bare /plugins lists plugins, which is what `list` does. It is the only subcommand.
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
		name: "force",
		textMode: true,
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
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

/** The name of every builtin command, as a union, so a handler table cannot miss one or invent one. */
export type BuiltinSlashCommandName = (typeof BUILTIN_SLASH_COMMAND_DECLARATIONS)[number]["name"];

/**
 * Every name a builtin answers to, aliases included.
 *
 * Used by the extension loader to refuse a command that would shadow a builtin. It is derived from
 * the declarations rather than written out, so a new command reserves its own name by existing.
 */
export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: ReadonlySet<string> = new Set(
	BUILTIN_SLASH_COMMAND_DECLARATIONS.flatMap((command: BuiltinSlashCommandDeclaration) => [
		command.name,
		...(command.aliases ?? []),
	]),
);
