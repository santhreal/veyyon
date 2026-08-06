/**
 * Subagents domain slice of SETTINGS_SCHEMA — composed in ../settings-schema.ts.
 *
 * Everything about spawned agents lives here: whether delegation happens at all,
 * which agent types exist, what model and effort each one runs, and the limits
 * every run is held to. It is one settings area because it used to be five —
 * `task.*` operational knobs on the Tasks tab, `subagent.model` under Models,
 * `modelRoles.task` in the role table, `task.agentModelOverrides` and
 * `task.disabledAgents` with no UI at all — and no screen showed what a spawned
 * agent would actually do.
 *
 * Two rules hold this shape together:
 *
 *  1. UNSET MEANS INHERIT. A per-agent model left blank follows the session's
 *     live main model. No agent carries a private model chain, so turning one on
 *     never silently introduces a second (billed) model.
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

import { configuredThinkingLevelOptions } from "../../thinking";

/**
 * Per-agent configuration held in {@link SUBAGENTS_SETTINGS}`["subagent.agents"]`,
 * keyed by agent name (`task`, `scout`, a user-authored agent, …).
 *
 * Every field is optional and an omitted field means "use the default", never
 * "off": `enabled` defaults per {@link subagentEnabledByDefault}, and `model` /
 * `thinkingLevel` default to inheriting the session's.
 */
export interface SubagentAgentSettings {
	/** Whether this agent can be spawned at all. */
	enabled?: boolean;
	/** Model pattern for this agent; blank inherits the session's live model. */
	model?: string;
	/** Thinking level / effort for this agent; blank inherits the session's. */
	thinkingLevel?: string;
	/** Nested levels this agent may still spawn; blank inherits the blanket limit. */
	maxNestedSpawnDepth?: number;
}

/**
 * The one bundled agent enabled out of the box: the general-purpose delegate.
 *
 * Bundled specialists (scout, reviewer, librarian, designer, sonic) stay off
 * until the operator turns them on. They are still LISTED while off, each with a
 * line saying what it is for, because an agent you cannot see is one you will
 * never enable. A user-authored agent under `.veyyon/agents/` is on by default —
 * writing the file is the opt-in.
 */
export const DEFAULT_ENABLED_BUNDLED_AGENT = "task";

export const DEFAULT_SUBAGENT_MAX_NESTED_SPAWN_DEPTH = 0;

/** Default time a finished subagent remains live and immediately revivable. */
export const DEFAULT_SUBAGENT_IDLE_TTL_MS = 5 * 60_000;

/**
 * Default time a PARKED subagent is kept in the roster before it is closed for
 * good. Parking already released the session; this is how long the revivable ref
 * survives after that, so a finished agent stops accumulating in `irc list` and
 * the Control Center forever.
 */
export const DEFAULT_SUBAGENT_PARKED_CLOSE_MS = 5 * 60_000;

/**
 * The same budget for an agent whose last words said it was waiting on another
 * agent. It stopped on purpose to let a peer finish, so closing it on the ordinary
 * timer would throw away the one agent most likely to be messaged next. Six times
 * the ordinary grace, because the thing it waits for is another agent's whole run.
 */
export const DEFAULT_SUBAGENT_WAITING_CLOSE_MS = 30 * 60_000;

/** Shared recursion choices for the blanket setting and each per-agent override. */
export const SUBAGENT_RECURSION_DEPTH_OPTIONS = [
	{ value: "-1", label: "Unlimited" },
	{ value: "0", label: "Parent only", description: "Direct subagents cannot spawn" },
	{ value: "1", label: "One nested level" },
	{ value: "2", label: "Two nested levels" },
	{ value: "3", label: "Three nested levels" },
] as const;

export const SUBAGENTS_SETTINGS = {
	// ────────────────────────────────────────────────────────────────────────
	// Delegation
	// ────────────────────────────────────────────────────────────────────────

	"subagent.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "subagents",
			group: "Delegation",
			label: "Subagents",
			description:
				"Whether this session may use subagents at all. Off removes the task tool and every delegation instruction from the prompt, so nothing can be spawned. This is the only setting that takes the ability away: Agent Delegation below decides how hard the model is PUSHED to delegate, never whether it may. Your delegation strength and Agents table are kept while this is off and take effect again when you turn it back on.",
			keywords: ["subagent", "spawn", "delegate", "off", "disable"],
		},
	},

	"subagent.delegation": {
		type: "enum",
		values: ["allowed", "preferred", "required"] as const,
		default: "preferred",
		ui: {
			tab: "subagents",
			group: "Delegation",
			label: "Agent Delegation",
			description:
				"How strongly this session routes work to the agent types you enabled. Allowed leaves delegation available without prompting for it. Preferred asks for substantial eligible work to be delegated. Required adds a first-turn reminder. The enabled Agents table is the routing policy: each name is a distinct type that owns only work matching its description, no type is a fallback for another, and work no enabled type covers stays with the main agent. Turn Subagents off above to remove delegation entirely.",
			keywords: ["subagent", "spawn", "fan out", "parallel", "eager"],
			options: [
				{ value: "allowed", label: "Allowed", description: "Offered, never asked for — the model decides" },
				{
					value: "preferred",
					label: "Preferred",
					description: "Default — prompt asks for substantial work to be delegated",
				},
				{
					value: "required",
					label: "Required",
					description: "Prompt guidance plus a first-turn delegation reminder",
				},
			],
		},
	},

	"subagent.batch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "subagents",
			group: "Delegation",
			label: "Batch Task Calls",
			description:
				"Switch the task tool to its batch shape: one call carries { agent, context, tasks[] } — one subagent per item (with per-item isolation) and a required shared context prepended to every assignment. With async.enabled=true, each spawn runs as an independent background agent with the normal idle/parked lifecycle; otherwise the call blocks for merged results. Disable to restore the flat single-spawn schema.",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Agents — the per-agent table (enabled + model + effort)
	// ────────────────────────────────────────────────────────────────────────

	/**
	 * Per-agent settings keyed by agent name; see {@link SubagentAgentSettings}.
	 *
	 * Rendered as a table of discovered agents rather than one control, so the
	 * settings row is a summary that opens the per-agent editor. This is the ONLY
	 * surface that edits these rows: the Agent Control Center (`/agents`) used to
	 * carry a second copy of the same table, and two editors over one setting is
	 * how the surfaces drifted apart before.
	 */
	"subagent.agents": {
		type: "record",
		default: {} as Record<string, SubagentAgentSettings>,
		ui: {
			tab: "subagents",
			group: "Agents",
			label: "Agents",
			description:
				"Which agent types the model may choose, and the model, effort, and recursion limit each one uses. Enabled means the model can pick that agent on its own; disabled means it cannot. With no row, only the general task worker is enabled. Bundled specialists and agents you add are opt-in through onboarding or this table. Per-agent values win over the blanket Subagent Model, Subagent Effort, and Max Nested Spawn Depth settings; blank inherits.",
			keywords: ["agents", "scout", "reviewer", "librarian", "designer", "sonic", "enable", "disable", "per-agent"],
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Models
	// ────────────────────────────────────────────────────────────────────────

	"subagent.model": {
		type: "modelChain",
		default: undefined,
		ui: {
			tab: "subagents",
			group: "Models",
			label: "Subagent Model",
			description:
				"Models for every enabled subagent that has no per-agent model of its own, tried in order: the rest are used when an earlier one errors. Unset means inherit: subagents follow the session's live main model. A per-agent model in the Agents table wins over this.",
			keywords: ["task", "spawn", "delegate", "worker"],
		},
	},

	"subagent.thinkingLevel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "subagents",
			group: "Models",
			label: "Subagent Effort",
			description:
				"Thinking level for every enabled subagent that has no per-agent effort of its own. Inherit follows the session's effort. An explicit `:level` suffix on a model pattern still wins.",
			keywords: ["thinking", "reasoning", "effort"],
			// Picked from the one effort vocabulary rather than typed. As a free-text
			// field this accepted anything, and an unrecognized value resolved to
			// "inherited" — a setting that looked configured and did nothing.
			options: configuredThinkingLevelOptions(),
		},
	},

	"subagent.showResolvedModelBadge": {
		type: "boolean",
		default: true,
		ui: {
			tab: "subagents",
			group: "Models",
			label: "Show Resolved Model Badge",
			description:
				"Show each subagent's resolved model, and the setting that decided it, in the task widget status line and the agent surfaces.",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Limits
	// ────────────────────────────────────────────────────────────────────────

	"subagent.maxConcurrency": {
		type: "number",
		default: 32,
		ui: {
			tab: "subagents",
			group: "Limits",
			label: "Max Concurrent Subagents",
			description: "Maximum number of subagents running concurrently",
			options: [
				{ value: "0", label: "Unlimited" },
				{ value: "1", label: "1 subagent" },
				{ value: "2", label: "2 subagents" },
				{ value: "4", label: "4 subagents" },
				{ value: "8", label: "8 subagents" },
				{ value: "16", label: "16 subagents" },
				{ value: "32", label: "32 subagents" },
				{ value: "64", label: "64 subagents" },
			],
		},
	},

	"subagent.maxNestedSpawnDepth": {
		type: "number",
		default: DEFAULT_SUBAGENT_MAX_NESTED_SPAWN_DEPTH,
		ui: {
			tab: "subagents",
			group: "Limits",
			label: "Max Nested Spawn Depth",
			description:
				"How many nested levels subagents may spawn. 0 still lets the parent session spawn direct subagents, but those children do not receive the task tool. Each agent can override this in the Agents editor.",
			options: SUBAGENT_RECURSION_DEPTH_OPTIONS,
		},
	},

	"subagent.maxRuntimeMs": {
		type: "number",
		default: 0,
		ui: {
			tab: "subagents",
			group: "Limits",
			label: "Max Subagent Runtime",
			description:
				"Hard wall-clock limit per subagent (ms). 0 disables it. Defense-in-depth against provider-side stream hangs that escape the inference-layer watchdog; triggers a normal subagent abort with a 'timed out' reason.",
			options: [
				{ value: "0", label: "Unlimited", description: "Default" },
				{ value: "300000", label: "5 minutes" },
				{ value: "900000", label: "15 minutes" },
				{ value: "1800000", label: "30 minutes" },
				{ value: "3600000", label: "1 hour" },
			],
		},
	},

	"subagent.idleTtlMs": {
		type: "number",
		default: DEFAULT_SUBAGENT_IDLE_TTL_MS,
		ui: {
			tab: "subagents",
			// Stage ONE of the same two-stage lifecycle the close budgets below finish, so it
			// belongs in their group rather than under Limits: an operator reading "Close After"
			// needs to see what has to happen first. Labelled "Park After" for the same reason,
			// so the group reads as a sequence rather than as one stray timeout beside two others.
			//
			// Deliberately NOT gated on `subagentAutoCloseEnabled`. Parking is what releases the
			// session and it happens whether or not the ref is eventually dropped, so hiding this
			// row when closing is off would hide the only control over stage one.
			group: "Auto Close",
			label: "Park After",
			description:
				"How long a finished subagent stays live before parking (ms). The default is 5 minutes. Parking releases the live session and keeps the transcript, so a parked agent revives automatically when messaged or resumed. Set 'Until exit' to keep idle agents live for the whole session. Counted from the agent's last activity, so a revived agent starts this budget again from the revival.",
			// A numeric setting with no option list is dropped by the UI adapter
			// (`pathToSettingDef` treats optionless numbers as schema-only), so stage one
			// of the park/close lifecycle was documented, defaulted and honored while
			// being unreachable from /settings. The list is what makes the row exist, and
			// what renders 300000 as "5 minutes" beside the close budgets below it.
			options: [
				{ value: "0", label: "Until exit" },
				{ value: "60000", label: "1 minute" },
				{ value: "300000", label: "5 minutes", description: "Default" },
				{ value: "900000", label: "15 minutes" },
				{ value: "1800000", label: "30 minutes" },
			],
		},
	},

	"subagent.autoClose.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "subagents",
			group: "Auto Close",
			label: "Close Parked Subagents",
			description:
				"Close a parked subagent for good once it has been quiet long enough, instead of keeping it in the roster for the whole session. Parking already released the session; this decides whether the revivable reference is eventually dropped too. Turn it off to keep every finished subagent listed and revivable until you exit.",
		},
	},

	"subagent.autoClose.parkedMs": {
		type: "number",
		default: DEFAULT_SUBAGENT_PARKED_CLOSE_MS,
		ui: {
			tab: "subagents",
			group: "Auto Close",
			label: "Close After",
			description:
				"How long a parked subagent stays listed and revivable before it is closed (ms). Counted from the moment it parked, not from when it started. Its transcript survives either way and stays readable through `history://`.",
			options: [
				{ value: "300000", label: "5 minutes", description: "Default" },
				{ value: "900000", label: "15 minutes" },
				{ value: "1800000", label: "30 minutes" },
				{ value: "3600000", label: "1 hour" },
			],
			condition: "subagentAutoCloseEnabled",
		},
	},

	"subagent.autoClose.waitingMs": {
		type: "number",
		default: DEFAULT_SUBAGENT_WAITING_CLOSE_MS,
		ui: {
			tab: "subagents",
			group: "Auto Close",
			label: "Close After (Waiting)",
			description:
				"The same budget for a subagent whose last message said it was waiting on another agent (ms). It stopped on purpose to let a peer finish, so it gets a longer grace than one that simply went quiet: closing it on the ordinary timer would drop the agent you are most likely to message next. Set it equal to Close After to treat both the same.",
			options: [
				{ value: "900000", label: "15 minutes" },
				{ value: "1800000", label: "30 minutes", description: "Default" },
				{ value: "3600000", label: "1 hour" },
				{ value: "7200000", label: "2 hours" },
			],
			condition: "subagentAutoCloseEnabled",
		},
	},

	"subagent.softRequestBudget": {
		type: "number",
		default: 200,
		ui: {
			tab: "subagents",
			group: "Limits",
			label: "Soft Request Budget",
			description:
				"Soft per-subagent request budget (assistant requests per run). Crossing it injects a wrap-up steering notice (see the notice setting below); at 1.5x the budget the run is force-stopped and the agent must yield its partial findings. 0 disables the guard. Bundled scout/sonic agents use a lower built-in budget.",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "90", label: "90 requests" },
				{ value: "150", label: "150 requests" },
				{ value: "200", label: "200 requests", description: "Default" },
			],
		},
	},

	"subagent.softRequestBudgetNotice": {
		type: "boolean",
		default: true,
		ui: {
			tab: "subagents",
			group: "Limits",
			label: "Soft Request Budget Notice",
			description:
				"Inject one steering notice when a subagent crosses its soft request budget, asking it to wrap up before the 1.5x forced-yield stop.",
		},
	},

	"subagent.enableLsp": {
		type: "boolean",
		default: false,
		ui: {
			tab: "subagents",
			group: "Limits",
			label: "LSP in Subagents",
			description:
				"Allow spawned subagents to use the lsp tool. Off by default to keep subagents cheap; enable when LSP-aware delegation is worth the extra tokens.",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Isolation
	// ────────────────────────────────────────────────────────────────────────

	"subagent.isolation.mode": {
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
			tab: "subagents",
			group: "Isolation",
			label: "Isolation Mode",
			description:
				'Isolation backend for subagents. "auto" lets the native PAL pick the best available backend (CoW-aware filesystems, then overlayfs/ProjFS, then a git worktree / recursive-copy fallback).',
			options: [
				{ value: "none", label: "None", description: "No isolation" },
				{ value: "auto", label: "Auto", description: "Let the PAL pick the best available backend" },
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

	"subagent.isolation.merge": {
		type: "enum",
		values: ["patch", "branch"] as const,
		default: "patch",
		ui: {
			tab: "subagents",
			group: "Isolation",
			label: "Isolation Merge Strategy",
			description: "How isolated subagent changes are integrated (patch apply or branch merge)",
			options: [
				{ value: "patch", label: "Patch", description: "Combine diffs and git apply" },
				{ value: "branch", label: "Branch", description: "Commit per task, merge with --no-ff" },
			],
		},
	},

	"subagent.isolation.commits": {
		type: "enum",
		values: ["generic", "ai"] as const,
		default: "generic",
		ui: {
			tab: "subagents",
			group: "Isolation",
			label: "Isolation Commit Style",
			description: "Commit message style for nested repo changes (generic or AI-generated)",
			options: [
				{ value: "generic", label: "Generic", description: "Static commit message" },
				{ value: "ai", label: "AI", description: "AI-generated commit message from diff" },
			],
		},
	},

	"worktree.base": {
		type: "string",
		default: undefined,
		ui: {
			tab: "subagents",
			group: "Isolation",
			label: "Worktree Base Directory",
			description:
				"Base directory for agent-managed worktrees: subagent isolation copies, `github` PR checkouts, and `veyyon worktree` cleanup all live here. Unset uses the active profile's `wt/` directory (~/.veyyon/profiles/<name>/wt, or its XDG data equivalent). Must be an absolute or ~-relative path; relative paths are ignored. The VEYYON_WORKTREE_DIR env var overrides this.",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
} as const;
