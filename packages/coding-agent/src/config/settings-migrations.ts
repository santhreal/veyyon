/**
 * Every field-level migration the product applies to a raw settings tree, in the
 * order they run.
 *
 * They live here rather than in `config/settings.ts` because that module is the
 * one ~530 test files and most of the product import for a value, while this is
 * a one-way transformation of a tree read off disk: nothing at run time calls it
 * except the store's load path, and adding a migration should not touch the
 * module every consumer of a setting reaches.
 *
 * A migration here runs on EVERY load of EVERY source (global, project,
 * `--config` overlays, runtime overrides), so it must be a fixed point on its
 * own output. One that cannot be — one that cannot tell an old encoding from a
 * value the operator typed — belongs in `migrateOwnedConfigOnce` instead, which
 * runs once against the config an instance owns.
 */

import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import { deleteByPath, getByPath, type RawSettings, setByPath } from "@veyyon/kernel/settings/store";
import * as logger from "@veyyon/utils/logger";
import { isRecord } from "@veyyon/utils/type-guards";
import type { HelperId } from "../task/helper-settings";
import { isLightTheme } from "../theme/theme-luminance";
import { normalizeToolName } from "../tools/core/builtin-names";
import { type CompactionStrategySetting, migrateCompactionStrategyValue } from "./compaction-strategy";

/**
 * `value` when it is a mapping a migration can read and write, else undefined. A config file is
 * hand-editable, so a group node such as `tools` or `providers` can hold a scalar; an `in` test
 * or a property write on one throws, and a throw here quarantines the whole file.
 */
function recordAt(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

/**
 * Largest `ask.timeout` read as seconds. Anything above it is taken to be a
 * millisecond value from the config format that predates the switch to seconds.
 *
 * There is no marker on disk saying which format a file uses, so the magnitude
 * is the only signal available. 1000 seconds is a bit under 17 minutes: far
 * longer than any timeout the settings UI offers, and far shorter than the
 * 15000-120000 that a millisecond-era file actually contained. The cost of the
 * guess falls on a user who wanted a longer wait than that, which is why the
 * rewrite is reported rather than applied quietly.
 */
export const MAX_ASK_TIMEOUT_SECONDS = 1000;

/**
 * What a migration needs from the store that owns it: a slot to hand back the
 * `lastChangelogVersion` it strips, and the one-shot report for the `ask.timeout`
 * rewrite, which is a guess rather than a fixed point.
 */
export interface RawSettingsMigrationContext {
	legacyLastChangelogVersion?: string;
	reportAskTimeoutRewrite(from: number, to: number): void;
}

/**
 * A raw settings tree read and rewritten through every spelling a legacy key can have on disk.
 *
 * Every value in a settings source is NESTED — the loader builds the tree
 * with `setByPath` and `get` reads it back segment by segment — so a dotted
 * key written at the top level here would be stored but never read. That is
 * not theoretical: writing `raw["agent.delegation"]` made the agent
 * migration a no-op, and only a test that loaded a legacy config and read the
 * new setting back caught it. A legacy key is still READ in any spelling:
 * nested, flat, or split between the two at any segment.
 */
class LegacySettingsKeys {
	readonly raw: RawSettings;

	constructor(raw: RawSettings) {
		this.raw = raw;
	}

	read(segments: readonly string[]): unknown {
		const nested = getByPath(this.raw, segments);
		if (nested !== undefined) return nested;
		const flat = this.raw[segments.join(".")];
		if (flat !== undefined) return flat;
		for (let i = 1; i < segments.length; i++) {
			const value = this.#readSplitAt(segments, i);
			if (value !== undefined) return value;
		}
		return undefined;
	}

	/** Read a legacy key and delete it in every spelling. */
	take(segments: readonly string[]): unknown {
		const value = this.read(segments);
		if (value === undefined) return undefined;
		deleteByPath(this.raw, segments);
		delete this.raw[segments.join(".")];
		for (let i = 1; i < segments.length; i++) {
			const head = segments.slice(0, i);
			const tail = segments.slice(i);
			const parent = getByPath(this.raw, head);
			if (isRecord(parent)) delete parent[tail.join(".")];
			const flatParent = this.raw[head.join(".")];
			if (isRecord(flatParent)) deleteByPath(flatParent, tail);
		}
		return value;
	}

	/**
	 * Set `agent.<key>`. An explicit new-key value already on disk is authoritative: an operator
	 * who has set the new setting is never overwritten by a stale legacy key.
	 */
	setAgent(key: readonly string[], value: unknown): void {
		if (value === undefined) return;
		if (this.read(["agent", ...key]) !== undefined) return;
		setByPath(this.raw, ["agent", ...key], value);
	}

	/** A key written nested down to segment `i` and flat after it, or flat down to `i` and nested after. */
	#readSplitAt(segments: readonly string[], i: number): unknown {
		const head = segments.slice(0, i);
		const tail = segments.slice(i);
		const parent = getByPath(this.raw, head);
		if (isRecord(parent)) {
			const value = parent[tail.join(".")];
			if (value !== undefined) return value;
		}
		const flatParent = this.raw[head.join(".")];
		return isRecord(flatParent) ? getByPath(flatParent, tail) : undefined;
	}
}

/**
 * Fold flat modelRoles.<role> into raw.modelRoles so both modelRoles.task migration
 * and surviving modelRoles (e.g. modelRoles.default) see a unified modelRoles tree.
 */
function foldFlatModelRoles(raw: RawSettings): void {
	for (const key of Object.keys(raw)) {
		if (!key.startsWith("modelRoles.")) continue;
		const role = key.slice("modelRoles.".length);
		if (!role) continue;
		const existing = isRecord(raw.modelRoles) ? raw.modelRoles : {};
		if (!(role in existing)) existing[role] = raw[key];
		raw.modelRoles = existing;
		delete raw[key];
	}
}

/**
 * The area itself was `subagent.*` before it was `agent.*`. Fold it first,
 * leaf for leaf, so the older migrations below see one tree: a legacy
 * `subagent.isolation.mode` becomes `agent.isolation.mode` here. `advisor.subagents`
 * and `argot.subagents` moved with it; `tier.subagent` is folded with the other
 * tier keys by the tier migration.
 */
function foldSubagentArea(keys: LegacySettingsKeys): void {
	const { raw } = keys;
	const fold = (node: unknown, path: string[]): void => {
		if (!isRecord(node)) {
			keys.setAgent(path, node);
			return;
		}
		for (const [key, value] of Object.entries(node)) {
			fold(value, path.concat(key.includes(".") ? key.split(".") : key));
		}
	};
	if (isRecord(raw.subagent)) {
		fold(raw.subagent, []);
		delete raw.subagent;
	}
	for (const key of Object.keys(raw)) {
		if (!key.startsWith("subagent.")) continue;
		const leaf = key.slice("subagent.".length);
		if (!leaf) continue;
		fold(raw[key], leaf.split("."));
		delete raw[key];
	}
	for (const area of ["advisor", "argot"] as const) {
		const value = keys.take([area, "subagents"]);
		if (value !== undefined && keys.read([area, "agents"]) === undefined) setByPath(raw, [area, "agents"], value);
	}
}

function migrateDelegation(keys: LegacySettingsKeys): void {
	const eager = keys.take(["task", "eager"]);
	if (typeof eager === "string") {
		// `task.eager` had three values and all three still delegate, so the old
		// bottom value lands on `allowed`: someone with eager delegation switched
		// off still delegated by hand, and taking the task tool away would change
		// what their sessions can do.
		const delegation = eager === "always" ? "required" : eager === "preferred" ? "preferred" : "allowed";
		keys.setAgent(["delegation"], delegation);
	}

	// `agent.delegation: off` was the kill switch before `agent.enabled`
	// existed, so one setting answered two questions: whether agents exist, and
	// how hard to push them. Someone who wrote `off` was turning agents OFF —
	// that is the half to preserve — so it becomes `enabled: false` and the
	// strength falls back to its default, ready for when they turn it back on.
	// Deleted rather than left in place because `off` is no longer a legal value:
	// leaving it would fail validation and read as a corrupt config.
	if (keys.read(["agent", "delegation"]) === "off") {
		deleteByPath(keys.raw, ["agent", "delegation"]);
		delete keys.raw["agent.delegation"];
		if (keys.read(["agent", "enabled"]) === undefined) {
			setByPath(keys.raw, ["agent", "enabled"], false);
		}
	}
}

/** `task.*` scalars that moved to `agent.*` unchanged, as `[legacy, next]` leaf names. */
const TASK_SCALAR_KEYS = [
	["batch", "batch"],
	["maxConcurrency", "maxConcurrency"],
	["enableLsp", "enableLsp"],
	["maxRuntimeMs", "maxRuntimeMs"],
	["agentIdleTtlMs", "idleTtlMs"],
	["softRequestBudget", "softRequestBudget"],
	["softRequestBudgetNotice", "softRequestBudgetNotice"],
	["showResolvedModelBadge", "showResolvedModelBadge"],
] as const;

/**
 * Spawned agents once had a stage after sleep that dropped them from the roster, set by
 * `agent.prune.*` and before that `agent.autoClose.*`. An agent is never dropped now, so
 * those keys decide nothing and are deleted in every spelling, with the containers they
 * leave empty.
 */
const RETIRED_AGENT_SECTIONS = ["prune", "autoClose"] as const;
const RETIRED_AGENT_SECTION_LEAVES = ["enabled", "afterMs", "waitingAfterMs", "parkedMs", "waitingMs"] as const;

function migrateRenamedScalars(keys: LegacySettingsKeys): void {
	for (const [legacy, next] of TASK_SCALAR_KEYS) {
		keys.setAgent([next], keys.take(["task", legacy]));
	}
	for (const section of RETIRED_AGENT_SECTIONS) {
		for (const leaf of RETIRED_AGENT_SECTION_LEAVES) keys.take(["agent", section, leaf]);
		if (keys.read(["agent", section]) !== undefined) deleteByPath(keys.raw, ["agent", section]);
		delete keys.raw[`agent.${section}`];
	}
}

/**
 * The old depth counted the root as level 1. The replacement counts only
 * nested agent levels, so old 1 becomes new 0. Old 0 disabled even the
 * root task tool; preserve that behavior through the dedicated master
 * switch. Both legacy paths are consumed, with the newer agent path
 * winning when a file somehow contains both.
 */
function migrateRecursionDepth(keys: LegacySettingsKeys): void {
	const legacyTaskDepth = keys.take(["task", "maxRecursionDepth"]);
	const legacyAgentDepth = keys.take(["agent", "maxRecursionDepth"]);
	const legacyDepth = legacyAgentDepth ?? legacyTaskDepth;
	if (legacyDepth === undefined) return;
	if (legacyDepth === 0) keys.setAgent(["enabled"], false);
	const nestedDepth =
		typeof legacyDepth === "number" && Number.isInteger(legacyDepth)
			? legacyDepth < 0
				? -1
				: Math.max(0, legacyDepth - 1)
			: legacyDepth;
	keys.setAgent(["maxNestedSpawnDepth"], nestedDepth);
}

/** task.isolation.* -> agent.isolation.* */
function migrateIsolation(keys: LegacySettingsKeys): void {
	for (const key of ["mode", "merge", "commits"] as const) {
		keys.setAgent(["isolation", key], keys.take(["task", "isolation", key]));
	}
	const isolationMode = keys.read(["agent", "isolation", "mode"]);
	if (typeof isolationMode !== "string") return;
	const mapped = LEGACY_ISOLATION_MODES[isolationMode];
	if (mapped !== undefined) {
		setByPath(keys.raw, ["agent", "isolation", "mode"], mapped);
	}
}

/**
 * The two agent-keyed maps become one row per agent. Two parallel maps meant
 * two lookups that could disagree, which is how an agent could read as off on
 * one surface while a model override for it lived on invisibly.
 */
function migrateAgentRows(keys: LegacySettingsKeys): void {
	const agents: Record<string, Record<string, unknown>> = {};
	const disabled = keys.take(["task", "disabledAgents"]);
	if (Array.isArray(disabled)) {
		for (const name of disabled) {
			if (typeof name !== "string" || !name.trim()) continue;
			agents[name.trim()] = { ...(agents[name.trim()] ?? {}), enabled: false };
		}
	}
	reportDroppedAgentModelOverrides(keys.take(["task", "agentModelOverrides"]));
	// `disabledAgents` is the only legacy map with a home in the new section, so a
	// row written here carries exactly one fact: whether the agent runs.
	if (Object.keys(agents).length > 0) keys.setAgent(["agents"], agents);
}

/**
 * Per-agent models are NOT carried over. They were a third owner of the
 * agent model question, above the blanket setting and invisible from it,
 * and they are gone; writing them into the new section would only recreate
 * the drift in a new spelling. Folding them into `agent.model` instead is
 * not available either — several agents could name several models and there
 * is no honest way to pick one. So the values are dropped and named, once,
 * with the setting that replaced them.
 */
function reportDroppedAgentModelOverrides(overrides: unknown): void {
	if (!isRecord(overrides)) return;
	const dropped = Object.entries(overrides)
		.filter(([, model]) => typeof model === "string" && model.trim().length > 0)
		.map(([name, model]) => `${name}=${String(model).trim()}`);
	if (dropped.length === 0) return;
	logger.warn(
		`Settings: task.agentModelOverrides (${dropped.join(", ")}) is no longer read — a per-agent model ` +
			`is set on that agent's own page. Open Agents → Roster, pick the agent, and set its Model, or ` +
			`give the agent file its own \`model:\` frontmatter.`,
		{ setting: "task.agentModelOverrides", dropped },
	);
}

/**
 * modelRoles.task was the "model for agents" knob before this section
 * existed. It folds into the blanket agent model AND the role entry goes:
 * leaving it would restore two owners for one value, with role expansion
 * answering first, which is exactly why an agent model setting used to have
 * no effect.
 */
function migrateTaskRoleModel(keys: LegacySettingsKeys): void {
	const legacyRoleModel = keys.take(["modelRoles", "task"]);
	if (typeof legacyRoleModel === "string" && legacyRoleModel.trim()) {
		keys.setAgent(["model"], legacyRoleModel.trim());
	}
	const { raw } = keys;
	if (isRecord(raw.modelRoles) && Object.keys(raw.modelRoles).length === 0) delete raw.modelRoles;
}

/**
 * Leave no empty husk behind: a surviving `task: {}` block is a second place
 * to look for settings that no longer live there.
 */
function dropEmptyTaskSection(raw: RawSettings): void {
	if (isRecord(raw.task) && Object.keys(raw.task).length === 0) delete raw.task;
	const isolation = getByPath(raw, ["task", "isolation"]);
	if (isRecord(isolation) && Object.keys(isolation).length === 0) {
		deleteByPath(raw, ["task", "isolation"]);
		if (isRecord(raw.task) && Object.keys(raw.task).length === 0) delete raw.task;
	}
}

/**
 * Fold every retired agent key onto the `agent.*` area, in place.
 *
 * Runs on every read of a settings source, so it must be a FIXED POINT:
 * applying it to its own output changes nothing. That holds because each
 * legacy key is deleted after it is folded, and an already-present new value
 * always wins (an operator who has set the new key is never overwritten by a
 * stale legacy one).
 *
 * `task.eager` mapped three values onto delegation strength; the new
 * `agent.delegation` adds `off` at the bottom, so `default` becomes
 * `allowed` and `always` becomes `required`. `task.disabledAgents` becomes one
 * row per agent in `agent.agents`; `task.agentModelOverrides` named a per-agent
 * model, which no longer exists as a concept, so it is dropped with a report
 * rather than folded into a row nothing reads.
 */
function migrateAgentSettings(raw: RawSettings): void {
	const keys = new LegacySettingsKeys(raw);
	foldFlatModelRoles(raw);
	foldSubagentArea(keys);
	migrateDelegation(keys);
	migrateRenamedScalars(keys);
	migrateRecursionDepth(keys);
	migrateIsolation(keys);
	migrateAgentRows(keys);
	migrateTaskRoleModel(keys);
	dropEmptyTaskSection(raw);
}

/** One field-level migration, applied in place to a raw settings tree. */
type RawSettingsMigration = (raw: RawSettings, context: RawSettingsMigrationContext) => void;

/** queueMode -> steeringMode */
function migrateQueueMode(raw: RawSettings): void {
	if ("queueMode" in raw && !("steeringMode" in raw)) {
		raw.steeringMode = raw.queueMode;
		delete raw.queueMode;
	}
}

function dropChangelogKeys(raw: RawSettings, context: RawSettingsMigrationContext): void {
	// lastChangelogVersion moved out of config.yml into the
	// <agentDir>/last-changelog-version marker file so version bumps no
	// longer dirty user-tracked configs. Capture for marker seeding (see
	// #seedLastChangelogVersionMarker), then strip the key — the next
	// config save drops it from disk.
	if (typeof raw.lastChangelogVersion === "string") {
		context.legacyLastChangelogVersion ??= raw.lastChangelogVersion;
	}
	delete raw.lastChangelogVersion;

	// collapseChangelog gated how much of the changelog startup dumped into the
	// terminal. Startup no longer prints release notes at all — it prints one
	// line and `/changelog` opens them on the web — so the old key has no
	// behavior left to control. Drop it rather than leave a toggle that does
	// nothing; `startup.updateNotice` governs the line that replaced it.
	delete raw.collapseChangelog;
}

/**
 * ask.timeout: ms -> seconds, guessed from the magnitude of the value.
 *
 * Every other migration here is a fixed point: re-running it on its own
 * output changes nothing, which is what lets {@link migrateRawSettings} run on
 * every read. This one is not. It cannot be, because 2000 in the file is either
 * 2000 milliseconds from the old format or 2000 seconds from the new one
 * and nothing on disk says which. So a user who legitimately wants a
 * 33-minute timeout gets 2 seconds instead, and an ask they expected to
 * wait for them auto-selects almost immediately.
 *
 * The conversion stays, because silently keeping an old ms value would
 * make the same setting wrong in the other direction for far more users.
 * What changes is that it is no longer silent: a rewrite the user did not
 * ask for is reported with both values so they can see what happened and
 * set it in seconds if the guess was wrong.
 */
function migrateAskTimeout(raw: RawSettings, context: RawSettingsMigrationContext): void {
	const ask = recordAt(raw.ask);
	if (!ask || typeof ask.timeout !== "number") return;
	const oldValue = ask.timeout;
	if (oldValue > MAX_ASK_TIMEOUT_SECONDS) {
		const converted = Math.round(oldValue / 1000);
		ask.timeout = converted;
		context.reportAskTimeoutRewrite(oldValue, converted);
	}
}

/**
 * compaction.thresholdTokens / compaction.thresholdPercent -> compaction.threshold
 *
 * Two keys wrote one axis with an invisible precedence. Fold them into the one
 * key HERE, on load, so the ambiguity leaves the file: an absolute amount
 * becomes a bare token count, a percent becomes `85%`, and the retired keys are
 * dropped. Precedence matches the old resolver (tokens, then percent), so the
 * trigger point does not move. A `threshold` already present always wins and
 * the retired keys are dropped without being read, which is what makes this a
 * fixed point — re-running it on its own output changes nothing.
 *
 * `withLegacyCompactionThreshold` still folds them at read time, for config
 * sources this never rewrites (project files, `--config` overlays, and
 * non-persisting instances).
 */
function migrateCompactionThreshold(raw: RawSettings): void {
	const compaction = recordAt(raw.compaction);
	const legacyTokens = compaction?.thresholdTokens ?? raw["compaction.thresholdTokens"];
	const legacyPercent = compaction?.thresholdPercent ?? raw["compaction.thresholdPercent"];
	if (legacyTokens === undefined && legacyPercent === undefined) return;
	const currentThreshold = compaction?.threshold ?? raw["compaction.threshold"];
	if (currentThreshold === undefined) {
		if (typeof legacyTokens === "number" && Number.isFinite(legacyTokens) && legacyTokens > 0) {
			setByPath(raw, ["compaction", "threshold"], String(legacyTokens));
		} else if (typeof legacyPercent === "number" && Number.isFinite(legacyPercent) && legacyPercent > 0) {
			setByPath(raw, ["compaction", "threshold"], `${legacyPercent}%`);
		}
	}
	if (compaction) {
		delete compaction.thresholdTokens;
		delete compaction.thresholdPercent;
	}
	delete raw["compaction.thresholdTokens"];
	delete raw["compaction.thresholdPercent"];
}

/** Migrate old flat "theme" string to nested theme.dark/theme.light */
function migrateFlatTheme(raw: RawSettings): void {
	if (typeof raw.theme !== "string") return;
	const oldTheme = raw.theme;
	if (oldTheme === "light" || oldTheme === "dark") {
		// Built-in defaults — just remove, let new defaults apply
		delete raw.theme;
	} else {
		// Custom theme — detect luminance to place in correct slot
		const slot = isLightTheme(oldTheme) ? "light" : "dark";
		raw.theme = { [slot]: oldTheme };
	}
}

/**
 * task.isolation.mode: legacy values from before the veyyon-iso PAL refactor.
 * `worktree` was git worktree → now lives under `rcopy`. `fuse-overlay`
 * and `fuse-projfs` are now the platform-named `overlayfs` / `projfs`
 * kinds; the PAL falls back internally when the chosen one isn't
 * available, so we don't need the old TS-side platform guards.
 */
const LEGACY_ISOLATION_MODES: Readonly<Record<string, string>> = {
	worktree: "rcopy",
	"fuse-overlay": "overlayfs",
	"fuse-projfs": "projfs",
};

/** task.isolation.enabled (boolean) -> task.isolation.mode (enum), and legacy mode names to current ones. */
function migrateTaskIsolation(raw: RawSettings): void {
	const isolationObj = recordAt(recordAt(raw.task)?.isolation);
	if (isolationObj && "enabled" in isolationObj) {
		if (typeof isolationObj.enabled === "boolean" && isolationObj.mode === undefined) {
			isolationObj.mode = isolationObj.enabled ? "auto" : "none";
		}
		delete isolationObj.enabled;
	}
	if (typeof raw["task.isolation.enabled"] === "boolean") {
		if (raw["task.isolation.mode"] === undefined) {
			raw["task.isolation.mode"] = raw["task.isolation.enabled"] ? "auto" : "none";
		}
		delete raw["task.isolation.enabled"];
	}
	if (isolationObj && typeof isolationObj.mode === "string") {
		const mapped = LEGACY_ISOLATION_MODES[isolationObj.mode];
		if (mapped !== undefined) isolationObj.mode = mapped;
	}
	if (typeof raw["task.isolation.mode"] === "string") {
		const mapped = LEGACY_ISOLATION_MODES[raw["task.isolation.mode"]];
		if (mapped !== undefined) raw["task.isolation.mode"] = mapped;
	}
}

function migrateTaskFlags(raw: RawSettings): void {
	const taskObj = recordAt(raw.task);
	// task.simple: removed — the task tool no longer accepts a per-call
	// schema (workflows drive structured output via eval agent()) and the
	// batch/context shape is gated by task.batch instead.
	if (taskObj && "simple" in taskObj) {
		delete taskObj.simple;
	}
	delete raw["task.simple"];

	// task.eager / todo.eager: boolean -> enum (default | preferred | always).
	// `true` reproduced the previous "on" behavior, which is now `always`.
	if (taskObj && typeof taskObj.eager === "boolean") {
		taskObj.eager = taskObj.eager ? "always" : "default";
	}
	if (typeof raw["task.eager"] === "boolean") {
		raw["task.eager"] = raw["task.eager"] ? "always" : "default";
	}
	const todoObj = recordAt(raw.todo);
	if (todoObj && typeof todoObj.eager === "boolean") {
		todoObj.eager = todoObj.eager ? "always" : "default";
	}
}

/** An `edit.mode` variant that was removed and now maps back to "hashline". */
function isRetiredEditMode(mode: unknown): boolean {
	return mode === "atom" || mode === "vim";
}

/** edit.mode and edit.modelVariants: removed "atom" and "vim" variants map back to "hashline". */
function retireEditModeVariants(editObj: Record<string, unknown>): void {
	if (isRetiredEditMode(editObj.mode)) editObj.mode = "hashline";
	const modelVariants = editObj.modelVariants;
	if (!isRecord(modelVariants)) return;
	for (const [pattern, variant] of Object.entries(modelVariants)) {
		if (isRetiredEditMode(variant)) modelVariants[pattern] = "hashline";
	}
}

function migrateEditSettings(raw: RawSettings): void {
	const editObj = recordAt(raw.edit);
	if (editObj) retireEditModeVariants(editObj);

	// edit.critiqueCodeMutations: boolean -> the edit.afterEdit enum, which
	// selects one after-edit pass instead of stacking the review on top of a
	// verification pass that had no setting at all. `true` asked for the
	// review; `false` is what everyone was getting, which is the verify pass.
	// Both spellings are read: the legacy key has left the schema, so the
	// dotted-key expansion no longer folds the flat one into the tree.
	// Idempotent: each spelling is deleted once it has been read.
	const legacyCritique = editObj?.critiqueCodeMutations ?? raw["edit.critiqueCodeMutations"];
	if (typeof legacyCritique === "boolean") {
		const editRoot = editObj ?? {};
		if (!("afterEdit" in editRoot)) editRoot.afterEdit = legacyCritique ? "review" : "verify";
		raw.edit = editRoot;
	}
	if (editObj) delete editObj.critiqueCodeMutations;
	delete raw["edit.critiqueCodeMutations"];
}

/**
 * compaction.strategy: collapse every legacy strategy to summary. `off` was a kill switch that won over
 * `enabled: true`, and `enabled` is now the only off switch, so `off` writes `enabled: false`.
 */
function migrateCompactionStrategy(raw: RawSettings): void {
	const compactionObj = recordAt(raw.compaction);
	if (!compactionObj) return;
	if (compactionObj.strategy === "off") {
		compactionObj.strategy = "summary";
		compactionObj.enabled = false;
	} else if (typeof compactionObj.strategy === "string") {
		const migrated: CompactionStrategySetting | undefined = migrateCompactionStrategyValue(compactionObj.strategy);
		if (migrated) compactionObj.strategy = migrated;
	}
	if (compactionObj.compactionModel !== undefined && compactionObj.model === undefined) {
		compactionObj.model = compactionObj.compactionModel;
		delete compactionObj.compactionModel;
	}
}

function migrateCompactionModel(raw: RawSettings): void {
	// `compaction.compactionModel` is a RETIRED key, so it survives the dotted-key
	// expansion above (only registered paths are expanded) and both spellings of it
	// still have to be folded. The destination is always nested: a flat
	// `compaction.model` would be written into the tree and then never read.
	const legacyFlatCompactionModel = raw["compaction.compactionModel"];
	if (legacyFlatCompactionModel !== undefined && getByPath(raw, ["compaction", "model"]) === undefined) {
		setByPath(raw, ["compaction", "model"], legacyFlatCompactionModel);
		delete raw["compaction.compactionModel"];
	}
	if (typeof raw.compactionModel === "string" && getByPath(raw, ["compaction", "model"]) === undefined) {
		setByPath(raw, ["compaction", "model"], raw.compactionModel);
		delete raw.compactionModel;
	}

	const modelOverrides = raw.modelOverrides as Record<string, Record<string, unknown>> | undefined;
	if (modelOverrides && getByPath(raw, ["compaction", "model"]) === undefined) {
		for (const entry of Object.values(modelOverrides)) {
			const compactionModel = entry?.compactionModel;
			if (typeof compactionModel === "string" && compactionModel.trim()) {
				setByPath(raw, ["compaction", "model"], compactionModel);
				break;
			}
		}
	}
}

/** Every name `modelRoles` shipped with. Any other key under it was a custom role. */
const BUILT_IN_ROLES: ReadonlySet<string> = new Set([
	"default",
	"interactive",
	"smol",
	"slow",
	"vision",
	"plan",
	"commit",
	"tiny",
	"advisor",
]);

/**
 * The roles each helper read before helpers had their own row, in the order it
 * tried them. The first one set becomes the helper's model. An empty list is a
 * helper no role ever configured.
 */
const HELPER_ROLE_SOURCES: Readonly<Record<HelperId, readonly string[]>> = {
	advisor: ["advisor"],
	plan: ["plan"],
	vision: ["vision"],
	commit: ["commit", "smol"],
	title: ["tiny", "commit", "smol"],
	memory: ["tiny", "smol"],
	autoThinking: ["tiny", "smol"],
	unexpectedStop: ["tiny", "smol"],
	speech: ["tiny", "smol"],
	completion: [],
};

/** Every role a helper inherits from. A role outside this set and not `default` has no successor. */
const ROLES_WITH_A_HELPER: ReadonlySet<string> = new Set(Object.values(HELPER_ROLE_SOURCES).flat());

/** A `:level` thinking suffix a role reference or a stored pattern may end in. */
const THINKING_SUFFIXES: ReadonlySet<string> = new Set([
	...Object.values(ThinkingLevel).filter(level => level !== ThinkingLevel.Inherit),
	"auto",
]);

/** Settings whose value is a model chain that could name a role. */
const MODEL_CHAIN_PATHS: readonly (readonly string[])[] = [
	["agent", "model"],
	["agent", "sharedModel"],
	["compaction", "model"],
	["prewalk", "cheapModel"],
	["prewalk", "strongModel"],
	["composer", "predictions", "model"],
	["enabledModels"],
];

/** A chain value as its ordered patterns: a comma string and a list are the same chain. */
function modelPatternList(value: unknown): string[] {
	const parts =
		typeof value === "string"
			? value.split(",")
			: Array.isArray(value)
				? value.flatMap(entry => (typeof entry === "string" ? entry.split(",") : []))
				: [];
	return parts.map(part => part.trim()).filter(Boolean);
}

function withoutThinkingSuffix(pattern: string): string {
	const colon = pattern.lastIndexOf(":");
	return colon >= 0 && THINKING_SUFFIXES.has(pattern.slice(colon + 1)) ? pattern.slice(0, colon) : pattern;
}

/**
 * The role a pattern referred to: `@role`, the legacy `pi/role` when `role` was
 * a role, or a bare `*` for the default role, each optionally `:level`.
 */
function roleReference(
	pattern: string,
	roles: ReadonlyMap<string, string[]>,
): { role: string; level: string | undefined } | undefined {
	const base = withoutThinkingSuffix(pattern);
	const level = base === pattern ? undefined : pattern.slice(base.length + 1);
	if (base === "*") return { role: "default", level };
	if (base.startsWith("@")) return { role: base.slice(1), level };
	if (!base.startsWith("pi/")) return undefined;
	const role = base.slice("pi/".length);
	return roles.has(role) || BUILT_IN_ROLES.has(role) ? { role, level } : undefined;
}

/**
 * Replace every role reference in a chain with the role's own patterns. A
 * reference to a role that is unset, or that leads back to itself, has no model
 * to stand for and is dropped into `dropped`. A `:level` on the reference
 * replaces the level stored on the role, as role expansion did.
 */
function expandRoleReferences(
	patterns: readonly string[],
	roles: ReadonlyMap<string, string[]>,
	visiting: readonly string[],
	dropped: Set<string>,
): string[] {
	const expanded: string[] = [];
	for (const pattern of patterns) {
		const reference = roleReference(pattern, roles);
		if (!reference) {
			expanded.push(pattern);
			continue;
		}
		const role = reference.role === "interactive" ? "default" : reference.role;
		const target = roles.get(role);
		if (!target || visiting.includes(role)) {
			dropped.add(pattern);
			continue;
		}
		const inner = expandRoleReferences(target, roles, [...visiting, role], dropped);
		const { level } = reference;
		expanded.push(...(level ? inner.map(entry => `${withoutThinkingSuffix(entry)}:${level}`) : inner));
	}
	return expanded;
}

function chainValue(patterns: readonly string[]): string | string[] {
	return patterns.length === 1 ? patterns[0] : [...patterns];
}

/** Rewrite one chain setting in place when it names a role, keeping its string or list shape. */
function expandChainAt(raw: RawSettings, path: readonly string[], expand: (patterns: string[]) => string[]): void {
	const value = getByPath(raw, path);
	const patterns = modelPatternList(value);
	const expanded = expand(patterns);
	if (expanded.length === patterns.length && expanded.every((pattern, i) => pattern === patterns[i])) return;
	if (expanded.length === 0) deleteByPath(raw, path);
	else setByPath(raw, path, Array.isArray(value) ? expanded : expanded.join(","));
}

/**
 * `modelRoles`, `cycleOrder` and `modelTags` -> `defaultModel` and `agent.helpers`.
 *
 * Roles were a second vocabulary for "which model": a table of named slots that
 * other settings referred to as `@role`. The session's model is `defaultModel`
 * now, and each feature that ran on a role has its own row under
 * `agent.helpers`, so the role table goes and every `@role` reference is
 * replaced by the patterns it stood for. A helper takes the first role set in
 * the order it used to read them; an `agent.helpers` model already on disk wins.
 * `slow`, custom roles, `cycleOrder`, `modelTags`, unresolvable references and
 * role-keyed retry fallback chains have no successor: they are dropped and
 * reported. `mnemopi.llmMode: smol`, which named the role it ran on, becomes
 * `online`, the `memory` helper.
 *
 * A fixed point: the role table is deleted, and every reference is either
 * expanded or dropped, so a second pass finds nothing to do.
 */
function migrateModelRoles(raw: RawSettings): void {
	const roles = new Map<string, string[]>();
	const table = raw.modelRoles;
	if (isRecord(table)) {
		for (const [role, value] of Object.entries(table)) {
			const patterns = modelPatternList(value);
			if (patterns.length === 0) continue;
			const slot = role === "interactive" ? "default" : role;
			if (role === "interactive" && roles.has(slot)) continue;
			roles.set(slot, patterns);
		}
	}
	const dropped = new Set<string>();
	const expand = (patterns: string[]): string[] => expandRoleReferences(patterns, roles, [], dropped);

	if (table !== undefined) {
		const defaultPatterns = roles.get("default");
		if (defaultPatterns && raw.defaultModel === undefined) {
			const expanded = expandRoleReferences(defaultPatterns, roles, ["default"], dropped);
			if (expanded.length > 0) raw.defaultModel = chainValue(expanded);
		}
		for (const [helper, sources] of Object.entries(HELPER_ROLE_SOURCES)) {
			const source = sources.find(role => roles.has(role));
			if (source === undefined || getByPath(raw, ["agent", "helpers", helper, "model"]) !== undefined) continue;
			const expanded = expandRoleReferences(roles.get(source) ?? [], roles, [source], dropped);
			if (expanded.length > 0) setByPath(raw, ["agent", "helpers", helper, "model"], chainValue(expanded));
		}
		for (const [role, patterns] of roles) {
			if (role !== "default" && !ROLES_WITH_A_HELPER.has(role))
				dropped.add(`modelRoles.${role}=${patterns.join(",")}`);
		}
		delete raw.modelRoles;
	}
	for (const key of ["cycleOrder", "modelTags"] as const) {
		if (raw[key] === undefined) continue;
		dropped.add(key);
		delete raw[key];
	}
	if (getByPath(raw, ["mnemopi", "llmMode"]) === "smol") setByPath(raw, ["mnemopi", "llmMode"], "online");

	for (const path of MODEL_CHAIN_PATHS) expandChainAt(raw, path, expand);
	const agents = getByPath(raw, ["agent", "agents"]);
	if (isRecord(agents)) {
		for (const name of Object.keys(agents)) expandChainAt(raw, ["agent", "agents", name, "model"], expand);
	}
	const chains = getByPath(raw, ["retry", "fallbackChains"]);
	if (isRecord(chains)) {
		for (const key of Object.keys(chains)) {
			const isRoleKey = !key.includes("/") && key !== "default" && (BUILT_IN_ROLES.has(key) || roles.has(key));
			if (key === "interactive" && chains.default === undefined) {
				chains.default = chains.interactive;
				delete chains.interactive;
			} else if (isRoleKey) {
				dropped.add(`retry.fallbackChains.${key}`);
				delete chains[key];
				continue;
			}
			const chainKey = key === "interactive" ? "default" : key;
			if (chains[chainKey] !== undefined) expandChainAt(raw, ["retry", "fallbackChains", chainKey], expand);
		}
	}

	if (dropped.size === 0) return;
	logger.warn(
		`Settings: model roles were removed, and these values have no successor: ${[...dropped].join(", ")}. ` +
			`The session model is defaultModel (/model), and each helper's model is set in Agents → Roster → Helpers.`,
		{ setting: "modelRoles", dropped: [...dropped] },
	);
}

/**
 * The snapcompact image-archive engine was removed; drop any persisted
 * snapcompact.* settings so schema validation does not trip on stale keys.
 */
function dropSnapcompact(raw: RawSettings): void {
	delete raw.snapcompact;
	for (const key of Object.keys(raw)) {
		if (key.startsWith("snapcompact.")) delete raw[key];
	}
}

/**
 * inlineToolDescriptors: boolean -> enum (auto | on | off). The old
 * `true`/`false` mapped directly onto inline-on/inline-off, so preserve
 * the user's explicit choice; new installs get the `auto` default that
 * turns it on only for Gemini models.
 */
function migrateInlineToolDescriptors(raw: RawSettings): void {
	if (typeof raw.inlineToolDescriptors === "boolean") {
		raw.inlineToolDescriptors = raw.inlineToolDescriptors ? "on" : "off";
	}
}

/** statusLine: rename "plan_mode" segment to "mode" */
function migrateStatusLine(raw: RawSettings): void {
	const statusLineObj = recordAt(raw.statusLine);
	if (!statusLineObj) return;
	for (const key of ["leftSegments", "rightSegments"] as const) {
		const segments = statusLineObj[key];
		if (Array.isArray(segments)) {
			statusLineObj[key] = segments.map(seg => (seg === "plan_mode" ? "mode" : seg));
		}
	}
	const segmentOptions = recordAt(statusLineObj.segmentOptions);
	if (segmentOptions && "plan_mode" in segmentOptions && !("mode" in segmentOptions)) {
		segmentOptions.mode = segmentOptions.plan_mode;
		delete segmentOptions.plan_mode;
	}
}

/**
 * providers.parallelFetch (boolean) replaced by the providers.fetch reader
 * priority enum. The new default ("auto") supersedes both old values —
 * Parallel is now a deep fallback in the auto chain rather than the first
 * choice — so drop the legacy key (flat and nested) and let the enum
 * default apply.
 */
function dropParallelFetch(raw: RawSettings): void {
	const providersObj = recordAt(raw.providers);
	if (providersObj && "parallelFetch" in providersObj) {
		delete providersObj.parallelFetch;
		if (Object.keys(providersObj).length === 0) delete raw.providers;
	}
	delete raw["providers.parallelFetch"];
}

/**
 * codexResets.autoRedeem: boolean -> tri-state enum.
 * Existing explicit false keeps the old "do not run" behavior; missing
 * config now falls through to the new "unset" default, which asks before
 * the first eligible spend.
 */
function migrateCodexResets(raw: RawSettings): void {
	const codexResetsObj = recordAt(raw.codexResets);
	if (codexResetsObj && typeof codexResetsObj.autoRedeem === "boolean") {
		codexResetsObj.autoRedeem = codexResetsObj.autoRedeem ? "yes" : "no";
	}
}

function migrateMemorySettings(raw: RawSettings): void {
	// Map legacy `memories.enabled` boolean to the explicit `memory.backend`
	// enum if the latter hasn't been set yet. Idempotent: subsequent
	// migrations are no-ops once memory.backend is materialised.
	const memoryBackendObj = recordAt(raw.memory);
	const memoryBackendSet = memoryBackendObj && typeof memoryBackendObj.backend === "string";
	const memoriesObj = recordAt(raw.memories);
	const memoriesEnabled =
		(typeof memoriesObj?.enabled === "boolean" ? memoriesObj.enabled : undefined) ??
		(typeof raw["memories.enabled"] === "boolean" ? raw["memories.enabled"] : undefined);
	if (!memoryBackendSet && typeof memoriesEnabled === "boolean") {
		const memoryRoot = memoryBackendObj ?? {};
		memoryRoot.backend = memoriesEnabled ? "local" : "off";
		raw.memory = memoryRoot;
	}
	if (memoriesObj) delete memoriesObj.enabled;
	delete raw["memories.enabled"];
	if (isRecord(raw.memories) && Object.keys(raw.memories).length === 0) delete raw.memories;
	// Rename the legacy local `mnemosyne` memory backend to `mnemopi`.
	// - `memory.backend: "mnemosyne"` now selects the renamed backend.
	// - the top-level `mnemosyne` settings object becomes `mnemopi`.
	// Idempotent: skips the object move once `mnemopi` is materialised.
	if (memoryBackendObj && memoryBackendObj.backend === "mnemosyne") {
		memoryBackendObj.backend = "mnemopi";
	}
	if ("mnemosyne" in raw && !("mnemopi" in raw)) {
		raw.mnemopi = raw.mnemosyne;
		delete raw.mnemosyne;
	}
}

/**
 * hindsight: dynamicBankId/agentName -> scoping enum + bankId
 * - dynamicBankId=true  → scoping="per-project" (closest semantic match;
 *   the legacy `agent::project::channel::user` tuple was per-project in
 *   practice — the channel/user env vars were rarely set).
 * - hindsight.agentName was only used as the agent slot in the legacy
 *   dynamic tuple; if the user customised it we surface it as the new
 *   bankId base when no explicit bankId is set.
 * Both legacy keys are retired, so the dotted-key expansion leaves their flat
 * spelling (`hindsight.dynamicBankId: true`, as `config set` writes it) alone;
 * each is read from whichever spelling holds it and both spellings are dropped.
 */
function migrateHindsight(raw: RawSettings): void {
	const hindsightObj = recordAt(raw.hindsight);
	const flatDynamicBankId = raw["hindsight.dynamicBankId"];
	const flatAgentName = raw["hindsight.agentName"];
	if (!hindsightObj && flatDynamicBankId === undefined && flatAgentName === undefined) return;
	const target = hindsightObj ?? {};
	const dynamicBankId = target.dynamicBankId ?? flatDynamicBankId;
	if (dynamicBankId === true && !("scoping" in target)) {
		target.scoping = "per-project";
	}
	delete target.dynamicBankId;
	delete raw["hindsight.dynamicBankId"];
	const agentName = target.agentName ?? flatAgentName;
	if (
		!("bankId" in target) &&
		typeof agentName === "string" &&
		agentName.trim().length > 0 &&
		agentName !== "veyyon" &&
		agentName !== "omp"
	) {
		target.bankId = agentName;
	}
	delete target.agentName;
	delete raw["hindsight.agentName"];
	if (Object.keys(target).length > 0) raw.hindsight = target;
}

const LEGACY_POWER_FLAGS = [
	"preventIdleSleep",
	"preventSystemSleep",
	"declareUserActive",
	"preventDisplaySleep",
] as const;

/**
 * power.preventIdleSleep / power.preventSystemSleep / power.declareUserActive
 * / power.preventDisplaySleep (four booleans) → power.sleepPrevention enum.
 * The enum is cumulative: each level adds the flags of all lower levels.
 * Migration picks the highest level whose condition is met, scanning from
 * most to least aggressive so a single enum value captures the old state.
 * The flat spelling of the destination needs no check: the expansion above has
 * already folded `power.sleepPrevention` into the nested tree. The legacy
 * booleans below are RETIRED keys, which the expansion leaves alone, so both
 * spellings of those are still read.
 */
function migratePowerSettings(raw: RawSettings): void {
	const powerObj = recordAt(raw.power);
	if (powerObj && "sleepPrevention" in powerObj) return;
	const getFlag = (key: (typeof LEGACY_POWER_FLAGS)[number]): boolean | undefined => {
		const value = powerObj?.[key] ?? raw[`power.${key}`];
		return typeof value === "boolean" ? value : undefined;
	};
	const idle = getFlag("preventIdleSleep");
	const system = getFlag("preventSystemSleep");
	const user = getFlag("declareUserActive");
	const display = getFlag("preventDisplaySleep");
	const anySet = idle !== undefined || system !== undefined || user !== undefined || display !== undefined;
	if (anySet) {
		const mode = system || user ? "system" : display ? "display" : idle !== false ? "idle" : "off";
		const powerRoot = powerObj ?? {};
		powerRoot.sleepPrevention = mode;
		raw.power = powerRoot;
	}
	// Clean up old keys (nested + flat)
	for (const key of LEGACY_POWER_FLAGS) {
		if (powerObj) delete powerObj[key];
		delete raw[`power.${key}`];
	}
}

/** Tool-name arrays use canonical wire IDs and remain deduplicated. */
function migrateToolNameList(names: unknown): unknown {
	if (!Array.isArray(names)) return names;
	const out: unknown[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const normalized = typeof name === "string" ? normalizeToolName(name) : name;
		if (typeof normalized === "string") {
			if (seen.has(normalized)) continue;
			seen.add(normalized);
		}
		out.push(normalized);
	}
	return out;
}

function migrateToolSettings(raw: RawSettings): void {
	const toolsObj = recordAt(raw.tools);
	if (toolsObj && "essentialOverride" in toolsObj) {
		toolsObj.essentialOverride = migrateToolNameList(toolsObj.essentialOverride);
	}
	if ("tools.essentialOverride" in raw) {
		let nestedToolsObj: Record<string, unknown>;
		if (isRecord(raw.tools)) {
			nestedToolsObj = raw.tools;
		} else {
			nestedToolsObj = {};
			raw.tools = nestedToolsObj;
		}
		if (!("essentialOverride" in nestedToolsObj)) {
			nestedToolsObj.essentialOverride = migrateToolNameList(raw["tools.essentialOverride"]);
		}
		delete raw["tools.essentialOverride"];
	}
}

/** A retired setting from whichever spelling holds it, nested first. */
function legacySetting(raw: RawSettings, section: string, key: string): unknown {
	const nested = raw[section];
	if (isRecord(nested) && key in nested) return nested[key];
	return raw[`${section}.${key}`];
}

/**
 * Retired per-engine enable flags no longer control the canonical search
 * tool, which is part of the default inventory. Preserve only the text
 * context settings; canonical values win when both generations exist.
 */
function migrateSearchSettings(raw: RawSettings): void {
	const legacyContextBefore = legacySetting(raw, "grep", "contextBefore");
	const legacyContextAfter = legacySetting(raw, "grep", "contextAfter");
	const searchObj = isRecord(raw.search) ? raw.search : {};
	delete searchObj.enabled;
	if (
		!("contextBefore" in searchObj) &&
		typeof raw["search.contextBefore"] !== "number" &&
		typeof legacyContextBefore === "number"
	) {
		searchObj.contextBefore = legacyContextBefore;
	}
	if (
		!("contextAfter" in searchObj) &&
		typeof raw["search.contextAfter"] !== "number" &&
		typeof legacyContextAfter === "number"
	) {
		searchObj.contextAfter = legacyContextAfter;
	}
	if (Object.keys(searchObj).length > 0) raw.search = searchObj;
	else delete raw.search;
	delete raw["search.enabled"];
	delete raw.find;
	delete raw.glob;
	delete raw.grep;
	delete raw.astGrep;
	delete raw["find.enabled"];
	delete raw["glob.enabled"];
	delete raw["grep.enabled"];
	delete raw["grep.contextBefore"];
	delete raw["grep.contextAfter"];
	delete raw["astGrep.enabled"];
	// readHashLines: removed. Hashline anchors are now driven solely by
	// edit.mode === "hashline"; the separate read toggle only ever produced
	// the incoherent "hashline edits without addressable anchors" state.
	delete raw.readHashLines;
}

/** The per-family tiers a legacy `serviceTier` value selected. */
function serviceTierFamilies(serviceTier: string): ReadonlyArray<readonly [family: string, tier: string]> {
	switch (serviceTier) {
		case "priority":
			return [
				["openai", "priority"],
				["anthropic", "priority"],
				["google", "priority"],
			];
		case "openai-only":
			return [["openai", "priority"]];
		case "claude-only":
			return [["anthropic", "priority"]];
		case "auto":
		case "default":
		case "flex":
		case "scale":
			return [["openai", serviceTier]];
		default:
			return [];
	}
}

/** A scoped `-only` sentinel inherited by an agent or advisor tier means priority. */
function mapInheritTier(value: unknown): unknown {
	return value === "openai-only" || value === "claude-only" ? "priority" : value;
}

/**
 * serviceTier (single enum with scoped openai-only/claude-only sentinels)
 * → per-family tier.openai/tier.anthropic/tier.google; serviceTierSubagent
 * → tier.agent; serviceTierAdvisor → tier.advisor. `fastModeScope` is
 * dropped — per-family scoping is now expressed by the three tier settings.
 */
function migrateServiceTier(raw: RawSettings): void {
	const tierObj = isRecord(raw.tier) ? raw.tier : {};
	let tierTouched = false;
	const setTier = (family: string, value: unknown): void => {
		if (value !== undefined && !(family in tierObj)) {
			tierObj[family] = value;
			tierTouched = true;
		}
	};
	if (typeof raw.serviceTier === "string") {
		for (const [family, tier] of serviceTierFamilies(raw.serviceTier)) setTier(family, tier);
		delete raw.serviceTier;
	}
	if ("serviceTierSubagent" in raw) {
		setTier("agent", mapInheritTier(raw.serviceTierSubagent));
		delete raw.serviceTierSubagent;
	}
	// The `subagent` vocabulary became `agent`: the whole `subagent.*` area
	// moved to `agent.*` leaf for leaf, and the three keys other areas kept
	// under the old word moved with it. New wins, legacy is deleted, so this is
	// a fixed point like the rest of this module.
	if ("subagent" in tierObj || "tier.subagent" in raw) {
		const legacyTierSubagent = tierObj.subagent ?? raw["tier.subagent"];
		setTier("agent", mapInheritTier(legacyTierSubagent));
		delete tierObj.subagent;
		delete raw["tier.subagent"];
		tierTouched = true;
	}
	if ("serviceTierAdvisor" in raw) {
		setTier("advisor", mapInheritTier(raw.serviceTierAdvisor));
		delete raw.serviceTierAdvisor;
	}
	if (tierTouched) raw.tier = tierObj;
	delete raw.fastModeScope;
}

const ARGOT_ENCODE_KEYS = ["models", "disableAboveTokens"] as const;

/**
 * argot.models / argot.disableAboveTokens -> argot.encode.*
 *
 * The two keys that gate ENCODING are grouped under the sub-feature they
 * belong to, the way `read.summarize.*` and `bash.autoBackground.*` are.
 * They are the only two of Argot's six settings that decide whether the
 * model is taught to WRITE shorthand; `enabled`, `autoload`, `tokenBudget`
 * and `agents` decide whether the feature runs, when a dictionary is
 * built, how large it is, and what a child agent starts with. Reading a
 * flat `argot.models` gave no hint that it governs one side of the feature
 * while decoding is unconditional, which is the distinction an operator has
 * to hold to predict what turning it off does.
 *
 * The nested spelling always wins and the flat one is dropped without being
 * read, which is what makes this a fixed point: re-running it on its own
 * output changes nothing, and it has to be, because it runs on every load of
 * every source. `argot` keeps its other keys, so no empty husk is possible.
 * Both spellings have to be folded. `#expandDottedSettingKeys` only expands
 * REGISTERED paths, and these two are retired, so a literal `argot.models:` key
 * written flat in a config file survives it untouched and would otherwise sit in
 * the tree forever with nothing reading it.
 */
function migrateArgotEncode(raw: RawSettings): void {
	for (const key of ARGOT_ENCODE_KEYS) {
		const flat = `argot.${key}`;
		if (!(flat in raw)) continue;
		if (getByPath(raw, ["argot", "encode", key]) === undefined) {
			setByPath(raw, ["argot", "encode", key], raw[flat]);
		}
		delete raw[flat];
	}

	const argotObj = recordAt(raw.argot);
	if (!argotObj) return;
	for (const key of ARGOT_ENCODE_KEYS) {
		if (!(key in argotObj)) continue;
		// Resolved per key, not once: moving the first key CREATES the block, and a
		// stale `undefined` captured before that would make the second key replace
		// the block instead of joining it, silently dropping the first value.
		const encode = isRecord(argotObj.encode) ? argotObj.encode : {};
		if (!(key in encode)) encode[key] = argotObj[key];
		argotObj.encode = encode;
		delete argotObj[key];
	}
}

/**
 * composer.predictions.enabled (boolean) + .source ("codex" | "model") -> .mode.
 *
 * An explicit `enabled: false` becomes `off`. `enabled: true` maps
 * `source: model` to `custom` and every other source to `chatgpt-pro`, which
 * requests only on a ChatGPT Pro plan, so a stored opt-in is not lost to the
 * `off` default. A `mode` already present wins. Both spellings, flat and
 * nested, are folded and dropped, which makes this a fixed point.
 */
function migrateComposerPredictionsMode(raw: RawSettings): void {
	const read = (key: string): unknown => {
		const flat = `composer.predictions.${key}`;
		const value = flat in raw ? raw[flat] : getByPath(raw, ["composer", "predictions", key]);
		delete raw[flat];
		deleteByPath(raw, ["composer", "predictions", key]);
		return value;
	};
	const enabled = read("enabled");
	const source = read("source");
	if (typeof enabled !== "boolean") return;
	if ("composer.predictions.mode" in raw || getByPath(raw, ["composer", "predictions", "mode"]) !== undefined) return;
	setByPath(
		raw,
		["composer", "predictions", "mode"],
		!enabled ? "off" : source === "model" ? "custom" : "chatgpt-pro",
	);
}

/**
 * model.toolCallLoopGuard.readSubsumptionThreshold tuned the redundant-read
 * detector of the tool-call loop guard, which was removed. Drop the key (flat and
 * nested) and every section its removal emptied.
 */
function dropReadSubsumptionThreshold(raw: RawSettings): void {
	delete raw["model.toolCallLoopGuard.readSubsumptionThreshold"];
	const modelObj = raw.model;
	if (!isRecord(modelObj)) return;
	const guardObj = modelObj.toolCallLoopGuard;
	if (!isRecord(guardObj) || !("readSubsumptionThreshold" in guardObj)) return;
	delete guardObj.readSubsumptionThreshold;
	if (Object.keys(guardObj).length === 0) delete modelObj.toolCallLoopGuard;
	if (Object.keys(modelObj).length === 0) delete raw.model;
}

/**
 * todo.reminders.max -> todo.reminderLimit.
 *
 * The limit was declared beneath the `todo.reminders` switch, and one config key cannot hold a
 * boolean and a group: writing the limit replaced a stored `todo.reminders: false` with
 * `{ max: N }`, which turned reminders back on, and writing the switch dropped the limit. A
 * `todo.reminders` group held nothing but the limit and read as reminders on, so it is folded
 * onto the limit and dropped, which leaves the switch at its default. A `todo.reminderLimit`
 * already present wins. Both spellings, flat and nested, are folded and dropped, which makes
 * this a fixed point.
 */
function migrateTodoReminderLimit(raw: RawSettings): void {
	const flat = raw["todo.reminders.max"];
	delete raw["todo.reminders.max"];
	const todo = recordAt(raw.todo);
	const group = recordAt(todo?.reminders);
	if (todo && group) delete todo.reminders;
	const limit = group?.max ?? flat;
	if (limit === undefined) return;
	if (todo?.reminderLimit !== undefined) return;
	setByPath(raw, ["todo", "reminderLimit"], limit);
}

/**
 * Every field-level migration, in the order it runs.
 *
 * Optional numeric settings once stored `-1` to mean "unset", which made -1
 * unreachable as a real value: `presencePenalty: -1` is a penalty the
 * provider accepts, and it could not be configured. Unset is an ABSENT key
 * now, so the old sentinel is dropped — in every prior version it meant
 * exactly this, so nothing a user chose is lost. That migration is not in
 * this list: it cannot tell its input apart from a legitimate current value,
 * so re-running it would delete a `-1` the user typed on purpose. It runs
 * ONCE, in {@link migrateOwnedConfigOnce}, and only in the config this
 * instance owns; a project file or a `--config` overlay is hand-written
 * against the current docs, so a `-1` there is a value.
 */
const RAW_SETTINGS_MIGRATIONS: readonly RawSettingsMigration[] = [
	migrateQueueMode,
	dropChangelogKeys,
	migrateAskTimeout,
	migrateCompactionThreshold,
	migrateFlatTheme,
	migrateTaskIsolation,
	migrateTaskFlags,
	// task.* / modelRoles.task -> the agent.* settings area.
	//
	// Everything about spawned agents used to be spread across `task.*`
	// operational keys, `agent.model` under Models, `modelRoles.task` in the
	// role table, and two UI-less maps (`task.agentModelOverrides`,
	// `task.disabledAgents`). This rewrites the old keys onto the one section so
	// the file has a single owner per value — no dual-read, which is how the
	// precedence tangle grew in the first place. It reads `task.eager` after
	// `migrateTaskFlags` has converted the boolean spelling.
	migrateAgentSettings,
	migrateEditSettings,
	migrateCompactionStrategy,
	migrateCompactionModel,
	// After the agent and compaction folds, so `agent.model` (once
	// `modelRoles.task`) and `compaction.model` are in place when their role
	// references are expanded.
	migrateModelRoles,
	dropSnapcompact,
	migrateInlineToolDescriptors,
	migrateStatusLine,
	dropParallelFetch,
	migrateCodexResets,
	migrateMemorySettings,
	migrateHindsight,
	migratePowerSettings,
	migrateToolSettings,
	migrateSearchSettings,
	migrateServiceTier,
	migrateArgotEncode,
	migrateComposerPredictionsMode,
	dropReadSubsumptionThreshold,
	migrateTodoReminderLimit,
];

/**
 * Apply every field-level migration to one raw settings tree.
 *
 * Runs on EVERY load of EVERY source (global, project, `--config` overlays,
 * runtime overrides), so every migration here must be a fixed point on its own
 * output. A migration that CANNOT be — one that cannot distinguish an old
 * encoding from a value the user typed — does not belong here: it goes in
 * {@link migrateOwnedConfigOnce}, which runs once against the config this
 * instance owns.
 */
export function migrateRawSettings(raw: RawSettings, context: RawSettingsMigrationContext): RawSettings {
	for (const migrate of RAW_SETTINGS_MIGRATIONS) migrate(raw, context);
	return raw;
}
