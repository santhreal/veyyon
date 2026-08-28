import {
	DEFAULT_CYCLE_ORDER,
	EMPTY_MODEL_TAGS_RECORD,
	EMPTY_NUMBER_RECORD,
	EMPTY_STRING_ARRAY,
	EMPTY_STRING_RECORD,
} from "./shared";

/** General domain slice of SETTINGS_SCHEMA — composed in ../settings-schema.ts. */
export const GENERAL_SETTINGS = {
	// General settings (no UI) Retired: superseded by the machine-wide `onboardingVersion` in
	setupVersion: { type: "number", default: 0, retiredBy: "onboardingVersion" },

	// Which settings migrations have already been applied to the global config. A migration that cannot tell an old encoding from a value the user typed
	settingsMigrationVersion: { type: "number", default: 0 },

	// Auth broker — credentials proxied through a remote `veyyon auth-broker serve` host. Hidden from the UI; populate via env vars or hand-edited config.yml.
	"auth.broker.url": { type: "string", default: undefined },
	"auth.broker.token": { type: "string", default: undefined },

	autoResume: {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Auto Resume",
			description: "Automatically resume the most recent session in the current directory",
		},
	},

	// macOS power assertions (caffeinate flags). No-op on other platforms.
	"power.sleepPrevention": {
		type: "enum",
		values: ["off", "idle", "display", "system"] as const,
		default: "idle",
		ui: {
			tab: "interaction",
			group: "Power (macOS)",
			label: "Sleep Prevention",
			description:
				"Prevent macOS sleep during active sessions. Each level is cumulative — it adds the flags of all lower levels.",
			options: [
				{
					value: "off",
					label: "Off",
					description: "Do not prevent any sleep",
				},
				{
					value: "idle",
					label: "Prevent Idle Sleep",
					description: "Keep the system awake while a session is open (caffeinate -i)",
				},
				{
					value: "display",
					label: "Prevent Display Sleep",
					description: "Also keep the display from idle-sleeping (caffeinate -i -d)",
				},
				{
					value: "system",
					label: "Prevent System Sleep",
					description: "Also block all system sleep on AC and declare the user active (caffeinate -i -d -s -u)",
				},
			],
		},
	},
	"advisor.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Advisor",
			label: "Enable Advisor",
			description:
				"Pair a second model (assigned to the 'advisor' role) that passively reviews each turn and injects notes.",
		},
	},
	"prewalk.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Prewalk",
			label: "Enable Prewalk",
			description:
				"Plan on the strong model, then switch to the cheap model at the first edit/write after the plan nudge's todo list exists — the strong model commits the todos and starts the implementation before handing off. The cheap model comes from Prewalk Cheap Model; Prewalk Strong Model overrides the start model. Overridable per session with --prewalk / --no-prewalk.",
		},
	},
	"prewalk.cheapModel": {
		type: "modelChain",
		default: undefined,
		ui: {
			tab: "model",
			group: "Prewalk",
			label: "Prewalk Cheap Model",
			condition: "prewalkEnabled",
			description:
				"Model prewalk hands off to at the first edit/write. Required once prewalk is on: /prewalk and --prewalk fail with a message naming this setting when it is unset. --prewalk-into overrides it per session; only the first entry is used.",
		},
	},
	"prewalk.strongModel": {
		type: "modelChain",
		default: undefined,
		ui: {
			tab: "model",
			group: "Prewalk",
			label: "Prewalk Strong Model",
			condition: "prewalkEnabled",
			description:
				"Model a prewalk session starts on — the strong model that plans before the handoff. Unset: inherit the normal start model (--model or the remembered default). Only the first entry is used.",
		},
	},
	"advisor.subagents": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Advisor",
			label: "Advisor for Subagents",
			description: "Also enable the advisor on spawned task/eval subagents.",
			condition: "advisorEnabled",
		},
	},
	"advisor.syncBacklog": {
		type: "enum",
		values: ["off", "1", "3", "5"] as const,
		default: "off",
		ui: {
			tab: "model",
			group: "Advisor",
			label: "Advisor Sync Backlog",
			description:
				"Pause the main agent for up to 30 seconds if the advisor falls behind by this many turns. Off disables catch-up delays.",
			condition: "advisorEnabled",
		},
	},
	"advisor.immuneTurns": {
		type: "number",
		default: 3,
		ui: {
			tab: "model",
			group: "Advisor",
			label: "Advisor Immune Turns",
			description:
				"After an advisor concern or blocker interrupts, route further concerns/blockers non-interruptingly for this many primary turns.",
			options: [
				{ value: "0", label: "0 turns", description: "Allow every concern/blocker to interrupt." },
				{ value: "1", label: "1 turn" },
				{ value: "2", label: "2 turns" },
				{ value: "3", label: "3 turns", description: "Default." },
				{ value: "4", label: "4 turns" },
				{ value: "5", label: "5 turns" },
			],
			condition: "advisorEnabled",
		},
	},
	shellPath: { type: "string", default: undefined },
	"git.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Git",
			label: "Enable Git Integration",
			description: "Show git branch, status, and PR information in the TUI and watch repository metadata.",
		},
	},

	extensions: { type: "array", default: EMPTY_STRING_ARRAY },

	enabledModels: { type: "array", default: EMPTY_STRING_ARRAY },

	disabledProviders: { type: "array", default: EMPTY_STRING_ARRAY },

	"providers.maxInFlightRequests": {
		type: "record",
		default: EMPTY_NUMBER_RECORD,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Max In-Flight Requests",
			description:
				'Maximum concurrent LLM requests per provider id (for example "openai" or "anthropic"), shared across local veyyon processes with this config root. Omitted providers are unlimited.',
		},
	},

	disabledExtensions: { type: "array", default: EMPTY_STRING_ARRAY },

	modelRoles: {
		type: "record",
		default: EMPTY_STRING_RECORD,
		ui: {
			tab: "model",
			group: "Roles",
			label: "Role Models",
			description:
				"Assign a model to each role (task, plan, advisor, …). Opens a searchable picker with auth status. Scoped to the active profile — never edit config by hand.",
		},
	},

	modelTags: { type: "record", default: EMPTY_MODEL_TAGS_RECORD },

	modelProviderOrder: { type: "array", default: EMPTY_STRING_ARRAY },

	cycleOrder: { type: "array", default: DEFAULT_CYCLE_ORDER },
} as const;
