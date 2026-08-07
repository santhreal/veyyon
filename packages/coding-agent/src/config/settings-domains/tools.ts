/** Tools domain slice of SETTINGS_SCHEMA — composed in ../settings-schema.ts. */
import { DEFAULT_APPROVAL_MODE } from "../../tools/approval-modes";
import { DEFAULT_INLINE_FLOOR_FRACTION } from "./shared";

export const TOOLS_SETTINGS = {
	// ────────────────────────────────────────────────────────────────────────
	// Tools
	// ────────────────────────────────────────────────────────────────────────

	// Tool approval policies
	"tools.approval": {
		type: "record",
		default: {},
		ui: {
			tab: "interaction",
			group: "Approvals",
			label: "Tool Approval Policies",
			description:
				"Per-tool approval policies. Set to 'allow' to auto-approve, 'prompt' to require confirmation, or 'deny' to block. Overrides are honored in every approval mode.",
		},
	},

	// Extra paths the destructive-command guard refuses to delete recursively.
	//
	// ADDITIONS ONLY, BY CONSTRUCTION. The compiled set in src/tools/bash-guard.ts
	// (the home directory, the system roots, the credential directories) is not
	// reachable from config in any direction, so this setting can make the guard
	// stricter and can never make it weaker. A setting that could shrink a safety
	// floor is a setting an agent can be talked into editing.
	"tools.protectedPaths": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "interaction",
			group: "Approvals",
			label: "Extra Protected Paths",
			description:
				"Additional absolute paths (a leading ~ is expanded) that a recursive delete must never target without approval. Adds to the built-in set; it cannot remove from it.",
		},
	},

	// Default tool approval mode (interaction tab, but governs the tool wrapper).
	// The rungs and what each one still stops for live in
	// `src/tools/approval-modes.ts`; `normalizeApprovalMode` maps the legacy
	// names ("always-ask" = ask, "write"/"auto-edit" = ask-command), which stay
	// accepted from stored configs and the CLI but are not offered in the UI.
	"tools.approvalMode": {
		type: "enum",
		values: ["plan", "ask", "ask-command", "auto", "yolo", "always-ask", "write", "auto-edit"] as const,
		// `DEFAULT_APPROVAL_MODE` is the single place the unset default is
		// decided; `normalizeApprovalMode`, `resolveEffectiveApprovalMode` and the
		// tool wrapper all read the same constant rather than spelling a fallback
		// of their own. It is `auto`: every tier runs out of the box, but the
		// guards stay on, so per-tool policies, the working-directory boundary,
		// credential use, and a tool's own critical calls still stop and ask. An
		// operator who wants a stricter or looser rung says so once, in
		// onboarding, in `/settings`, or per session with `/permissions`, and the
		// status line then says which of those is in force.
		default: DEFAULT_APPROVAL_MODE,
		ui: {
			tab: "interaction",
			group: "Approvals",
			label: "Tool Approval",
			description:
				"How much the agent may do without asking. Defaults to Auto: every tier runs, with the per-tool policies, working-directory boundary, credential and critical-call guards still asking. This is the persisted default; override it for one session with /permissions.",
			options: [
				{
					value: "ask",
					label: "Ask everything",
					description: "Every tool call asks first, reads included.",
				},
				{
					value: "ask-command",
					label: "Ask commands only",
					description:
						"Reads and workspace edits run unasked; anything that executes (bash, eval, browser, task, ssh) asks.",
				},
				{
					value: "auto",
					label: "Auto",
					description:
						"Every tier runs unasked, with the guards on: per-tool policies, the working-directory boundary, credential use, and a tool's own critical calls still ask.",
				},
				{
					value: "yolo",
					label: "Yolo",
					description:
						"No prompts. Only blatantly destructive commands (rm -rf / and its expansions) and an explicit deny policy still stop a call.",
				},
				{
					value: "plan",
					label: "Plan",
					description:
						"Read-only planning: reads run, writes ask only inside an active plan-mode session, execution is blocked.",
				},
			],
		},
	},

	// Todo tool
	"todo.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Todos",
			description: "Enable the todo tool for task tracking",
		},
	},

	"todo.reminders": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Todos",
			label: "Todo Reminders",
			description: "Prompt continued execution when unfinished todos remain",
		},
	},

	"todo.reminders.max": {
		type: "number",
		default: 3,
		ui: {
			tab: "tools",
			group: "Todos",
			label: "Todo Reminder Limit",
			description: "Maximum distinct todo-state reminders before reminders stay silent",
			options: [
				{ value: "1", label: "1 reminder" },
				{ value: "2", label: "2 reminders" },
				{ value: "3", label: "3 reminders" },
				{ value: "5", label: "5 reminders" },
			],
		},
	},

	"todo.eager": {
		type: "enum",
		values: ["default", "preferred", "always"] as const,
		default: "default",
		ui: {
			tab: "tools",
			group: "Todos",
			label: "Create Todos Automatically",
			description: "How strongly to push automatic todo-list creation after the first message",
			options: [
				{ value: "default", label: "Default", description: "Model decides; no automatic todo list" },
				{
					value: "preferred",
					label: "Preferred",
					description: "Suggests a todo list on the first message (reminder, not forced)",
				},
				{ value: "always", label: "Always", description: "Forces a comprehensive todo list on the first message" },
			],
		},
	},

	// Grep, glob, and AST tools
	"glob.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Glob",
			description: "Enable the glob tool for glob-based file lookup",
		},
	},

	"grep.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Grep",
			description: "Enable the grep tool for regex content search",
		},
	},

	// How tightly an early tool result is held before it spills to an artifact.
	//
	// A tool result is billed once as fresh input and then re-read as a cache
	// token on every later turn, so the same bytes cost far more arriving at turn
	// 3 than at turn 55. `inlineCapForTurn` scales the inline budget by the
	// remaining re-reads, but that curve is steep enough that this floor is what
	// actually binds for most of a session: the scaled value sits under it until
	// roughly four turns from the horizon. The floor is therefore the parameter,
	// and it is a setting rather than a constant so it can be measured on the
	// bench instead of chosen by taste.
	//
	// 1 disables the scaling: the floor becomes the full budget, so every result
	// gets the flat cap regardless of when it arrives. That is the control arm.
	"tools.inlineOutputFloor": {
		type: "number",
		default: DEFAULT_INLINE_FLOOR_FRACTION,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Inline Output Floor",
			description:
				"Smallest share of the inline output budget an early tool result may use before the rest spills to an artifact. A result that arrives early is re-read on every later turn, so it is charged more tightly than one that arrives near the end. Lower spills sooner and costs fewer context tokens; 1 keeps the flat cap and never spills early. This governs every tool that streams output, including eval, bash, ssh and the interactive shell, as well as grep and the browser.",
			options: [
				{ value: "1", label: "Flat cap (no early spill)" },
				{ value: "0.5", label: "Half budget" },
				{ value: "0.25", label: "Quarter budget" },
				{ value: "0.1", label: "Tenth budget" },
			],
			advanced: true,
		},
	},

	"grep.contextBefore": {
		type: "number",
		default: 1,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "Grep Context Before",
			description: "Lines of context before each grep match",
			options: [
				{ value: "0", label: "0 lines" },
				{ value: "1", label: "1 line" },
				{ value: "2", label: "2 lines" },
				{ value: "3", label: "3 lines" },
				{ value: "5", label: "5 lines" },
			],
		},
	},

	"grep.contextAfter": {
		type: "number",
		default: 3,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "Grep Context After",
			description: "Lines of context after each grep match",
			options: [
				{ value: "0", label: "0 lines" },
				{ value: "1", label: "1 line" },
				{ value: "2", label: "2 lines" },
				{ value: "3", label: "3 lines" },
				{ value: "5", label: "5 lines" },
				{ value: "10", label: "10 lines" },
			],
		},
	},

	"astGrep.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "AST Grep",
			description: "Enable the ast_grep tool for structural AST search",
		},
	},

	"astEdit.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "AST Edit",
			description: "Enable the ast_edit tool for structural AST rewrites",
		},
	},

	// Optional tools

	"debug.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Debug",
			description: "Enable the debug tool for DAP-based debugging",
		},
	},

	"launch.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Launch",
			description: "Enable the launch tool for supervising shared long-running project processes",
		},
	},

	"speechgen.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Speech Generation",
			description: "Enable the tts tool for on-device (Kokoro) or xAI Grok Voice speech-file synthesis",
		},
	},
	"generate_image.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Generate Image",
			description: "Enable the generate_image tool for text-to-image generation and editing",
		},
	},

	"inspect_image.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Inspect Image",
			description: "Enable the inspect_image tool, delegating image understanding to a vision-capable model",
		},
	},

	"checkpoint.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Checkpoint/Rewind",
			description: "Enable the checkpoint and rewind tools for context checkpointing",
		},
	},

	// Fetching and browser
	"fetch.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Read URLs",
			description: "Allow the read tool to fetch and process URLs",
		},
	},

	"vault.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Obsidian Vault",
			description:
				"Enable the vault:// internal URL for reading and editing Obsidian vault content via the Obsidian CLI. When disabled, vault:// resolution is refused and the vault:// entry is omitted from the system prompt.",
		},
	},

	"github.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "GitHub CLI",
			description:
				"Enable the github tool (op-based dispatch for repository, issue, pull request, diff, search, checkout, push, and Actions watch workflows)",
		},
	},

	"github.cache.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "GitHub",
			label: "GitHub View Cache",
			description:
				"Cache rendered issue/PR view output in the active profile's `cache/github-cache.db` so repeated reads are free",
		},
	},

	"github.cache.softTtlSec": {
		type: "number",
		default: 300,
		ui: {
			min: 0, // a TTL cannot be negative
			tab: "tools",
			group: "GitHub",
			label: "GitHub Cache Soft TTL",
			description:
				"Within this window, cached issue/PR view rows are returned directly (seconds; default 5 minutes)",
		},
	},

	"github.cache.hardTtlSec": {
		type: "number",
		default: 604800,
		ui: {
			min: 0, // a TTL cannot be negative
			tab: "tools",
			group: "GitHub",
			label: "GitHub Cache Hard TTL",
			description:
				"Past the soft TTL the cached row is returned and refreshed in the background; past the hard TTL it is dropped (seconds; default 7 days)",
		},
	},

	"web_search.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Web Search",
			description: "Enable the web_search tool for live web results",
		},
	},

	"ask.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Ask",
			description: "Enable the ask tool for interactive user questions",
		},
	},

	"browser.enabled": {
		type: "boolean",
		// Off: it spawns Chromium, and most sessions never touch a page. A tool that ships
		// on is paid for on every request in the tool array, which Anthropic caches ahead
		// of the system prompt, so an unused one is rent on every turn of every session.
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Browser",
			description: "Enable the browser tool for scripted Chromium automation (puppeteer)",
		},
	},

	"browser.headless": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "Headless Browser",
			description: "Launch browser in headless mode (disable to show browser UI)",
		},
	},

	"browser.cmux": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "cmux Browser",
			description:
				"Use cmux WKWebView surfaces for browser automation when a cmux socket is available. Set VEYYON_BROWSER_CMUX=0 or VEYYON_BROWSER_CMUX=1 to override.",
		},
	},
	"browser.screenshotDir": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "Screenshot Directory",
			description:
				"Directory to save screenshots. If unset, screenshots go to a temp file. Supports ~. Examples: ~/Downloads, ~/Desktop, /sdcard/Download (Android)",
		},
	},

	// Tool execution
	"tools.intentTracing": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Intent Tracing",
			description: "Ask the agent to describe the intent of each tool call before executing it",
		},
	},
	"tools.abortOnFabricatedResult": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Abort On Fabricated Tool Result",
			description:
				"With in-band tool calls, stop the model immediately when it starts hallucinating a tool result mid-turn. Disable to let the model finish generating and discard the fabricated continuation instead.",
		},
	},

	"tools.maxTimeout": {
		type: "number",
		default: 0,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Max Tool Timeout",
			description: "Maximum timeout in seconds the agent can set for any tool (0 = no limit)",
			options: [
				{ value: "0", label: "No limit" },
				{ value: "30", label: "30 seconds" },
				{ value: "60", label: "60 seconds" },
				{ value: "120", label: "120 seconds" },
				{ value: "300", label: "5 minutes" },
				{ value: "600", label: "10 minutes" },
			],
		},
	},

	// Async jobs
	"async.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Async Execution",
			description: "Enable async bash commands and background task execution",
		},
	},

	"async.maxJobs": {
		type: "number",
		default: 100,
	},

	"async.pollWaitDuration": {
		type: "enum",
		values: ["5s", "10s", "30s", "1m", "5m", "smart"] as const,
		default: "smart",
		ui: {
			tab: "tools",
			group: "Execution",
			label: "Max Poll Time",
			description:
				"How long the poll tool waits for background job updates before returning the current state. A fixed value waits that exact duration every time. `smart` adapts: it starts at 30s and climbs to 4m on a back-to-back poll, then resets to 30s after about a minute without polling. The 4m ceiling stays below the 5-minute prompt-cache boundary.",
			options: [
				{ value: "5s", label: "5 seconds" },
				{ value: "10s", label: "10 seconds" },
				{ value: "30s", label: "30 seconds" },
				{ value: "1m", label: "1 minute" },
				{ value: "5m", label: "5 minutes" },
				{
					value: "smart",
					label: "Smart",
					description: "Default: adaptive 30s to 4m, resets when you stop polling",
				},
			],
		},
	},

	"irc.timeoutMs": {
		type: "number",
		default: 120_000,
		ui: {
			tab: "subagents",
			group: "Coordination",
			label: "IRC Timeout",
			description:
				"Default timeout for irc wait (and send await:true) in milliseconds; 0 disables the timeout. IRC is how a parent and its subagents talk, which is why it is configured here.",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "30000", label: "30 seconds" },
				{ value: "60000", label: "1 minute" },
				{ value: "120000", label: "2 minutes" },
				{ value: "300000", label: "5 minutes" },
			],
		},
	},

	"bash.autoBackground.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Bash Auto-Background",
			description:
				"Move a long-running bash command to a background job on its own and deliver the result when it lands, instead of holding the turn open. Off, a command holds the foreground until it finishes or times out. Either way you can background the running command yourself with the composer's background key.",
		},
	},

	"bash.autoBackground.thresholdMs": {
		type: "number",
		default: 300_000,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Auto-Background After",
			description:
				"Max wall-clock time a bash call runs in the foreground before it is moved to a background job (result delivered later). Frees the model to keep working and protects the prompt cache, which a long foreground command would otherwise blow past. Fires on elapsed time even while output is streaming. 0 backgrounds immediately.",
			options: [
				{ value: "0", label: "Immediately" },
				{ value: "30000", label: "30 seconds" },
				{ value: "60000", label: "1 minute" },
				{ value: "120000", label: "2 minutes" },
				{ value: "300000", label: "5 minutes" },
			],
			condition: "bashAutoBackgroundEnabled",
		},
	},

	"bash.stallDetection.stallMs": {
		type: "number",
		default: 30_000,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Stall After",
			description:
				"When stall detection is on, how long a bash call may produce no new output before it is treated as possibly stuck, backgrounded, and flagged so the model can cancel it if it is truly hung. Measures idle time (quiet output), not total run time.",
			options: [
				{ value: "15000", label: "15 seconds" },
				{ value: "30000", label: "30 seconds" },
				{ value: "60000", label: "1 minute" },
				{ value: "120000", label: "2 minutes" },
			],
			condition: "bashStallDetectionEnabled",
		},
	},

	// Tool Discovery
	"tools.discoveryMode": {
		type: "enum",
		values: ["auto", "off", "mcp-only", "all"] as const,
		default: "auto",
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "Tool Discovery",
			description:
				"Hide tools behind a search tool to save tokens. 'auto' hides MCP tools once the tool set has more than 40 tools; 'mcp-only' always hides MCP tools; 'all' also hides non-essential built-ins and first-party heavyweight tools such as generate_image.",
		},
	},

	"tools.essentialOverride": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "Essential Tools Override",
			description:
				"Override the always-loaded built-in tools (default: read, bash, launch, edit, write, glob, eval). Leave empty to use defaults.",
		},
	},

	// MCP
	"mcp.discoveryMode": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Tool Discovery",
			description: "Hide MCP tools by default and expose them through a tool discovery tool",
		},
	},

	"mcp.discoveryDefaultServers": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Discovery Default Servers",
			description: "Keep MCP tools from these servers visible while discovery mode hides other MCP tools",
		},
	},

	"mcp.notifications": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Update Injection",
			description: "Inject MCP resource updates into the agent conversation",
		},
	},

	"mcp.notificationDebounceMs": {
		type: "number",
		default: 500,
		ui: {
			min: 0, // a debounce cannot be negative
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Notification Debounce",
			description:
				"Debounce window in milliseconds for MCP resource updates before injecting them into the conversation",
		},
	},
} as const;
