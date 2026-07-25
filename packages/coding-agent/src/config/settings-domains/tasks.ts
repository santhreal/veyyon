/** Tasks domain slice of SETTINGS_SCHEMA — composed in ../settings-schema.ts. */
export const TASKS_SETTINGS = {
	// ────────────────────────────────────────────────────────────────────────
	// Tasks
	// ────────────────────────────────────────────────────────────────────────

	// Plan mode
	"plan.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Plan Mode",
			description: "Enable plan mode for read-only exploration and planning before execution",
		},
	},

	"plan.defaultOnStartup": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Start in Plan Mode",
			description: "Automatically enter plan mode at the start of every new session",
			condition: "planModeEnabled",
		},
	},

	// Per-model harness profile overrides (src/harness/model-profile.ts). Keys are
	// `provider/model-id` or `provider/*`; values: { repair?: boolean, tools?: string[] }.
	"harness.profiles": { type: "record", default: {} as Record<string, unknown> },

	"goal.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Goal Mode",
			description: "Enable per-session goal mode and the hidden goal tool",
		},
	},

	"goal.statusInFooter": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Goal Progress Bar in Footer",
			description:
				"Add a compact progress bar next to the goal token count in the status line. The token count is always shown; this controls the extra bar.",
		},
	},

	"goal.continuationModes": {
		type: "array",
		default: ["interactive"],
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Goal Continuation Modes",
			description: "Run modes where active goals may auto-continue between turns",
		},
	},

	"title.refreshOnReplan": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Refresh Title on Replan",
			description: "Refresh generated session titles after todo init replans unless the title was set by the user",
		},
	},

	"tasks.todoClearDelay": {
		type: "number",
		default: 60,
		ui: {
			tab: "tools",
			group: "Todos",
			label: "Todo Auto-Clear Delay",
			description: "Delay before completed or abandoned todos are removed from the todo widget",
			options: [
				{ value: "0", label: "Instant" },
				{ value: "60", label: "1 minute", description: "Default" },
				{ value: "300", label: "5 minutes" },
				{ value: "900", label: "15 minutes" },
				{ value: "1800", label: "30 minutes" },
				{ value: "3600", label: "1 hour" },
				{ value: "-1", label: "Never" },
			],
		},
	},

	// Skills
	"skills.enabled": { type: "boolean", default: true },

	"skills.enableSkillCommands": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "Skill Commands",
			description: "Register skills as /skill:name commands",
		},
	},

	// Skills load only from the active profile's Veyyon agent dir (plus its
	// managed auto-learn skills and profile-installed plugins). There is no
	// cross-computer autodiscovery, so there are no per-source toggles here; the
	// two lists below filter that profile set by skill name.

	"skills.ignoredSkills": { type: "array", default: [] as string[] },

	"skills.includeSkills": { type: "array", default: [] as string[] },

	// Commands
	"commands.enableClaudeUser": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "Claude User Commands",
			description: "Load commands from ~/.claude/commands/",
		},
	},

	"commands.enableClaudeProject": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "Claude Project Commands",
			description: "Load commands from .claude/commands/",
		},
	},

	"commands.enableOpencodeUser": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "OpenCode User Commands",
			description: "Load commands from ~/.config/opencode/commands/",
		},
	},

	"commands.enableOpencodeProject": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "OpenCode Project Commands",
			description: "Load commands from .opencode/commands/",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
} as const;
