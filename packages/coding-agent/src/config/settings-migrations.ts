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

import { deleteByPath, getByPath, type RawSettings, setByPath } from "@veyyon/kernel/settings/store";
import * as logger from "@veyyon/utils/logger";
import { isRecord } from "@veyyon/utils/type-guards";
import { isLightTheme } from "../theme/theme-luminance";
import { normalizeToolName } from "../tools/core/builtin-names";
import { type CompactionStrategySetting, migrateCompactionStrategyValue } from "./compaction-strategy";

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
	// Every value in a settings source is NESTED — the loader builds the tree
	// with `setByPath` and `get` reads it back segment by segment — so a dotted
	// key written at the top level here would be stored but never read. That is
	// not theoretical: writing `raw["agent.delegation"]` made this whole
	// migration a no-op, and only a test that loaded a legacy config and read the
	// new setting back caught it.
	const read = (segments: string[]): unknown => {
		const nested = getByPath(raw, segments);
		if (nested !== undefined) return nested;
		const flat = raw[segments.join(".")];
		if (flat !== undefined) return flat;
		for (let i = 1; i < segments.length; i++) {
			const parent = getByPath(raw, segments.slice(0, i));
			if (isRecord(parent)) {
				const val = (parent as Record<string, unknown>)[segments.slice(i).join(".")];
				if (val !== undefined) return val;
			}
			const flatParent = raw[segments.slice(0, i).join(".")];
			if (isRecord(flatParent)) {
				const val = getByPath(flatParent as Record<string, unknown>, segments.slice(i));
				if (val !== undefined) return val;
			}
		}
		return undefined;
	};
	const take = (segments: string[]): unknown => {
		const value = read(segments);
		if (value !== undefined) {
			deleteByPath(raw, segments);
			delete raw[segments.join(".")];
			for (let i = 1; i < segments.length; i++) {
				const parent = getByPath(raw, segments.slice(0, i));
				if (isRecord(parent)) {
					delete (parent as Record<string, unknown>)[segments.slice(i).join(".")];
				}
				const flatParent = raw[segments.slice(0, i).join(".")];
				if (isRecord(flatParent)) {
					deleteByPath(flatParent as Record<string, unknown>, segments.slice(i));
				}
			}
		}
		return value;
	};
	const setNew = (key: string[], value: unknown): void => {
		if (value === undefined) return;
		// An explicit new-key value already on disk is authoritative: an operator
		// who has set the new setting is never overwritten by a stale legacy key.
		if (read(["agent", ...key]) !== undefined) return;
		setByPath(raw, ["agent", ...key], value);
	};

	// Fold flat modelRoles.<role> into raw.modelRoles so both modelRoles.task migration
	// and surviving modelRoles (e.g. modelRoles.default) see a unified modelRoles tree.
	for (const key of Object.keys(raw)) {
		if (key.startsWith("modelRoles.")) {
			const role = key.slice("modelRoles.".length);
			if (role) {
				const existing = isRecord(raw.modelRoles) ? (raw.modelRoles as Record<string, unknown>) : {};
				if (!(role in existing)) existing[role] = raw[key];
				raw.modelRoles = existing;
				delete raw[key];
			}
		}
	}

	// The area itself was `subagent.*` before it was `agent.*`. Fold it first,
	// leaf for leaf, so the older migrations below see one tree: a legacy
	// `subagent.autoClose.parkedMs` becomes `agent.autoClose.parkedMs` here and
	// `agent.prune.afterMs` a few lines down. `advisor.subagents` and
	// `argot.subagents` moved with it; `tier.subagent` is folded with the other
	// tier keys further down.
	const fold = (node: unknown, path: string[]): void => {
		if (isRecord(node)) {
			for (const [key, value] of Object.entries(node)) {
				fold(value, path.concat(key.includes(".") ? key.split(".") : key));
			}
		} else {
			setNew(path, node);
		}
	};
	if (isRecord(raw.subagent)) {
		fold(raw.subagent, []);
		delete raw.subagent;
	}
	for (const key of Object.keys(raw)) {
		if (key.startsWith("subagent.")) {
			const leaf = key.slice("subagent.".length);
			if (leaf) {
				fold(raw[key], leaf.split("."));
				delete raw[key];
			}
		}
	}
	for (const area of ["advisor", "argot"] as const) {
		const value = take([area, "subagents"]);
		if (value !== undefined && read([area, "agents"]) === undefined) setByPath(raw, [area, "agents"], value);
	}

	const eager = take(["task", "eager"]);
	if (typeof eager === "string") {
		// `task.eager` had three values and all three still delegate, so the old
		// bottom value lands on `allowed`: someone with eager delegation switched
		// off still delegated by hand, and taking the task tool away would change
		// what their sessions can do.
		const delegation = eager === "always" ? "required" : eager === "preferred" ? "preferred" : "allowed";
		setNew(["delegation"], delegation);
	}

	// `agent.delegation: off` was the kill switch before `agent.enabled`
	// existed, so one setting answered two questions: whether agents exist, and
	// how hard to push them. Someone who wrote `off` was turning agents OFF —
	// that is the half to preserve — so it becomes `enabled: false` and the
	// strength falls back to its default, ready for when they turn it back on.
	// Deleted rather than left in place because `off` is no longer a legal value:
	// leaving it would fail validation and read as a corrupt config.
	if (read(["agent", "delegation"]) === "off") {
		deleteByPath(raw, ["agent", "delegation"]);
		delete raw["agent.delegation"];
		if (read(["agent", "enabled"]) === undefined) {
			setByPath(raw, ["agent", "enabled"], false);
		}
	}

	for (const [legacy, next] of [
		["batch", "batch"],
		["maxConcurrency", "maxConcurrency"],
		["enableLsp", "enableLsp"],
		["maxRuntimeMs", "maxRuntimeMs"],
		["agentIdleTtlMs", "idleTtlMs"],
		["softRequestBudget", "softRequestBudget"],
		["softRequestBudgetNotice", "softRequestBudgetNotice"],
		["showResolvedModelBadge", "showResolvedModelBadge"],
	] as const) {
		setNew([next], take(["task", legacy]));
	}

	// The close stage became the PRUNE stage, and the keys moved with it. "Close"
	// read as the opposite of park, when the two are consecutive stages of one
	// lifecycle: parking releases the session and keeps the row, pruning drops the
	// row. The container is deleted with the leaves so a migrated file carries no
	// empty `agent.autoClose` block.
	for (const [legacy, next] of [
		["enabled", "enabled"],
		["parkedMs", "afterMs"],
		["waitingMs", "waitingAfterMs"],
	] as const) {
		setNew(["prune", next], take(["agent", "autoClose", legacy]));
	}
	if (read(["agent", "autoClose"]) !== undefined) deleteByPath(raw, ["agent", "autoClose"]);
	delete raw["agent.autoClose.enabled"];
	delete raw["agent.autoClose.parkedMs"];
	delete raw["agent.autoClose.waitingMs"];

	// The old depth counted the root as level 1. The replacement counts only
	// nested agent levels, so old 1 becomes new 0. Old 0 disabled even the
	// root task tool; preserve that behavior through the dedicated master
	// switch. Both legacy paths are consumed, with the newer agent path
	// winning when a file somehow contains both.
	const legacyTaskDepth = take(["task", "maxRecursionDepth"]);
	const legacyAgentDepth = take(["agent", "maxRecursionDepth"]);
	const legacyDepth = legacyAgentDepth ?? legacyTaskDepth;
	if (legacyDepth !== undefined) {
		if (legacyDepth === 0) setNew(["enabled"], false);
		const nestedDepth =
			typeof legacyDepth === "number" && Number.isInteger(legacyDepth)
				? legacyDepth < 0
					? -1
					: Math.max(0, legacyDepth - 1)
				: legacyDepth;
		setNew(["maxNestedSpawnDepth"], nestedDepth);
	}

	// task.isolation.* -> agent.isolation.*
	for (const key of ["mode", "merge", "commits"] as const) {
		setNew(["isolation", key], take(["task", "isolation", key]));
	}
	const isolationMode = read(["agent", "isolation", "mode"]);
	if (typeof isolationMode === "string") {
		const isolationLegacyMode: Record<string, string> = {
			worktree: "rcopy",
			"fuse-overlay": "overlayfs",
			"fuse-projfs": "projfs",
		};
		const mapped = isolationLegacyMode[isolationMode];
		if (mapped !== undefined) {
			setByPath(raw, ["agent", "isolation", "mode"], mapped);
		}
	}

	// The two agent-keyed maps become one row per agent. Two parallel maps meant
	// two lookups that could disagree, which is how an agent could read as off on
	// one surface while a model override for it lived on invisibly.
	const agents: Record<string, Record<string, unknown>> = {};
	const disabled = take(["task", "disabledAgents"]);
	if (Array.isArray(disabled)) {
		for (const name of disabled) {
			if (typeof name !== "string" || !name.trim()) continue;
			agents[name.trim()] = { ...(agents[name.trim()] ?? {}), enabled: false };
		}
	}
	// Per-agent models are NOT carried over. They were a third owner of the
	// agent model question, above the blanket setting and invisible from it,
	// and they are gone; writing them into the new section would only recreate
	// the drift in a new spelling. Folding them into `agent.model` instead is
	// not available either — several agents could name several models and there
	// is no honest way to pick one. So the values are dropped and named, once,
	// with the setting that replaced them.
	const overrides = take(["task", "agentModelOverrides"]);
	if (isRecord(overrides)) {
		const dropped = Object.entries(overrides)
			.filter(([, model]) => typeof model === "string" && model.trim().length > 0)
			.map(([name, model]) => `${name}=${String(model).trim()}`);
		if (dropped.length > 0) {
			logger.warn(
				`Settings: task.agentModelOverrides (${dropped.join(", ")}) is no longer read — a per-agent model ` +
					`is set on that agent's own page. Open Agents → Roster, pick the agent, and set its Model, or ` +
					`give the agent file its own \`model:\` frontmatter.`,
				{ setting: "task.agentModelOverrides", dropped },
			);
		}
	}
	// `disabledAgents` is the only legacy map with a home in the new section, so a
	// row written here carries exactly one fact: whether the agent runs.
	if (Object.keys(agents).length > 0) setNew(["agents"], agents);

	// modelRoles.task was the "model for agents" knob before this section
	// existed. It folds into the blanket agent model AND the role entry goes:
	// leaving it would restore two owners for one value, with role expansion
	// answering first, which is exactly why an agent model setting used to have
	// no effect.
	const legacyRoleModel = take(["modelRoles", "task"]);
	if (typeof legacyRoleModel === "string" && legacyRoleModel.trim()) {
		setNew(["model"], legacyRoleModel.trim());
	}
	if (isRecord(raw.modelRoles) && Object.keys(raw.modelRoles).length === 0) delete raw.modelRoles;

	// Leave no empty husk behind: a surviving `task: {}` block is a second place
	// to look for settings that no longer live there.
	if (isRecord(raw.task) && Object.keys(raw.task).length === 0) delete raw.task;
	const isolation = getByPath(raw, ["task", "isolation"]);
	if (isRecord(isolation) && Object.keys(isolation).length === 0) {
		deleteByPath(raw, ["task", "isolation"]);
		if (isRecord(raw.task) && Object.keys(raw.task).length === 0) delete raw.task;
	}
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
	const ask = raw.ask as Record<string, unknown> | undefined;
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
	const compaction = raw.compaction as Record<string, unknown> | undefined;
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
	const isolationObj = (raw.task as Record<string, unknown> | undefined)?.isolation as
		| Record<string, unknown>
		| undefined;
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
	const taskObj = raw.task as Record<string, unknown> | undefined;
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
	const todoObj = raw.todo as Record<string, unknown> | undefined;
	if (todoObj && typeof todoObj.eager === "boolean") {
		todoObj.eager = todoObj.eager ? "always" : "default";
	}
}

function migrateEditSettings(raw: RawSettings): void {
	// edit.mode: removed "atom" and "vim" variants map back to "hashline"
	const editObj = raw.edit as Record<string, unknown> | undefined;
	if (editObj) {
		if (editObj.mode === "atom" || editObj.mode === "vim") {
			editObj.mode = "hashline";
		}
		const modelVariants = editObj.modelVariants as Record<string, unknown> | undefined;
		if (isRecord(modelVariants)) {
			for (const [pattern, variant] of Object.entries(modelVariants)) {
				if (variant === "atom" || variant === "vim") {
					modelVariants[pattern] = "hashline";
				}
			}
		}
	}

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

/** compaction.strategy: collapse every legacy strategy to summary; off also disables compaction. */
function migrateCompactionStrategy(raw: RawSettings): void {
	const compactionObj = raw.compaction as Record<string, unknown> | undefined;
	if (!compactionObj) return;
	if (compactionObj.strategy === "off") {
		compactionObj.strategy = "summary";
		if (compactionObj.enabled === undefined) {
			compactionObj.enabled = false;
		}
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

/** cycleOrder: drop legacy default pseudo-role from ctrl+p order. */
function migrateCycleOrder(raw: RawSettings): void {
	const cycleOrder = raw.cycleOrder;
	if (Array.isArray(cycleOrder)) {
		raw.cycleOrder = cycleOrder.filter(role => role !== "default");
	}
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
	const statusLineObj = raw.statusLine as Record<string, unknown> | undefined;
	if (!statusLineObj) return;
	for (const key of ["leftSegments", "rightSegments"] as const) {
		const segments = statusLineObj[key];
		if (Array.isArray(segments)) {
			statusLineObj[key] = segments.map(seg => (seg === "plan_mode" ? "mode" : seg));
		}
	}
	const segmentOptions = statusLineObj.segmentOptions as Record<string, unknown> | undefined;
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
	const providersObj = raw.providers as Record<string, unknown> | undefined;
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
	const codexResetsObj = raw.codexResets as Record<string, unknown> | undefined;
	if (codexResetsObj && typeof codexResetsObj.autoRedeem === "boolean") {
		codexResetsObj.autoRedeem = codexResetsObj.autoRedeem ? "yes" : "no";
	}
}

function migrateMemorySettings(raw: RawSettings): void {
	// Map legacy `memories.enabled` boolean to the explicit `memory.backend`
	// enum if the latter hasn't been set yet. Idempotent: subsequent
	// migrations are no-ops once memory.backend is materialised.
	const memoryBackendObj = raw.memory as Record<string, unknown> | undefined;
	const memoryBackendSet = memoryBackendObj && typeof memoryBackendObj.backend === "string";
	const memoriesObj = raw.memories as Record<string, unknown> | undefined;
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
	const hindsightObj = raw.hindsight as Record<string, unknown> | undefined;
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
	const powerObj = raw.power as Record<string, unknown> | undefined;
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
	const toolsObj = raw.tools as Record<string, unknown> | undefined;
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

	const argotObj = raw.argot as Record<string, unknown> | undefined;
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
	migrateCycleOrder,
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
