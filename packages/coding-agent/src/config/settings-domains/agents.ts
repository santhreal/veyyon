/**
 * Agents domain slice of SETTINGS_SCHEMA — composed in ../settings-schema.ts.
 *
 * Everything about spawned agents lives here: whether delegation happens at all,
 * which agent types exist, what model and effort each one runs, and the limits
 * every run is held to. It is one settings area because it used to be five —
 * `task.*` operational knobs on the Tasks tab, `agent.model` under Models,
 * `modelRoles.task` in the role table, `task.agentModelOverrides` and
 * `task.disabledAgents` with no UI at all — and no screen showed what a spawned
 * agent would actually do.
 *
 * Two rules hold this shape together:
 *
 *  1. ONE SCOPE, THE AGENT. A model or an effort is chosen for one agent, on
 *     that agent's page. An agent that names neither runs the `default` model
 *     role at the documented default effort. Nothing here answers for the whole
 *     roster at once, and the session model the operator is looking at reaches
 *     no agent but the main assistant.
 *  2. ONLY TASK DELEGATION IS ON BY DEFAULT. The bundled specialists are listed
 *     but disabled, because most sessions need a general delegate and nothing
 *     else, and every extra agent type costs tokens in the tool description and
 *     invites spawns nobody asked for.
 *  3. ENABLED GOVERNS THE MODEL, NOT YOU. A disabled agent is one the model may
 *     not choose. It does not disable the `/` commands that name that agent:
 *     running `/review` is you asking for a review, and the command grants its
 *     own agent for that turn. There is deliberately no third state between on
 *     and off — an earlier design had one, labelled "not offered but still runs
 *     when named", and nobody could tell what the switch did.
 */

/**
 * One lane in {@link AGENTS_SETTINGS}`["agent.agents"]`, keyed at the top
 * level by agent name (`deep`, `scout`, a user-authored agent, …).
 *
 * A lane is RECURSIVE, because that is the shape of the question. You pick what
 * an agent runs; then you go inside it and pick what IT may spawn, and what
 * that runs; and so on for as long as you keep turning the next level on. Every
 * level carries the same three answers and a door to the level below, so one
 * page shape serves every depth:
 *
 * ```
 * deep
 * ├── enabled        may this agent be spawned at all
 * ├── model          what deep runs
 * ├── thinkingLevel  the effort deep runs at
 * └── agents      what deep may spawn ─┐
 *     ├── enabled    unset = the ceiling   │ …and so on, unbounded
 *     ├── model      unset = deep's model  │
 *     ├── thinkingLevel                    │
 *     └── agents ───────────────────────┘
 * ```
 *
 * Two rules make the recursion answerable rather than merely deep:
 *
 *  1. UNSET MEANS THE LEVEL ABOVE. Not the session, not a default table: the
 *     lane that spawned you. Change what `deep` runs and everything under `deep`
 *     follows, which is the only reading under which a nested page needs no
 *     absolute value to be understood. The top level has no lane above it, so
 *     unset there is the `default` model role.
 *  2. `agents.enabled` IS THE DEPTH LIMIT. Turning a level on grants it; the
 *     first level nobody turned on is where `agent.maxNestedSpawnDepth`
 *     resumes answering. A separate per-agent number is gone: two controls over
 *     one axis is how a ceiling came to be edited on one screen and read on
 *     another.
 *
 * `maxNestedSpawnDepth` is not an API and is not called anywhere; it is a key
 * that EXISTS IN SHIPPED CONFIG FILES, so it is declared here and honored by
 * `laneDepthOf`. Deleting it would not remove it from an operator's `config.yml`
 * — it would only stop reading it, and silently change what that file means.
 * No screen writes it.
 */
export interface AgentLaneSettings {
	/**
	 * Whether this lane may run at all. At the top level: whether the model may
	 * choose this agent. Nested: whether the level above may spawn anything.
	 * Absent is not a decision — the blanket ceiling answers for that level.
	 */
	enabled?: boolean;
	/** What this lane runs. Unset inherits the lane above. */
	model?: string | string[];
	/** The effort this lane runs at. Unset inherits the lane above. */
	thinkingLevel?: string;
	/** What this lane may spawn, one level down. */
	agents?: AgentLaneSettings;
	/**
	 * The pre-tree numeric ceiling, as written by an earlier release. Read so
	 * that file keeps its meaning; superseded by the `agents` chain, which is
	 * what every screen writes.
	 */
	maxNestedSpawnDepth?: number;
}

/** The top level of a lane chain is a lane like any other. */
export type AgentSettings = AgentLaneSettings;

/**
 * The one bundled agent enabled out of the box: the end-to-end delegate.
 *
 * The other bundled agents (scout, reviewer, librarian, designer, sonic) stay
 * off until the operator turns them on. They are still LISTED while off, each
 * with a line saying what it is for, because an agent you cannot see is one you
 * will never enable. A user-authored agent under `~/.veyyon/agents/` is on by
 * default: writing the file is the opt-in.
 */
export const DEFAULT_ENABLED_BUNDLED_AGENT = "deep";

export const DEFAULT_AGENT_MAX_NESTED_SPAWN_DEPTH = 0;

/**
 * A finished agent goes through TWO stages, and they are not the same event.
 *
 * PARK ({@link DEFAULT_AGENT_IDLE_TTL_MS}) releases the live session: the
 * process, its MCP clients and its file handles go, the memory is freed. The row
 * stays in the roster, the transcript stays on disk, and messaging or opening the
 * agent rebuilds it. Nothing is lost by parking.
 *
 * PRUNE ({@link DEFAULT_AGENT_PRUNE_MS}) drops the parked row: the roster
 * stops listing it and it can no longer be woken. It deletes nothing — the
 * transcript stays on disk and stays readable at `history://<agent>` — so what a
 * prune costs is the ability to continue that agent, not the record of what it
 * did.
 */

/** Stage one: how long a finished agent stays live before it parks. */
export const DEFAULT_AGENT_IDLE_TTL_MS = 5 * 60_000;

/**
 * Stage two: how long a parked agent keeps its row before it is pruned.
 *
 * An hour, counted from the agent's last activity. Long enough that everything
 * from the session you are in is still there to open, short enough that a
 * conversation resumed tomorrow does not begin behind every agent it has ever
 * written — the roster of one such session held eighty rows.
 */
export const DEFAULT_AGENT_PRUNE_MS = 60 * 60_000;

/**
 * The same budget for an agent whose last words said it was waiting on another
 * agent. It stopped on purpose to let a peer finish, so pruning it on the
 * ordinary budget would throw away the one agent most likely to be messaged next.
 * Twice the ordinary grace, because the thing it waits for is another agent's
 * whole run.
 */
export const DEFAULT_AGENT_WAITING_PRUNE_MS = 2 * 60 * 60_000;

/** Shared recursion choices for the blanket setting and each per-agent override. */
export const AGENT_RECURSION_DEPTH_OPTIONS = [
	{ value: "-1", label: "Unlimited" },
	{ value: "0", label: "Parent only", description: "Direct spawned agents cannot spawn" },
	{ value: "1", label: "One nested level" },
	{ value: "2", label: "Two nested levels" },
	{ value: "3", label: "Three nested levels" },
] as const;

export const AGENTS_SETTINGS = {
	// ────────────────────────────────────────────────────────────────────────
	// Delegation
	// ────────────────────────────────────────────────────────────────────────

	"agent.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "agents",
			group: "Delegation",
			label: "Agents",
			description:
				"Allow this session to spawn agents. Off removes the task tool and the delegation instructions from the system prompt. Agent Delegation and the Roster keep their values and apply again when this is on.",
			keywords: ["agent", "spawn", "delegate", "off", "disable"],
		},
	},

	"agent.delegation": {
		type: "enum",
		values: ["allowed", "preferred", "required"] as const,
		default: "preferred",
		ui: {
			tab: "agents",
			group: "Delegation",
			label: "Agent Delegation",
			description:
				"How strongly the system prompt asks the model to delegate work to enabled agents. Allowed: the task tool is available and the prompt does not ask for delegation. Preferred: the prompt asks for substantial eligible work to be delegated. Required: Preferred plus a reminder on the first turn. Work no enabled agent covers stays with the main agent.",
			keywords: ["agent", "spawn", "fan out", "parallel", "eager"],
			options: [
				{ value: "allowed", label: "Allowed", description: "Available; the prompt does not ask for it" },
				{
					value: "preferred",
					label: "Preferred",
					description: "Default; the prompt asks for substantial work to be delegated",
				},
				{
					value: "required",
					label: "Required",
					description: "Preferred plus a first-turn reminder",
				},
			],
		},
	},

	"agent.batch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "agents",
			group: "Delegation",
			label: "Batch Task Calls",
			description:
				"Use the batch schema for the task tool: one call carries a shared context and a list of tasks, one agent per task. With async agents on, each task runs as a background agent; otherwise the call blocks until every task returns. Off uses the single-task schema.",
			// Advanced: it changes the tool's SCHEMA rather than any policy, so it is
			// a shape an integrator picks once, not a knob a session tunes.
			advanced: true,
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Agents — which ones this session offers, how deep they may go, and what
	// they run. One section, because those are one decision: an operator turning
	// a specialist on immediately asks what it will run, and the answer used to
	// be two sections away under a heading of its own.
	// ────────────────────────────────────────────────────────────────────────
	/**
	 * Per-agent settings keyed by agent name; see {@link AgentSettings}.
	 *
	 * Rendered as a table of discovered agents rather than one control, so the
	 * settings row is a summary that opens the per-agent editor. This is the ONLY
	 * surface that edits these rows: the agent dashboard (`/agents`) used to
	 * carry a second copy of the same table, and two editors over one setting is
	 * how the surfaces drifted apart before. The blanket depth limit each row
	 * inherits from sits in this same section for that reason: a spawn ceiling
	 * edited two sections apart from the overrides that outrank it is how an
	 * operator changes one and reads the other.
	 *
	 * IT IS THE ONLY PER-AGENT SURFACE FOR A MODEL OR AN EFFORT. The same value
	 * used to be reachable from three screens — a `Agent Model` row on this
	 * tab, a blanket `Model` row at the top of the roster, and each agent's own
	 * page — so the tab showed one model, the roster header showed the same one
	 * again, and the per-agent rows showed a third answer inherited from it. One
	 * blanket scope is back as {@link AGENTS_SETTINGS}`["agent.sharedModel"]`,
	 * and the two scopes are exclusive rather than layered: while the switch is
	 * on, the per-agent Model and Effort rows are not drawn at all, so exactly
	 * one screen shows a model and that screen is the one that changes it.
	 */
	"agent.agents": {
		type: "record",
		default: {} as Record<string, AgentSettings>,
		ui: {
			tab: "agents",
			group: "Agents",
			label: "Roster",
			description:
				"Which agent types the model may spawn and what each one runs. Enabled: the model may pick that agent. Disabled: it may not. With no rows, only the deep agent is enabled. Each agent's page sets its Model, its Effort and which agents it may spawn in turn; an unset value follows the level above, then the default model role.",
			keywords: [
				"agents",
				"roster",
				"scout",
				"designer",
				"reviewer",
				"librarian",
				"deep",
				"sonic",
				"enable",
				"disable",
				"per-agent",
				"model",
				"effort",
			],
		},
	},

	"agent.maxNestedSpawnDepth": {
		type: "number",
		default: DEFAULT_AGENT_MAX_NESTED_SPAWN_DEPTH,
		ui: {
			tab: "agents",
			group: "Agents",
			label: "Max Nested Spawn Depth",
			description:
				"How many levels deep spawned agents may spawn further agents, where an agent's own page does not set it. Parent only: agents this session spawns do not receive the task tool.",
			keywords: ["depth", "nested", "recursion", "spawn", "roster"],
			options: AGENT_RECURSION_DEPTH_OPTIONS,
		},
	},

	/**
	 * Which scope decides an agent's model and effort: the agent, or the whole
	 * roster.
	 *
	 * Off, the default, is per agent — a lane under `agent.agents`, then the
	 * agent's frontmatter, then the default model role. On, `agent.model` and
	 * `agent.thinkingLevel` answer for every agent and outrank both.
	 *
	 * The two scopes are EXCLUSIVE, not layered, which is the whole difference
	 * from the version of this switch that was retired. That one left the
	 * per-agent rows on screen and outranked by them, so the roster and the
	 * blanket row each showed a model and neither said which one a spawn would
	 * use. Here the switch decides which rows exist: on, the per-agent Model and
	 * Effort rows are not drawn, and the two rows below are. A lane that already
	 * names a model keeps its value in the file and gets it back when the switch
	 * goes off.
	 */
	"agent.sharedModel": {
		type: "boolean",
		default: false,
		ui: {
			tab: "agents",
			group: "Agents",
			label: "Same Model for All Agents",
			description:
				"Run every spawned agent on one Model and one Effort. Off: each agent's page sets its own. On: Shared Model and Shared Effort below apply to every agent and the per-agent rows are hidden; their values are kept for when this is off again.",
			keywords: ["shared", "blanket", "all agents", "one model", "roster", "model", "effort"],
		},
	},

	/** The model chain every agent runs while `agent.sharedModel` is on. */
	"agent.model": {
		type: "modelChain",
		default: undefined,
		ui: {
			tab: "agents",
			group: "Agents",
			label: "Shared Model",
			description:
				"The model chain every spawned agent runs while Same Model for All Agents is on. Unset: the default model role.",
			condition: "agentSharedModel",
			keywords: ["shared", "model", "all agents", "chain"],
		},
	},

	/** The effort every agent runs at while `agent.sharedModel` is on. */
	"agent.thinkingLevel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "agents",
			group: "Agents",
			label: "Shared Effort",
			description:
				"The effort every spawned agent runs at while Same Model for All Agents is on. Limited to the levels the shared model supports; a `:level` suffix on the model chain takes precedence. Inherit: the model's default.",
			condition: "agentSharedModel",
			keywords: ["shared", "effort", "thinking", "all agents"],
		},
	},

	/**
	 * RETIRED: a model chain keyed by spawn depth, which decided for whatever
	 * agent happened to run at that depth. A lane level under
	 * `agent.agents.<name>.agents` is the per-agent spelling of the same
	 * shape.
	 */
	"agent.modelByDepth": {
		type: "record",
		default: {} as Record<string, string | string[]>,
		retiredBy: "agent.agents",
	},

	"agent.showResolvedModelBadge": {
		type: "boolean",
		default: true,
		ui: {
			tab: "agents",
			group: "Agents",
			label: "Show Resolved Model Badge",
			description:
				"Show each spawned agent's resolved model, and the setting that selected it, in the task widget status line and on the agent surfaces.",
			advanced: true,
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Limits
	// ────────────────────────────────────────────────────────────────────────

	"agent.maxConcurrency": {
		type: "number",
		default: 32,
		ui: {
			tab: "agents",
			group: "Limits",
			label: "Max Concurrent Agents",
			description: "Maximum number of spawned agents running at once. Unlimited: no cap.",
			options: [
				{ value: "0", label: "Unlimited" },
				{ value: "1", label: "1 agent" },
				{ value: "2", label: "2 agents" },
				{ value: "4", label: "4 agents" },
				{ value: "8", label: "8 agents" },
				{ value: "16", label: "16 agents" },
				{ value: "32", label: "32 agents" },
				{ value: "64", label: "64 agents" },
			],
		},
	},

	"agent.maxRuntimeMs": {
		type: "number",
		default: 0,
		ui: {
			tab: "agents",
			group: "Limits",
			label: "Max Agent Runtime",
			description:
				"Maximum wall-clock time a spawned agent may run. An agent that reaches it is aborted with a 'timed out' reason. Unlimited: no limit.",
			options: [
				{ value: "0", label: "Unlimited", description: "Default" },
				{ value: "300000", label: "5 minutes" },
				{ value: "900000", label: "15 minutes" },
				{ value: "1800000", label: "30 minutes" },
				{ value: "3600000", label: "1 hour" },
			],
		},
	},

	"agent.idleTtlMs": {
		type: "number",
		default: DEFAULT_AGENT_IDLE_TTL_MS,
		ui: {
			tab: "agents",
			// Parking is not conditioned on the prune switch: it happens whether or not
			// the row is later dropped, so this row stays visible while pruning is off.
			group: "Idle Agents",
			label: "Park Idle Agents After",
			description:
				"How long a spawned agent that has finished its turn stays live before it is parked. A parked agent releases its process, MCP clients and memory; it stays in the roster and is rebuilt from its transcript when messaged or opened. Counted from the agent's last activity. Until exit: idle agents stay live for the whole session.",
			// A numeric setting with no option list is dropped by the UI adapter
			// (`pathToSettingDef` treats optionless numbers as schema-only), so stage one
			// of the lifecycle was documented, defaulted and honored while being
			// unreachable from /settings. The list is what makes the row exist, and what
			// renders 300000 as "5 minutes".
			options: [
				{ value: "0", label: "Until exit" },
				{ value: "60000", label: "1 minute" },
				{ value: "300000", label: "5 minutes", description: "Default" },
				{ value: "900000", label: "15 minutes" },
				{ value: "1800000", label: "30 minutes" },
			],
		},
	},

	"agent.prune.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "agents",
			group: "Idle Agents",
			label: "Prune Parked Agents",
			description:
				"Remove parked agents from the roster after Prune After. A pruned agent cannot be messaged or opened again; its transcript stays on disk and readable at history://<agent>. Off: parked agents stay in the roster until the session exits.",
		},
	},

	"agent.prune.afterMs": {
		type: "number",
		default: DEFAULT_AGENT_PRUNE_MS,
		ui: {
			tab: "agents",
			group: "Idle Agents",
			label: "Prune After",
			description:
				"How long a parked agent stays in the roster before it is pruned, counted from when it was parked.",
			options: [
				{ value: "900000", label: "15 minutes" },
				{ value: "1800000", label: "30 minutes" },
				{ value: "3600000", label: "1 hour", description: "Default" },
				{ value: "14400000", label: "4 hours" },
				{ value: "86400000", label: "1 day" },
			],
			condition: "agentPruneEnabled",
		},
	},

	"agent.prune.waitingAfterMs": {
		type: "number",
		default: DEFAULT_AGENT_WAITING_PRUNE_MS,
		ui: {
			tab: "agents",
			group: "Idle Agents",
			label: "Prune After While Waiting",
			description:
				"Prune After for a parked agent whose last message was that it is waiting on another agent. A value below Prune After is raised to it.",
			options: [
				{ value: "3600000", label: "1 hour" },
				{ value: "7200000", label: "2 hours", description: "Default" },
				{ value: "14400000", label: "4 hours" },
				{ value: "86400000", label: "1 day" },
			],
			condition: "agentPruneEnabled",
		},
	},

	"agent.softRequestBudget": {
		type: "number",
		default: 200,
		ui: {
			tab: "agents",
			group: "Limits",
			label: "Soft Request Budget",
			description:
				"Number of model requests a spawned agent may make per run before it is asked to wrap up. At 1.5 times this number the run is stopped and the agent returns what it has. Disabled: no limit. The bundled scout and sonic agents have a lower built-in budget.",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "90", label: "90 requests" },
				{ value: "150", label: "150 requests" },
				{ value: "200", label: "200 requests", description: "Default" },
			],
		},
	},

	"agent.softRequestBudgetNotice": {
		type: "boolean",
		default: true,
		ui: {
			tab: "agents",
			group: "Limits",
			label: "Soft Request Budget Notice",
			description:
				"Send an agent one steering notice when it crosses its Soft Request Budget, asking it to wrap up before the forced stop.",
			// Only reachable behaviour while a budget exists: with the guard disabled
			// there is no crossing to announce, so the row is hidden rather than
			// shown doing nothing.
			condition: "agentSoftRequestBudgetEnabled",
		},
	},

	"agent.enableLsp": {
		type: "boolean",
		default: false,
		ui: {
			tab: "agents",
			group: "Limits",
			label: "LSP in Agents",
			description: "Allow spawned agents to use the lsp tool. Off keeps agents cheaper.",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Isolation
	// ────────────────────────────────────────────────────────────────────────

	"agent.isolation.mode": {
		type: "enum",
		values: [
			"none",
			"auto",
			"apfs",
			"btrfs",
			"zfs",
			"reflink",
			"overlayfs",
			"projfs",
			"block-clone",
			"rcopy",
		] as const,
		default: "none",
		ui: {
			tab: "agents",
			group: "Isolation",
			label: "Isolation Mode",
			description:
				"Filesystem isolation for spawned agents. Auto picks the best backend available on this host: a copy-on-write filesystem, then overlayfs or ProjFS, then a git worktree or a recursive copy.",
			options: [
				{ value: "none", label: "None", description: "No isolation" },
				{ value: "auto", label: "Auto", description: "The best backend available on this host" },
				{ value: "apfs", label: "APFS", description: "macOS clonefile reflink (APFS)" },
				{ value: "btrfs", label: "btrfs", description: "btrfs subvolume snapshot" },
				{ value: "zfs", label: "ZFS", description: "ZFS snapshot + clone" },
				{ value: "reflink", label: "Reflink", description: "Linux FICLONE per-file reflink" },
				{
					value: "overlayfs",
					label: "Overlayfs",
					description: "Linux kernel overlay (or fuse-overlayfs fallback)",
				},
				{ value: "projfs", label: "ProjFS", description: "Windows Projected File System" },
				{
					value: "block-clone",
					label: "Block clone",
					description: "Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE (NTFS/ReFS)",
				},
				{
					value: "rcopy",
					label: "Recursive copy",
					description: "git worktree if available, otherwise recursive copy",
				},
			],
		},
	},

	"agent.isolation.merge": {
		type: "enum",
		values: ["patch", "branch"] as const,
		default: "patch",
		ui: {
			tab: "agents",
			group: "Isolation",
			label: "Isolation Merge Strategy",
			description: "How an isolated agent's changes are brought back: as one applied patch, or as a merged branch.",
			options: [
				{ value: "patch", label: "Patch", description: "Combine diffs and git apply" },
				{ value: "branch", label: "Branch", description: "Commit per task, merge with --no-ff" },
			],
			// Isolation is off by default, and these two decide only how an isolated
			// run's changes come back. A knob for a mode nobody selected is a knob
			// that reads as broken, so both hide until a backend is chosen.
			condition: "agentIsolationEnabled",
		},
	},

	"agent.isolation.commits": {
		type: "enum",
		values: ["generic", "ai"] as const,
		default: "generic",
		ui: {
			tab: "agents",
			group: "Isolation",
			label: "Isolation Commit Style",
			description: "Commit message style for changes made inside nested repositories.",
			options: [
				{ value: "generic", label: "Generic", description: "Static commit message" },
				{ value: "ai", label: "AI", description: "AI-generated commit message from diff" },
			],
			condition: "agentIsolationEnabled",
		},
	},

	"worktree.base": {
		type: "string",
		default: undefined,
		ui: {
			tab: "agents",
			group: "Isolation",
			label: "Worktree Base Directory",
			description:
				"Base directory for the worktrees this program manages: agent isolation copies, `github` PR checkouts and `veyyon worktree` cleanup. Unset: the active profile's `wt/` directory (~/.veyyon/profiles/<name>/wt, or its XDG data equivalent). Absolute or ~-relative; a relative path is ignored. The VEYYON_WORKTREE_DIR environment variable overrides this.",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
} as const;
