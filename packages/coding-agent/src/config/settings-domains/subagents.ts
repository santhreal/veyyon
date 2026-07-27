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
				"Whether this session may use subagents at all. Off removes the task tool and every delegation instruction from the prompt, so nothing can be spawned. This is the only setting that takes the ability away: Task Delegation below decides how hard the model is PUSHED to delegate, never whether it may. Your delegation strength and Agents table are kept while this is off and take effect again when you turn it back on.",
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
			label: "Task Delegation",
			description:
				"How hard this session pushes work out to subagents. It never removes the ability to delegate — at `allowed` the model still has the task tool and still spawns a subagent when that is the sensible move, it is simply not asked to. To remove subagents entirely, use the Subagents switch above. WHAT gets delegated is decided by the Agents table, not here: the agents you enable are the instruction, so enabling the reviewer is how you say reviews are delegable. With no agent enabled there is nothing to delegate to and the strength you pick has no effect.",
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
	 * settings row is a summary that opens the per-agent editor. `/agents` edits
	 * the same rows against the same resolver; neither surface owns the meaning.
	 */
	"subagent.agents": {
		type: "record",
		default: {} as Record<string, SubagentAgentSettings>,
		ui: {
			tab: "subagents",
			group: "Agents",
			label: "Agents",
			description:
				"Which agent types the model may choose, and the model and effort each one runs. Enabled means the model can pick that agent on its own; disabled means it cannot, and nothing runs behind your back. Every row is optional: with no row, the general worker and any agent you wrote are enabled, and the bundled specialists are disabled. Turning an agent off does not disable the `/` commands that name it — `/review` is you asking for a review, so it still spawns its reviewer. A per-agent model wins over the blanket Subagent Model; blank inherits.",
			keywords: ["agents", "scout", "reviewer", "librarian", "designer", "sonic", "enable", "disable", "per-agent"],
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Models
	// ────────────────────────────────────────────────────────────────────────

	"subagent.model": {
		type: "string",
		default: undefined,
		ui: {
			tab: "subagents",
			group: "Models",
			label: "Subagent Model",
			description:
				"Model for every enabled subagent that has no per-agent model of its own. Unset means inherit: subagents follow the session's live main model. A per-agent model in the Agents table wins over this.",
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

	"subagent.maxRecursionDepth": {
		type: "number",
		default: 2,
		ui: {
			tab: "subagents",
			group: "Limits",
			label: "Max Spawn Depth",
			description: "How many levels deep subagents can spawn their own subagents",
			options: [
				{ value: "-1", label: "Unlimited" },
				{ value: "0", label: "None" },
				{ value: "1", label: "Single" },
				{ value: "2", label: "Double" },
				{ value: "3", label: "Triple" },
			],
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
		default: 420_000,
		ui: {
			tab: "subagents",
			group: "Limits",
			label: "Idle TTL",
			description:
				"How long an idle subagent stays live in memory before being parked to disk (ms). Parked agents are revived automatically when messaged or resumed. 0 keeps idle agents live until exit.",
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
				"Base directory for agent-managed worktrees — subagent isolation copies, `github` PR checkouts, and `veyyon worktree` cleanup all live here. Unset uses ~/.veyyon/wt. Must be an absolute or ~-relative path; relative paths are ignored. The VEYYON_WORKTREE_DIR env var overrides this.",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
} as const;
