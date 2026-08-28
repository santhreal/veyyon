export const TASKS_SETTINGS = {
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

	"goal.modelBudgetsEnabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "Model Goal Budgets",
			description:
				"Expose and enforce persisted per-goal token budgets for the model. This control is available only in Settings.",
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
		default: -1,
		ui: {
			tab: "tools",
			group: "Todos",
			label: "Todo Auto-Clear Delay",
			description: "Delay before completed or abandoned todos are removed from the todo widget",
			options: [
				{ value: "0", label: "Instant" },
				{ value: "60", label: "1 minute" },
				{ value: "300", label: "5 minutes" },
				{ value: "900", label: "15 minutes" },
				{ value: "1800", label: "30 minutes" },
				{ value: "3600", label: "1 hour" },
				{ value: "-1", label: "Never", description: "Default" },
			],
		},
	},

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

	"skills.ignoredSkills": { type: "array", default: [] as string[] },

	"skills.includeSkills": { type: "array", default: [] as string[] },

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
} as const;
