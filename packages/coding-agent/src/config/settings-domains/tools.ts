/** Tools domain slice of SETTINGS_SCHEMA — composed in ../settings-schema.ts. */
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

	// Default tool approval mode (interaction tab, but governs the tool wrapper).
	// Autonomy ladder (src/tools/approval.ts normalizeApprovalMode):
	//   "plan"      — read-tier only; plan-mode session semantics.
	//   "ask"       — auto-approves read-tier tools only; prompts for write/exec.
	//   "auto-edit" — auto-approves read and write-tier tools; prompts for exec.
	//   "yolo"      — auto-approves every tier.
	// Legacy names "always-ask" (= ask) and "write" (= auto-edit) stay accepted
	// for stored configs and the CLI, but the UI offers the ladder names.
	"tools.approvalMode": {
		type: "enum",
		values: ["plan", "ask", "auto-edit", "yolo", "always-ask", "write"] as const,
		default: "yolo",
		ui: {
			tab: "interaction",
			group: "Approvals",
			label: "Tool Approval",
			description:
				"Default approval behavior for tool calls. 'Ask' auto-approves read-only tools only. 'Auto-edit' auto-approves read and workspace-write tools. 'Yolo' auto-approves all tiers; user policy may still prompt or block.",
			options: [
				{
					value: "plan",
					label: "Plan",
					description: "Read-only planning: auto-approve read tools; write and exec tools require confirmation.",
				},
				{
					value: "ask",
					label: "Ask",
					description: "Auto-approve read-only tools; require confirmation for write and exec tools.",
				},
				{
					value: "auto-edit",
					label: "Auto-edit",
					description:
						"Auto-approve read-only and write tools; require confirmation for exec tools such as bash, eval, browser, task, and ssh.",
				},
				{
					value: "yolo",
					label: "Yolo",
					description:
						"Auto-approve read, write, and exec tools. User policy can still require confirmation or block calls.",
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
			description: "Remind the agent to complete todos before stopping",
		},
	},

	"todo.reminders.max": {
		type: "number",
		default: 3,
		ui: {
			tab: "tools",
			group: "Todos",
			label: "Todo Reminder Limit",
			description: "Maximum number of todo reminders before giving up",
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
				"Cache rendered issue/PR view output in ~/.veyyon/cache/github-cache.db so repeated reads are free",
		},
	},

	"github.cache.softTtlSec": {
		type: "number",
		default: 300,
		ui: {
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
		default: true,
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
				"How long the poll tool waits for background job updates before returning the current state. A fixed value waits that exact duration every time. `smart` adapts: it starts at 5s and lengthens with each back-to-back poll (up to 5m), then resets to 5s after about a minute without polling.",
			options: [
				{ value: "5s", label: "5 seconds" },
				{ value: "10s", label: "10 seconds" },
				{ value: "30s", label: "30 seconds" },
				{ value: "1m", label: "1 minute" },
				{ value: "5m", label: "5 minutes" },
				{ value: "smart", label: "Smart", description: "Default — adaptive 5s→5m, resets when you stop polling" },
			],
		},
	},

	"irc.timeoutMs": {
		type: "number",
		default: 120_000,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "IRC Timeout",
			description: "Default timeout for irc wait (and send await:true) in milliseconds; 0 disables the timeout",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "30000", label: "30 seconds" },
				{ value: "60000", label: "1 minute" },
				{ value: "120000", label: "2 minutes" },
				{ value: "300000", label: "5 minutes" },
			],
		},
	},

	"bash.autoBackground.thresholdMs": {
		type: "number",
		default: 60_000,
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
				"Hide tools behind a search tool to save tokens. 'auto' hides MCP tools once the tool set has more than 40 tools; 'mcp-only' always hides MCP tools; 'all' hides all non-essential built-ins too.",
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
				"Override the always-loaded built-in tools (default: read, bash, edit, write, glob, eval). Leave empty to use defaults.",
		},
	},

	// MCP
	"mcp.enableProjectConfig": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Project Config",
			description: "Load .mcp.json/mcp.json from project root",
		},
	},

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
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Notification Debounce",
			description:
				"Debounce window in milliseconds for MCP resource updates before injecting them into the conversation",
		},
	},
} as const;
