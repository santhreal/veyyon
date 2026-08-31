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

/**
 * One lane in {@link SUBAGENTS_SETTINGS}`["subagent.agents"]`, keyed at the top
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
 * └── subagents      what deep may spawn ─┐
 *     ├── enabled    unset = the ceiling   │ …and so on, unbounded
 *     ├── model      unset = deep's model  │
 *     ├── thinkingLevel                    │
 *     └── subagents ───────────────────────┘
 * ```
 *
 * Two rules make the recursion answerable rather than merely deep:
 *
 *  1. UNSET MEANS THE LEVEL ABOVE. Not the session, not a default table: the
 *     lane that spawned you. Change what `deep` runs and everything under `deep`
 *     follows, which is the only reading under which a nested page needs no
 *     absolute value to be understood.
 *  2. `subagents.enabled` IS THE DEPTH LIMIT. Turning a level on grants it; the
 *     first level nobody turned on is where `subagent.maxNestedSpawnDepth`
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
export interface SubagentLaneSettings {
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
	subagents?: SubagentLaneSettings;
	/**
	 * The pre-tree numeric ceiling, as written by an earlier release. Read so
	 * that file keeps its meaning; superseded by the `subagents` chain, which is
	 * what every screen writes.
	 */
	maxNestedSpawnDepth?: number;
}

/** The top level of a lane chain is a lane like any other. */
export type SubagentAgentSettings = SubagentLaneSettings;

/**
 * A `subagent.modelByDepth` key is a positive integer spawn depth: "1" for a
 * direct child, "2" for a grandchild, and so on. "0" is refused because no
 * spawn runs at the root session's own depth, and a zero-padded or non-numeric
 * key can never match the number the resolver asks with. Shared by the entry
 * validator below and the one reader (`task/subagent-settings.ts`) so the two
 * can never disagree about which keys are real.
 */
export function isModelByDepthKey(key: string): boolean {
	return /^[1-9]\d*$/.test(key);
}

/**
 * Validate one `subagent.modelByDepth` entry: the key is a depth and the value
 * is a chain in the same two spellings `subagent.model` accepts. Reported
 * through `describeSettingTypeMismatch`, so a bad entry is surfaced with its
 * file at load instead of sitting in the map looking configured and deciding
 * nothing.
 */
function validateModelByDepthEntry(key: string, value: unknown): string | undefined {
	if (!isModelByDepthKey(key)) {
		return `subagent.modelByDepth.${key}: depth keys are positive integers ("1", "2", …), found "${key}"`;
	}
	if (typeof value === "string") return undefined;
	if (Array.isArray(value)) {
		const bad = value.findIndex(entry => typeof entry !== "string");
		return bad === -1
			? undefined
			: `subagent.modelByDepth.${key}: expected model patterns, found ${typeof value[bad]} at index ${bad}`;
	}
	return `subagent.modelByDepth.${key}: expected a model pattern, or a list of them`;
}

/**
 * The one bundled agent enabled out of the box: the end-to-end delegate.
 *
 * The other bundled agents (scout, reviewer, librarian, designer, sonic) stay
 * off until the operator turns them on. They are still LISTED while off, each
 * with a line saying what it is for, because an agent you cannot see is one you
 * will never enable. A user-authored agent under `.veyyon/agents/` is on by
 * default: writing the file is the opt-in.
 */
export const DEFAULT_ENABLED_BUNDLED_AGENT = "deep";

export const DEFAULT_SUBAGENT_MAX_NESTED_SPAWN_DEPTH = 0;

/**
 * A finished subagent goes through TWO stages, and they are not the same event.
 *
 * PARK ({@link DEFAULT_SUBAGENT_IDLE_TTL_MS}) releases the live session: the
 * process, its MCP clients and its file handles go, the memory is freed. The row
 * stays in the roster, the transcript stays on disk, and messaging or opening the
 * agent rebuilds it. Nothing is lost by parking.
 *
 * PRUNE ({@link DEFAULT_SUBAGENT_PRUNE_MS}) drops the parked row: the roster
 * stops listing it and it can no longer be woken. It deletes nothing — the
 * transcript stays on disk and stays readable at `history://<agent>` — so what a
 * prune costs is the ability to continue that agent, not the record of what it
 * did.
 */

/** Stage one: how long a finished subagent stays live before it parks. */
export const DEFAULT_SUBAGENT_IDLE_TTL_MS = 5 * 60_000;

/**
 * Stage two: how long a parked subagent keeps its row before it is pruned.
 *
 * An hour, counted from the agent's last activity. Long enough that everything
 * from the session you are in is still there to open, short enough that a
 * conversation resumed tomorrow does not begin behind every subagent it has ever
 * written — the roster of one such session held eighty rows.
 */
export const DEFAULT_SUBAGENT_PRUNE_MS = 60 * 60_000;

/**
 * The same budget for an agent whose last words said it was waiting on another
 * agent. It stopped on purpose to let a peer finish, so pruning it on the
 * ordinary budget would throw away the one agent most likely to be messaged next.
 * Twice the ordinary grace, because the thing it waits for is another agent's
 * whole run.
 */
export const DEFAULT_SUBAGENT_WAITING_PRUNE_MS = 2 * 60 * 60_000;

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
				"Whether this session may use subagents at all. Off removes the task tool and every delegation instruction from the prompt, so nothing can be spawned. This is the only setting that takes the ability away: Subagent Delegation below decides how hard the model is PUSHED to delegate, never whether it may. Your delegation strength and your Roster are kept while this is off and take effect again when you turn it back on.",
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
			label: "Subagent Delegation",
			description:
				"How strongly this session routes work to the subagent types you enabled. Allowed leaves delegation available without prompting for it. Preferred asks for substantial eligible work to be delegated. Required adds a first-turn reminder. The enabled Roster is the routing policy: each name is a distinct type that owns only work matching its description, no type is a fallback for another, and work no enabled type covers stays with the main agent. Turn Subagents off above to remove delegation entirely.",
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
			// Advanced: it changes the tool's SCHEMA rather than any policy, so it is
			// a shape an integrator picks once, not a knob a session tunes.
			advanced: true,
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Subagents — which ones this session offers, how deep they may go, and what
	// they run. One section, because those are one decision: an operator turning
	// a specialist on immediately asks what it will run, and the answer used to
	// be two sections away under a heading of its own.
	// ────────────────────────────────────────────────────────────────────────
	/**
	 * Per-agent settings keyed by agent name; see {@link SubagentAgentSettings}.
	 *
	 * Rendered as a table of discovered agents rather than one control, so the
	 * settings row is a summary that opens the per-agent editor. This is the ONLY
	 * surface that edits these rows: the subagent dashboard (`/agents`) used to
	 * carry a second copy of the same table, and two editors over one setting is
	 * how the surfaces drifted apart before. The blanket depth limit each row
	 * inherits from sits in this same section for that reason: a spawn ceiling
	 * edited two sections apart from the overrides that outrank it is how an
	 * operator changes one and reads the other.
	 *
	 * IT IS ALSO THE ONLY PLACE A SUBAGENT MODEL IS CHOSEN. The same value used
	 * to be reachable from three screens — a `Subagent Model` row on this tab, a
	 * blanket `Model` row at the top of the roster, and each agent's own page —
	 * so the tab showed one model, the roster header showed the same one again,
	 * and the per-agent rows showed a third answer inherited from it. Whether a
	 * model is chosen once for everyone or once per agent is now a single
	 * question, {@link SUBAGENTS_SETTINGS}`["subagent.sharedModel"]`, asked at the
	 * top of the roster.
	 */
	"subagent.agents": {
		type: "record",
		default: {} as Record<string, SubagentAgentSettings>,
		ui: {
			tab: "subagents",
			group: "Subagents",
			label: "Roster",
			description:
				"Which subagent types the model may choose, and what each one runs. Enabled means the model can pick that subagent on its own; disabled means it cannot. With no row, only the general-purpose deep worker is enabled. Bundled specialists and subagents you add are opt-in through onboarding or this roster. Each subagent's page carries its own Model and Effort, and a Subagents chain naming what it may spawn in turn, level by level; unset anywhere follows the level above. Same Model for All Agents, at the top of the roster, switches those per-agent choices for one shared pair.",
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

	"subagent.maxNestedSpawnDepth": {
		type: "number",
		default: DEFAULT_SUBAGENT_MAX_NESTED_SPAWN_DEPTH,
		ui: {
			tab: "subagents",
			group: "Subagents",
			label: "Max Nested Spawn Depth",
			description:
				"How many nested levels subagents may spawn, for every level no roster chain decides. 0 still lets this session spawn direct subagents, but those children do not receive the task tool. Open Roster above, pick a subagent, then Subagents, to turn individual levels on or off for that one; this number answers from the first level its chain does not name.",
			keywords: ["depth", "nested", "recursion", "spawn", "roster"],
			options: SUBAGENT_RECURSION_DEPTH_OPTIONS,
		},
	},

	/**
	 * Whether one model answers for every agent, or each agent answers for
	 * itself. Off by default, because a roster exists to run different lanes on
	 * different models and a shared model makes the per-agent rows decorative.
	 *
	 * This is the toggle that collapsed three surfaces into one. It has no `ui`
	 * block on purpose: it is not a row on the tab, it is the FIRST row inside
	 * the roster page, rendered there by `settings-selector.ts` so the question
	 * and the rows it governs are on one screen. A row here would put the switch
	 * one screen away from the thing it greys out, which is the arrangement this
	 * change removes.
	 */
	"subagent.sharedModel": {
		type: "boolean",
		default: false,
	},

	/**
	 * The shared model chain, live only while `subagent.sharedModel` is on.
	 *
	 * No `ui` block: it renders inside the roster page, above the agent rows it
	 * overrides, and only when the toggle above is on. It used to be a row on
	 * this tab AND a row at the top of the roster, which is two of the three
	 * duplicate surfaces.
	 */
	"subagent.model": {
		type: "modelChain",
		default: undefined,
	},

	/**
	 * The shared effort, live only while `subagent.sharedModel` is on. Same
	 * reasoning as `subagent.model` above.
	 */
	"subagent.thinkingLevel": {
		type: "string",
		default: undefined,
	},

	"subagent.modelByDepth": {
		type: "record",
		default: {} as Record<string, string | string[]>,
		validateEntry: validateModelByDepthEntry,
		ui: {
			tab: "subagents",
			group: "Subagents",
			label: "Models by Depth",
			description:
				"Model chains chosen by spawn depth: depth 1 is a direct child, depth 2 a grandchild, and so on. A row applies only while Same Model for All Agents is off, outranks the agent's own frontmatter for a spawn at exactly that depth, and leaves every other depth alone. A row whose chain matches no model refuses the spawn and names the row.",
			keywords: ["subagent", "depth", "nested", "grandchild", "model", "chain"],
			// Advanced: a depth-keyed chain is a rare shape, and it outranks the row
			// above it, so it belongs behind the fold rather than beside the setting
			// most sessions use.
			advanced: true,
		},
	},

	"subagent.showResolvedModelBadge": {
		type: "boolean",
		default: true,
		ui: {
			tab: "subagents",
			group: "Subagents",
			label: "Show Resolved Model Badge",
			description:
				"Show each subagent's resolved model, and the setting that decided it, in the task widget status line and the agent surfaces.",
			advanced: true,
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
			// Stage ONE, and its own group. Park and prune answer different questions —
			// one releases the session, the other drops the row — and one shared "Auto
			// Close" group asked the operator to read three rows to find out which did
			// which. Parking is also NOT gated on the prune switch: it happens whether
			// or not the ref is eventually dropped, so hiding this row when pruning is
			// off would hide the only control over stage one.
			group: "Park",
			label: "Park After",
			description:
				"Stage one. How long a finished subagent stays live before it parks (ms). Parking releases the live session — the process, its MCP clients, its memory — and keeps everything else: the row stays in the roster and the agent rebuilds itself when messaged or opened. Counted from the agent's last activity, so a revived agent starts this budget again from the revival. 'Until exit' keeps idle agents live for the whole session.",
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

	"subagent.prune.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "subagents",
			group: "Prune",
			label: "Prune Parked Subagents",
			description:
				"Stage two, and a different thing from parking. Pruning takes a parked subagent out of the roster and gives up the ability to wake it; parking only released its session. Nothing on disk is touched: the transcript stays where it is and stays readable at `history://<agent>`. Off keeps every parked subagent listed and wakeable until you exit.",
		},
	},

	"subagent.prune.afterMs": {
		type: "number",
		default: DEFAULT_SUBAGENT_PRUNE_MS,
		ui: {
			tab: "subagents",
			group: "Prune",
			label: "Prune After",
			description:
				"How long a parked subagent stays in the roster before it is pruned (ms). Counted from its last activity, so a subagent read back from a previous run is judged on when its transcript was last written rather than on when this session found it.",
			options: [
				{ value: "900000", label: "15 minutes" },
				{ value: "1800000", label: "30 minutes" },
				{ value: "3600000", label: "1 hour", description: "Default" },
				{ value: "14400000", label: "4 hours" },
				{ value: "86400000", label: "1 day" },
			],
			condition: "subagentPruneEnabled",
		},
	},

	"subagent.prune.waitingAfterMs": {
		type: "number",
		default: DEFAULT_SUBAGENT_WAITING_PRUNE_MS,
		ui: {
			tab: "subagents",
			group: "Prune",
			label: "Prune After While Waiting",
			description:
				"The same budget for a subagent whose last message said it was waiting on another agent (ms). It stopped on purpose to let a peer finish, so it keeps its row longer than one that simply went quiet: pruning it on the ordinary budget would drop the agent you are most likely to message next. Set it equal to Prune After to treat both the same; a shorter value is raised to it.",
			options: [
				{ value: "3600000", label: "1 hour" },
				{ value: "7200000", label: "2 hours", description: "Default" },
				{ value: "14400000", label: "4 hours" },
				{ value: "86400000", label: "1 day" },
			],
			condition: "subagentPruneEnabled",
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
			// Only reachable behaviour while a budget exists: with the guard disabled
			// there is no crossing to announce, so the row is hidden rather than
			// shown doing nothing.
			condition: "subagentSoftRequestBudgetEnabled",
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
			// Isolation is off by default, and these two decide only how an isolated
			// run's changes come back. A knob for a mode nobody selected is a knob
			// that reads as broken, so both hide until a backend is chosen.
			condition: "subagentIsolationEnabled",
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
			condition: "subagentIsolationEnabled",
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
