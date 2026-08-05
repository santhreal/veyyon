import {
	DEFAULT_CYCLE_ORDER,
	EMPTY_MODEL_TAGS_RECORD,
	EMPTY_NUMBER_RECORD,
	EMPTY_STRING_ARRAY,
	EMPTY_STRING_RECORD,
} from "./shared";

/** General domain slice of SETTINGS_SCHEMA — composed in ../settings-schema.ts. */
export const GENERAL_SETTINGS = {
	// ────────────────────────────────────────────────────────────────────────
	// General settings (no UI)
	// ────────────────────────────────────────────────────────────────────────
	// Retired: superseded by the machine-wide `onboardingVersion` in
	// ~/.veyyon/config.yml (see settings-domains/global.ts).
	//
	// This key is PER PROFILE, and that is what made a finished install re-onboard.
	// A profile's config.yml is written under ~/.veyyon/profiles/<name>/agent, so
	// running `--profile veybot` after onboarding on the default profile read the
	// default 0 and treated a long-standing install as brand new. Onboarding is a
	// thing a person does once per machine, so it now lives beside `defaultProfile`
	// in the one cross-profile file.
	//
	// Kept, and still read, as the migration source: `resolveOnboardingGeneration`
	// promotes a completed value here into the global store on the first launch
	// after the move. Without that fallback the relocation would itself re-onboard
	// the entire installed base exactly once, which is the same bug in new clothes.
	setupVersion: { type: "number", default: 0, retiredBy: "onboardingVersion" },

	// Which settings migrations have already been applied to the global config.
	// A migration that cannot tell an old encoding from a value the user typed
	// needs this: stripping the `-1` that used to mean "unset" is safe exactly
	// once, and re-running it on every load would delete a `-1` the user set
	// deliberately (which is now a legal presence penalty). Stamped into
	// config.yml when the migration runs; not a knob, so it has no `ui`.
	settingsMigrationVersion: { type: "number", default: 0 },

	// Auth broker — credentials proxied through a remote `veyyon auth-broker serve`
	// host. Hidden from the UI; populate via env vars or hand-edited config.yml.
	// Env (`VEYYON_AUTH_BROKER_URL` / `VEYYON_AUTH_BROKER_TOKEN`) takes precedence so
	// per-machine overrides remain trivial.
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
				"Start on the active model, then switch to a fast/cheap model (default the 'smol' role) at the first edit/write after the plan nudge's todo list exists — the strong model plans, commits the todos, and starts the implementation before handing off. Overridable per session with --prewalk / --no-prewalk.",
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
			description:
				"Show git branch, status, and PR information in the TUI, watch repository metadata, and let the commit nudge read repository state.",
		},
	},

	// The threshold for the `commit-drift` rule. A count rather than a boolean
	// because the right cadence is a property of the repository, not of the agent:
	// a tree where one logical change spans a dozen files wants a higher number
	// than one where three files is already two concerns.
	"commit.nudgeAfterFiles": {
		type: "number",
		default: 4,
		ui: {
			tab: "interaction",
			group: "Git",
			label: "Commit Nudge Threshold",
			description:
				"Remind the agent to commit once this many files it edited itself are uncommitted. Counts only files this session changed, never other work already dirty in the tree. 0 turns the reminder off.",
			condition: "gitEnabled",
			options: [
				{ value: "0", label: "Off", description: "Never remind" },
				{ value: "2", label: "2 files" },
				{ value: "4", label: "4 files", description: "Default." },
				{ value: "8", label: "8 files" },
				{ value: "16", label: "16 files" },
			],
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
