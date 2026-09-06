/**
 * The product's settings: the kernel's layered store (`@veyyon/kernel/settings/store`) with the
 * hooks this product supplies — the machine-wide bindings, the migrations that read a config an
 * earlier release wrote, the legacy stores a first run folds in, the side effect each value has
 * on the process — plus the typed accessors and the process-wide signals.
 *
 * Usage:
 *   import { settings } from "./settings";
 *
 *   const enabled = settings.get("compaction.enabled");  // sync read
 *   settings.set("theme.dark", "titanium");               // sync write, saves in background
 *
 * For tests:
 *   const isolated = Settings.isolated({ "compaction.enabled": false });
 */

import * as fs from "node:fs";
import * as path from "node:path";
// The caps' own module, not the streaming engine that reads them. `@veyyon/ai/stream` re-exports
// this setter and importing it there cost 285 modules for one function; ~530 test files import
// `Settings`, so this file's graph is the most leveraged one in the package.
import { configureProviderMaxInFlightRequests } from "@veyyon/ai/provider-inflight-limits";
import { clearSettingSignals } from "@veyyon/kernel/settings/signal";
import {
	deepMergeSettings,
	deleteByPath,
	type GlobalSettingBinding,
	getByPath,
	type RawSettings,
	type SettingSource,
	type SettingsOptions,
	SettingsStore,
	type SettingsStoreHooks,
	setByPath,
} from "@veyyon/kernel/settings/store";
import { getLastChangelogVersionPath, setWorktreesDir } from "@veyyon/utils/dirs";
import { isEnoent } from "@veyyon/utils/fs-error";
// Owners, not the `@veyyon/utils` barrel, because that is this repository's rule and this is the module
// 528 test files reach. It bought NO modules, and that is worth stating so nobody re-measures it hoping:
// repointing a file removes the barrel edge only when that file was the LAST path to it, and this closure
// still reaches the barrel elsewhere, so `config/settings.ts` reads 136 before and after. The rule is
// still right -- the edge is gone from HERE, and the next file in the closure that stops naming the barrel
// gets the whole 82 rather than none of it. Naming `dirs` directly is safe: it applies the
// directory-location keys from `$HOME/.env` itself, which is what `packages/utils/src/dotenv-home.ts`
// exists for.
import * as logger from "@veyyon/utils/logger";
import { expandTilde } from "@veyyon/utils/path";
import * as procmgr from "@veyyon/utils/procmgr";
import { errorMessage, isRecord } from "@veyyon/utils/type-guards";
import { JSONC } from "bun";
// The classifier leaf, NOT `../theme/theme` and NOT `../theme/builtin-themes`. The barrel
// imports `./shimmer`, which imports this file, and that cycle had to be instantiated as one unit:
// importing `config/settings` anywhere cost 51 MB, paid once per test file because the runner gives each
// one a fresh realm. `builtin-themes` breaks the cycle but statically embeds one JSON module per bundled
// theme, so reaching through it cost this file 103 modules of theme data nothing here reads, and cost
// them again to every one of the ~1,500 files that import `Settings`. `theme-luminance` owns the same
// boolean as a table and carries no theme JSON.
import { isLightTheme } from "../theme/theme-luminance";
import { normalizeToolName } from "../tools/core/builtin-names";
import { type EditMode, normalizeEditMode } from "../utils/edit-mode";
import { type CompactionStrategySetting, migrateCompactionStrategyValue } from "./compaction-strategy";
import { readLegacyAgentDbSettings } from "./legacy-agent-db-settings";
import type { ModelRole } from "./model-roles";
import { GLOBAL_SETTING_BINDINGS } from "./settings-domains/global";
// The slot, not a second copy of it: this module FILLS the slot that `./settings-instance.ts` owns, and
// that leaf is what a caller reads when it wants a value rather than the store. See its doc for the split.
import {
	runSettingsTestResetHooks,
	setSettingsInstance,
	setSettingsInstancePromise,
	settingsInstancePromise,
	settingsOrThrow,
} from "./settings-instance";
import {
	type BashInterceptorRule,
	type GroupPrefix,
	type GroupTypeMap,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingValue,
} from "./settings-schema";
import {
	appendOnlyModeSignal,
	autoThemeMappingSignal,
	colorBlindModeSignal,
	hindsightScopeSignal,
	modelRolesSignal,
	statusLineSessionAccentSignal,
	symbolPresetSignal,
} from "./settings-signals";

export { settingSignalListenerCounts } from "@veyyon/kernel/settings/signal";
// The store's vocabulary — the raw tree, the options, the provenance, the one-shot migration stamp
// and its helpers — under the name every caller already imports.
export * from "@veyyon/kernel/settings/store";
// Re-export types that callers need
export type * from "./settings-schema";
export * from "./settings-schema";

// ═══════════════════════════════════════════════════════════════════════════
// Product Helpers
// ═══════════════════════════════════════════════════════════════════════════

export function normalizeProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	if (!isRecord(value)) return {};
	const normalized: Record<string, number> = {};
	for (const [provider, rawLimit] of Object.entries(value)) {
		if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit <= 0) continue;
		normalized[provider] = Math.max(1, Math.floor(rawLimit));
	}
	return normalized;
}

export function validateProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	if (!isRecord(value)) return {};
	const invalidProviders: string[] = [];
	const normalized: Record<string, number> = {};
	for (const [provider, rawLimit] of Object.entries(value)) {
		if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit <= 0) {
			invalidProviders.push(provider);
			continue;
		}
		normalized[provider] = Math.max(1, Math.floor(rawLimit));
	}
	if (invalidProviders.length > 0) {
		throw new Error(`Provider request limits must be positive numbers: ${invalidProviders.join(", ")}`);
	}
	return normalized;
}

const PATH_SCOPED_ARRAY_SETTINGS = new Set<SettingPath>(["enabledModels", "disabledProviders"]);

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
type PathScopedStringArrayEntry = {
	path?: unknown;
	paths?: unknown;
	pathPrefix?: unknown;
	pathPrefixes?: unknown;
	values?: unknown;
	items?: unknown;
	models?: unknown;
	providers?: unknown;
};

function normalizePathPrefix(prefix: string): string {
	return path.resolve(expandTilde(prefix));
}

function pathMatchesPrefix(cwd: string, prefix: string): boolean {
	const relative = path.relative(normalizePathPrefix(prefix), path.resolve(cwd));
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function stringArrayFromUnknown(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return [];
}

function modelRoleValueFromUnknown(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;

	const entries = stringArrayFromUnknown(value);
	return entries.length === value.length ? entries.join(",") : undefined;
}

type EditVariantEntry = {
	patternLower: string;
	mode: EditMode;
};

function resolvePathScopedStringArray(settingPath: SettingPath, value: unknown, cwd: string): string[] | undefined {
	if (!PATH_SCOPED_ARRAY_SETTINGS.has(settingPath) || !Array.isArray(value)) return undefined;

	const resolved: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			resolved.push(entry);
			continue;
		}
		if (!isRecord(entry)) continue;

		const scoped = entry as PathScopedStringArrayEntry;
		const prefixes = [
			...stringArrayFromUnknown(scoped.path),
			...stringArrayFromUnknown(scoped.paths),
			...stringArrayFromUnknown(scoped.pathPrefix),
			...stringArrayFromUnknown(scoped.pathPrefixes),
		];
		if (prefixes.length === 0 || !prefixes.some(prefix => pathMatchesPrefix(cwd, prefix))) continue;

		const values =
			settingPath === "enabledModels"
				? [
						...stringArrayFromUnknown(scoped.values),
						...stringArrayFromUnknown(scoped.items),
						...stringArrayFromUnknown(scoped.models),
					]
				: [
						...stringArrayFromUnknown(scoped.values),
						...stringArrayFromUnknown(scoped.items),
						...stringArrayFromUnknown(scoped.providers),
					];
		for (let vi = 0; vi < values.length; vi++) resolved.push(values[vi]!);
	}

	return resolved;
}

// ═══════════════════════════════════════════════════════════════════════════
// Product Hooks
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What this product knows about its settings that the kernel store does not, one object per
 * store instance.
 *
 * The rewrite reported once and the legacy value captured for the marker file are per-instance
 * state, so they live here rather than at module scope, and a fork or a clone constructs a fresh
 * set the way it constructs a fresh store.
 */
class CodingAgentSettingsHooks implements SettingsStoreHooks {
	/** Legacy `lastChangelogVersion` captured from config.yml during migration (now a marker file). */
	legacyLastChangelogVersion?: string;
	/** Set once `ask.timeout` has been reported as rewritten, so the warning does not repeat on every read. */
	#reportedAskTimeoutRewrite = false;
	/** The parsed `edit.modelVariants` table, dropped whenever the merged view is rebuilt. */
	editVariantCache: readonly EditVariantEntry[] | undefined;

	globalBinding(path: string): GlobalSettingBinding | undefined {
		return GLOBAL_SETTING_BINDINGS[path];
	}

	resolveForCwd(path: SettingPath, value: unknown, cwd: string): unknown {
		return resolvePathScopedStringArray(path, value, cwd);
	}

	applyHook(path: SettingPath, next: unknown, prev: unknown): void {
		const hook = SETTING_HOOKS[path];
		if (hook) hook(next, prev);
	}

	applyAllHooks(store: SettingsStore): void {
		for (const key of Object.keys(SETTING_HOOKS) as SettingPath[]) {
			const hook = SETTING_HOOKS[key];
			if (hook) {
				const value = store.get(key);
				hook(value, value);
			}
		}
	}

	notifyEffectiveChange(path: SettingPath): void {
		if (path === "statusLine.sessionAccent") {
			statusLineSessionAccentSignal.fire();
		}
		if (path === "modelRoles") {
			modelRolesSignal.fire();
		}
	}

	mergedViewRebuilt(): void {
		this.editVariantCache = undefined;
	}

	/**
	 * Fold the legacy stores — `settings.json`, then `agent.db` — into one raw config for a
	 * first run that has no `config.yml`. Returns `null` when neither existed.
	 */
	async loadLegacySources(agentDir: string, migrate: (raw: RawSettings) => RawSettings): Promise<RawSettings | null> {
		let settings: RawSettings = {};
		let migrated = false;

		// 1. Migrate from settings.json
		const settingsJsonPath = path.join(agentDir, "settings.json");
		try {
			const parsed: unknown = JSONC.parse(await Bun.file(settingsJsonPath).text());
			if (isRecord(parsed)) {
				settings = deepMergeSettings(settings, migrate(parsed as RawSettings));
				migrated = true;
				try {
					fs.renameSync(settingsJsonPath, `${settingsJsonPath}.bak`);
				} catch (error) {
					// The settings were migrated in memory; only the archival rename
					// failed. Non-fatal (the next run re-migrates), but surface it.
					logger.warn("Settings: could not archive legacy settings.json after migration", {
						path: settingsJsonPath,
						error: errorMessage(error),
					});
				}
			}
		} catch (error) {
			// A missing legacy file is the normal case (nothing to migrate). A file
			// that exists but cannot be read or parsed means the user's legacy
			// settings would be dropped silently — surface that instead (Law 10).
			if (!isEnoent(error)) {
				logger.warn("Settings: legacy settings.json exists but could not be migrated", {
					path: settingsJsonPath,
					error: errorMessage(error),
				});
			}
		}

		// 2. Migrate from agent.db
		try {
			const dbSettings = readLegacyAgentDbSettings(agentDir);
			if (dbSettings) {
				settings = deepMergeSettings(settings, migrate(dbSettings as RawSettings));
				migrated = true;
			}
		} catch (error) {
			logger.warn("Settings: could not read legacy settings from agent.db during migration", {
				error: errorMessage(error),
			});
		}

		return migrated ? settings : null;
	}

	/**
	 * One-time migration: seed the last-changelog-version marker file from the
	 * legacy config.yml key. An existing marker always wins — it is the newer
	 * source of truth.
	 */
	async afterOwnedConfigLoaded(agentDir: string): Promise<void> {
		const legacy = this.legacyLastChangelogVersion;
		if (!legacy) return;
		const markerPath = getLastChangelogVersionPath(agentDir);
		try {
			if ((await Bun.file(markerPath).text()).trim()) return;
		} catch (error) {
			if (!isEnoent(error)) return;
		}
		try {
			await Bun.write(markerPath, legacy);
		} catch (error) {
			logger.warn("Settings: failed to seed last-changelog-version marker", { error: String(error) });
		}
	}

	/**
	 * Say once that `ask.timeout` was rewritten from milliseconds to seconds.
	 *
	 * The conversion is a guess (see the call site), so the one case it gets
	 * wrong is a user who genuinely wanted a timeout longer than
	 * {@link MAX_ASK_TIMEOUT_SECONDS}. Without this they would only find out by
	 * watching an ask auto-select in two seconds and having no idea why. Once per
	 * process, because the migration runs on every read of the file.
	 */
	#reportAskTimeoutRewrite(from: number, to: number): void {
		if (this.#reportedAskTimeoutRewrite) return;
		this.#reportedAskTimeoutRewrite = true;
		logger.warn(
			`Settings: ask.timeout was ${from}, which is read as milliseconds from an older config and rewritten to ${to} seconds. ` +
				`If you meant ${from} seconds, set ask.timeout again; it is in seconds now.`,
			{ from, to, maxSeconds: MAX_ASK_TIMEOUT_SECONDS },
		);
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
	#migrateAgentSettings(raw: RawSettings): void {
		// Every value in a settings source is NESTED — the loader builds the tree
		// with `setByPath` and `get` reads it back segment by segment — so a dotted
		// key written at the top level here would be stored but never read. That is
		// not theoretical: writing `raw["agent.delegation"]` made this whole
		// migration a no-op, and only a test that loaded a legacy config and read the
		// new setting back caught it.
		const read = (segments: string[]): unknown => getByPath(raw, segments);
		const take = (segments: string[]): unknown => {
			const value = getByPath(raw, segments);
			if (value !== undefined) deleteByPath(raw, segments);
			return value;
		};
		const setNew = (key: string[], value: unknown): void => {
			if (value === undefined) return;
			// An explicit new-key value already on disk is authoritative: an operator
			// who has set the new setting is never overwritten by a stale legacy key.
			if (read(["agent", ...key]) !== undefined) return;
			setByPath(raw, ["agent", ...key], value);
		};

		// The area itself was `subagent.*` before it was `agent.*`. Fold it first,
		// leaf for leaf, so the older migrations below see one tree: a legacy
		// `subagent.autoClose.parkedMs` becomes `agent.autoClose.parkedMs` here and
		// `agent.prune.afterMs` a few lines down. `advisor.subagents` and
		// `argot.subagents` moved with it; `tier.subagent` is folded with the other
		// tier keys further down.
		const legacyArea = raw.subagent;
		if (isRecord(legacyArea)) {
			const fold = (node: Record<string, unknown>, path: string[]): void => {
				for (const [key, value] of Object.entries(node)) {
					if (isRecord(value)) fold(value, path.concat(key));
					else setNew(path.concat(key), value);
				}
			};
			fold(legacyArea, []);
			delete raw.subagent;
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

		// The old depth counted the root as level 1. The replacement counts only
		// nested agent levels, so old 1 becomes new 0. Old 0 disabled even the
		// root task tool; preserve that behavior through the dedicated master
		// switch. Both legacy paths are consumed, with the newer agent path
		// winning when a file somehow contains both.
		const legacyTaskDepth = take(["task", "maxRecursionDepth"]);
		const legacyAgentDepth = take(["agent", "maxRecursionDepth"]);
		const legacyDepth = legacyAgentDepth ?? legacyTaskDepth;
		if (legacyDepth !== undefined) {
			if (legacyDepth === 0) setByPath(raw, ["agent", "enabled"], false);
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
		const legacyRoleModel = read(["modelRoles", "task"]);
		if (typeof legacyRoleModel === "string" && legacyRoleModel.trim()) {
			setNew(["model"], legacyRoleModel.trim());
			deleteByPath(raw, ["modelRoles", "task"]);
		}

		// Leave no empty husk behind: a surviving `task: {}` block is a second place
		// to look for settings that no longer live there.
		if (isRecord(raw.task) && Object.keys(raw.task).length === 0) delete raw.task;
		const isolation = getByPath(raw, ["task", "isolation"]);
		if (isRecord(isolation) && Object.keys(isolation).length === 0) {
			deleteByPath(raw, ["task", "isolation"]);
			if (isRecord(raw.task) && Object.keys(raw.task).length === 0) delete raw.task;
		}
	}

	/** Apply schema migrations to raw settings */
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
	migrate(raw: RawSettings): RawSettings {
		// queueMode -> steeringMode
		if ("queueMode" in raw && !("steeringMode" in raw)) {
			raw.steeringMode = raw.queueMode;
			delete raw.queueMode;
		}

		// lastChangelogVersion moved out of config.yml into the
		// <agentDir>/last-changelog-version marker file so version bumps no
		// longer dirty user-tracked configs. Capture for marker seeding (see
		// #seedLastChangelogVersionMarker), then strip the key — the next
		// config save drops it from disk.
		if (typeof raw.lastChangelogVersion === "string") {
			this.legacyLastChangelogVersion ??= raw.lastChangelogVersion;
		}
		delete raw.lastChangelogVersion;

		// collapseChangelog gated how much of the changelog startup dumped into the
		// terminal. Startup no longer prints release notes at all — it prints one
		// line and `/changelog` opens them on the web — so the old key has no
		// behavior left to control. Drop it rather than leave a toggle that does
		// nothing; `startup.updateNotice` governs the line that replaced it.
		delete raw.collapseChangelog;

		// ask.timeout: ms -> seconds, guessed from the magnitude of the value.
		//
		// Every other migration here is a fixed point: re-running it on its own
		// output changes nothing, which is what lets this function run on every
		// read. This one is not. It cannot be, because 2000 in the file is either
		// 2000 milliseconds from the old format or 2000 seconds from the new one
		// and nothing on disk says which. So a user who legitimately wants a
		// 33-minute timeout gets 2 seconds instead, and an ask they expected to
		// wait for them auto-selects almost immediately.
		//
		// The conversion stays, because silently keeping an old ms value would
		// make the same setting wrong in the other direction for far more users.
		// What changes is that it is no longer silent: a rewrite the user did not
		// ask for is reported with both values so they can see what happened and
		// set it in seconds if the guess was wrong.
		if (raw.ask && typeof (raw.ask as Record<string, unknown>).timeout === "number") {
			const oldValue = (raw.ask as Record<string, unknown>).timeout as number;
			if (oldValue > MAX_ASK_TIMEOUT_SECONDS) {
				const converted = Math.round(oldValue / 1000);
				(raw.ask as Record<string, unknown>).timeout = converted;
				this.#reportAskTimeoutRewrite(oldValue, converted);
			}
		}

		// compaction.thresholdTokens / compaction.thresholdPercent -> compaction.threshold
		//
		// Two keys wrote one axis with an invisible precedence. Fold them into the one
		// key HERE, on load, so the ambiguity leaves the file: an absolute amount
		// becomes a bare token count, a percent becomes `85%`, and the retired keys are
		// dropped. Precedence matches the old resolver (tokens, then percent), so the
		// trigger point does not move. A `threshold` already present always wins and
		// the retired keys are dropped without being read, which is what makes this a
		// fixed point — re-running it on its own output changes nothing.
		//
		// `withLegacyCompactionThreshold` still folds them at read time, for config
		// sources this never rewrites (project files, `--config` overlays, and
		// non-persisting instances).
		const compaction = raw.compaction as Record<string, unknown> | undefined;
		if (compaction && ("thresholdTokens" in compaction || "thresholdPercent" in compaction)) {
			if (compaction.threshold === undefined) {
				const legacyTokens = compaction.thresholdTokens;
				const legacyPercent = compaction.thresholdPercent;
				if (typeof legacyTokens === "number" && Number.isFinite(legacyTokens) && legacyTokens > 0) {
					compaction.threshold = String(legacyTokens);
				} else if (typeof legacyPercent === "number" && Number.isFinite(legacyPercent) && legacyPercent > 0) {
					compaction.threshold = `${legacyPercent}%`;
				}
			}
			delete compaction.thresholdTokens;
			delete compaction.thresholdPercent;
		}

		// Optional numeric settings once stored `-1` to mean "unset", which made -1
		// unreachable as a real value: `presencePenalty: -1` is a penalty the
		// provider accepts, and it could not be configured. Unset is an ABSENT key
		// now, so the old sentinel is dropped — in every prior version it meant
		// exactly this, so nothing a user chose is lost.
		//
		// ONCE, and only in the config this instance owns. This is the one
		// migration here that cannot tell its input apart from a legitimate current
		// value, so re-running it would delete a `-1` the user typed on purpose (it
		// deleted one within a minute of the change landing, in dogfooding). The
		// stamp records that it ran; a project file or a `--config` overlay is
		// hand-written against the current docs, so a `-1` there is a value.

		// Migrate old flat "theme" string to nested theme.dark/theme.light
		if (typeof raw.theme === "string") {
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

		// task.isolation.enabled (boolean) -> task.isolation.mode (enum)
		const taskObj = raw.task as Record<string, unknown> | undefined;
		const isolationObj = taskObj?.isolation as Record<string, unknown> | undefined;
		if (isolationObj && "enabled" in isolationObj) {
			if (typeof isolationObj.enabled === "boolean") {
				isolationObj.mode = isolationObj.enabled ? "auto" : "none";
			}
			delete isolationObj.enabled;
		}

		// task.simple: removed — the task tool no longer accepts a per-call
		// schema (workflows drive structured output via eval agent()) and the
		// batch/context shape is gated by task.batch instead.
		if (taskObj && "simple" in taskObj) {
			delete taskObj.simple;
		}

		// task.eager / todo.eager: boolean -> enum (default | preferred | always).
		// `true` reproduced the previous "on" behavior, which is now `always`.
		if (taskObj && typeof taskObj.eager === "boolean") {
			taskObj.eager = taskObj.eager ? "always" : "default";
		}
		const todoObj = raw.todo as Record<string, unknown> | undefined;
		if (todoObj && typeof todoObj.eager === "boolean") {
			todoObj.eager = todoObj.eager ? "always" : "default";
		}

		// task.isolation.mode: legacy values from before the veyyon-iso PAL refactor.
		// `worktree` was git worktree → now lives under `rcopy`. `fuse-overlay`
		// and `fuse-projfs` are now the platform-named `overlayfs` / `projfs`
		// kinds; the PAL falls back internally when the chosen one isn't
		// available, so we don't need the old TS-side platform guards.
		if (isolationObj && typeof isolationObj.mode === "string") {
			const legacy: Record<string, string> = {
				worktree: "rcopy",
				"fuse-overlay": "overlayfs",
				"fuse-projfs": "projfs",
			};
			const mapped = legacy[isolationObj.mode as string];
			if (mapped !== undefined) {
				isolationObj.mode = mapped;
			}
		}

		// task.* / modelRoles.task -> the agent.* settings area.
		//
		// Everything about spawned agents used to be spread across `task.*`
		// operational keys, `agent.model` under Models, `modelRoles.task` in the
		// role table, and two UI-less maps (`task.agentModelOverrides`,
		// `task.disabledAgents`). This rewrites the old keys onto the one section so
		// the file has a single owner per value — no dual-read, which is how the
		// precedence tangle grew in the first place.
		this.#migrateAgentSettings(raw);

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
		// compaction.strategy: collapse every legacy strategy to summary; off also disables compaction.
		const compactionObj = raw.compaction as Record<string, unknown> | undefined;
		const migrateStrategy = (current: unknown): CompactionStrategySetting | undefined => {
			if (typeof current !== "string") return undefined;
			return migrateCompactionStrategyValue(current);
		};
		if (compactionObj) {
			if (compactionObj.strategy === "off") {
				compactionObj.strategy = "summary";
				if (compactionObj.enabled === undefined) {
					compactionObj.enabled = false;
				}
			} else {
				const migrated = migrateStrategy(compactionObj.strategy);
				if (migrated) compactionObj.strategy = migrated;
			}
			if (compactionObj.compactionModel !== undefined && compactionObj.model === undefined) {
				compactionObj.model = compactionObj.compactionModel;
				delete compactionObj.compactionModel;
			}
		}
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

		// cycleOrder: drop legacy default pseudo-role from ctrl+p order.
		const cycleOrder = raw.cycleOrder;
		if (Array.isArray(cycleOrder)) {
			raw.cycleOrder = cycleOrder.filter(role => role !== "default");
		}

		// The snapcompact image-archive engine was removed; drop any persisted
		// snapcompact.* settings so schema validation does not trip on stale keys.
		delete raw.snapcompact;
		for (const key of Object.keys(raw)) {
			if (key.startsWith("snapcompact.")) delete raw[key];
		}

		// inlineToolDescriptors: boolean -> enum (auto | on | off). The old
		// `true`/`false` mapped directly onto inline-on/inline-off, so preserve
		// the user's explicit choice; new installs get the `auto` default that
		// turns it on only for Gemini models.
		if (typeof raw.inlineToolDescriptors === "boolean") {
			raw.inlineToolDescriptors = raw.inlineToolDescriptors ? "on" : "off";
		}

		// statusLine: rename "plan_mode" segment to "mode"
		const statusLineObj = raw.statusLine as Record<string, unknown> | undefined;
		if (statusLineObj) {
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

		// providers.parallelFetch (boolean) replaced by the providers.fetch reader
		// priority enum. The new default ("auto") supersedes both old values —
		// Parallel is now a deep fallback in the auto chain rather than the first
		// choice — so drop the legacy key (flat and nested) and let the enum
		// default apply.
		const providersObj = raw.providers as Record<string, unknown> | undefined;
		if (providersObj && "parallelFetch" in providersObj) {
			delete providersObj.parallelFetch;
		}
		delete raw["providers.parallelFetch"];

		// codexResets.autoRedeem: boolean -> tri-state enum.
		// Existing explicit false keeps the old "do not run" behavior; missing
		// config now falls through to the new "unset" default, which asks before
		// the first eligible spend.
		const codexResetsObj = raw.codexResets as Record<string, unknown> | undefined;
		if (codexResetsObj && typeof codexResetsObj.autoRedeem === "boolean") {
			codexResetsObj.autoRedeem = codexResetsObj.autoRedeem ? "yes" : "no";
		}

		// Map legacy `memories.enabled` boolean to the explicit `memory.backend`
		// enum if the latter hasn't been set yet. Idempotent: subsequent
		// migrations are no-ops once memory.backend is materialised.
		const memoryBackendObj = raw.memory as Record<string, unknown> | undefined;
		const memoryBackendSet = memoryBackendObj && typeof memoryBackendObj.backend === "string";
		const memoriesObj = raw.memories as Record<string, unknown> | undefined;
		if (!memoryBackendSet && memoriesObj && typeof memoriesObj.enabled === "boolean") {
			const next = memoriesObj.enabled ? "local" : "off";
			const memoryRoot = (memoryBackendObj ?? {}) as Record<string, unknown>;
			memoryRoot.backend = next;
			raw.memory = memoryRoot;
		}

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

		// hindsight: dynamicBankId/agentName -> scoping enum + bankId
		// - dynamicBankId=true  → scoping="per-project" (closest semantic match;
		//   the legacy `agent::project::channel::user` tuple was per-project in
		//   practice — the channel/user env vars were rarely set).
		// - hindsight.agentName was only used as the agent slot in the legacy
		//   dynamic tuple; if the user customised it we surface it as the new
		//   bankId base when no explicit bankId is set.
		const hindsightObj = raw.hindsight as Record<string, unknown> | undefined;
		if (hindsightObj) {
			if ("dynamicBankId" in hindsightObj) {
				if (!("scoping" in hindsightObj) && hindsightObj.dynamicBankId === true) {
					hindsightObj.scoping = "per-project";
				}
				delete hindsightObj.dynamicBankId;
			}
			if ("agentName" in hindsightObj) {
				const agentName = hindsightObj.agentName;
				if (
					!("bankId" in hindsightObj) &&
					typeof agentName === "string" &&
					agentName.trim().length > 0 &&
					agentName !== "veyyon" &&
					agentName !== "omp"
				) {
					hindsightObj.bankId = agentName;
				}
				delete hindsightObj.agentName;
			}
		}

		// power.preventIdleSleep / power.preventSystemSleep / power.declareUserActive
		// / power.preventDisplaySleep (four booleans) → power.sleepPrevention enum.
		// The enum is cumulative: each level adds the flags of all lower levels.
		// Migration picks the highest level whose condition is met, scanning from
		// most to least aggressive so a single enum value captures the old state.
		// The flat spelling of the destination needs no check: the expansion above has
		// already folded `power.sleepPrevention` into the nested tree. The legacy
		// booleans below are RETIRED keys, which the expansion leaves alone, so both
		// spellings of those are still read.
		if (!("sleepPrevention" in ((raw.power as Record<string, unknown>) ?? {}))) {
			const powerObj = raw.power as Record<string, unknown> | undefined;
			const getFlag = (key: string): boolean | undefined => {
				const nested = powerObj?.[key];
				const flat = raw[`power.${key}`];
				const value = nested ?? flat;
				return typeof value === "boolean" ? value : undefined;
			};
			const idle = getFlag("preventIdleSleep");
			const system = getFlag("preventSystemSleep");
			const user = getFlag("declareUserActive");
			const display = getFlag("preventDisplaySleep");
			const anySet = idle !== undefined || system !== undefined || user !== undefined || display !== undefined;
			if (anySet) {
				const mode = system || user ? "system" : display ? "display" : idle !== false ? "idle" : "off";
				const powerRoot = (powerObj ?? {}) as Record<string, unknown>;
				powerRoot.sleepPrevention = mode;
				raw.power = powerRoot;
			}
			// Clean up old keys (nested + flat)
			if (powerObj) {
				delete powerObj.preventIdleSleep;
				delete powerObj.preventSystemSleep;
				delete powerObj.declareUserActive;
				delete powerObj.preventDisplaySleep;
			}
			delete raw["power.preventIdleSleep"];
			delete raw["power.preventSystemSleep"];
			delete raw["power.declareUserActive"];
			delete raw["power.preventDisplaySleep"];
		}

		// Tool-name arrays use canonical wire IDs and remain deduplicated.
		const migrateToolNameList = (names: unknown): unknown => {
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
		};
		const ensureToolsObject = (): Record<string, unknown> => {
			const current = raw.tools;
			if (isRecord(current)) {
				return current as Record<string, unknown>;
			}
			const created: Record<string, unknown> = {};
			raw.tools = created;
			return created;
		};
		const toolsObj = raw.tools as Record<string, unknown> | undefined;
		if (toolsObj && "essentialOverride" in toolsObj) {
			toolsObj.essentialOverride = migrateToolNameList(toolsObj.essentialOverride);
		}
		if ("tools.essentialOverride" in raw) {
			const nestedToolsObj = ensureToolsObject();
			if (!("essentialOverride" in nestedToolsObj)) {
				nestedToolsObj.essentialOverride = migrateToolNameList(raw["tools.essentialOverride"]);
			}
			delete raw["tools.essentialOverride"];
		}

		// Retired per-engine enable flags no longer control the canonical search
		// tool, which is part of the default inventory. Preserve only the text
		// context settings; canonical values win when both generations exist.
		const legacySetting = (section: string, key: string): unknown => {
			const nested = raw[section];
			if (isRecord(nested) && key in nested) return nested[key];
			return raw[`${section}.${key}`];
		};
		const legacyContextBefore = legacySetting("grep", "contextBefore");
		const legacyContextAfter = legacySetting("grep", "contextAfter");
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

		// serviceTier (single enum with scoped openai-only/claude-only sentinels)
		// → per-family tier.openai/tier.anthropic/tier.google; serviceTierSubagent
		// → tier.agent; serviceTierAdvisor → tier.advisor. `fastModeScope` is
		// dropped — per-family scoping is now expressed by the three tier settings.
		const tierObj = isRecord(raw.tier) ? raw.tier : {};
		let tierTouched = false;
		const setTier = (family: string, value: unknown): void => {
			if (value !== undefined && !(family in tierObj)) {
				tierObj[family] = value;
				tierTouched = true;
			}
		};
		if (typeof raw.serviceTier === "string") {
			switch (raw.serviceTier) {
				case "priority":
					setTier("openai", "priority");
					setTier("anthropic", "priority");
					setTier("google", "priority");
					break;
				case "openai-only":
					setTier("openai", "priority");
					break;
				case "claude-only":
					setTier("anthropic", "priority");
					break;
				case "auto":
				case "default":
				case "flex":
				case "scale":
					setTier("openai", raw.serviceTier);
					break;
			}
			delete raw.serviceTier;
		}
		const mapInheritTier = (value: unknown): unknown =>
			value === "openai-only" || value === "claude-only" ? "priority" : value;
		if ("serviceTierSubagent" in raw) {
			setTier("agent", mapInheritTier(raw.serviceTierSubagent));
			delete raw.serviceTierSubagent;
		}
		// The `subagent` vocabulary became `agent`: the whole `subagent.*` area
		// moved to `agent.*` leaf for leaf, and the three keys other areas kept
		// under the old word moved with it. New wins, legacy is deleted, so this is
		// a fixed point like the rest of this method.
		if ("subagent" in tierObj) {
			setTier("agent", tierObj.subagent);
			delete tierObj.subagent;
			tierTouched = true;
		}
		if ("serviceTierAdvisor" in raw) {
			setTier("advisor", mapInheritTier(raw.serviceTierAdvisor));
			delete raw.serviceTierAdvisor;
		}
		if (tierTouched) raw.tier = tierObj;
		delete raw.fastModeScope;

		// argot.models / argot.disableAboveTokens -> argot.encode.*
		//
		// The two keys that gate ENCODING are grouped under the sub-feature they
		// belong to, the way `read.summarize.*` and `bash.autoBackground.*` are.
		// They are the only two of Argot's six settings that decide whether the
		// model is taught to WRITE shorthand; `enabled`, `autoload`, `tokenBudget`
		// and `agents` decide whether the feature runs, when a dictionary is
		// built, how large it is, and what a child agent starts with. Reading a
		// flat `argot.models` gave no hint that it governs one side of the feature
		// while decoding is unconditional, which is the distinction an operator has
		// to hold to predict what turning it off does.
		//
		// The nested spelling always wins and the flat one is dropped without being
		// read, which is what makes this a fixed point: re-running it on its own
		// output changes nothing, and it has to be, because it runs on every load of
		// every source. `argot` keeps its other keys, so no empty husk is possible.
		// Both spellings have to be folded. `#expandDottedSettingKeys` above only expands
		// REGISTERED paths, and these two are retired, so a literal `argot.models:` key
		// written flat in a config file survives it untouched and would otherwise sit in
		// the tree forever with nothing reading it.
		for (const key of ["models", "disableAboveTokens"] as const) {
			const flat = `argot.${key}`;
			if (!(flat in raw)) continue;
			if (getByPath(raw, ["argot", "encode", key]) === undefined) {
				setByPath(raw, ["argot", "encode", key], raw[flat]);
			}
			delete raw[flat];
		}

		const argotObj = raw.argot as Record<string, unknown> | undefined;
		if (argotObj) {
			for (const key of ["models", "disableAboveTokens"] as const) {
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

		return raw;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings Class
// ═══════════════════════════════════════════════════════════════════════════

export class Settings extends SettingsStore {
	readonly #hooks: CodingAgentSettingsHooks;

	private constructor(options: SettingsOptions = {}) {
		const hooks = new CodingAgentSettingsHooks();
		super(options, hooks);
		this.#hooks = hooks;
	}

	/** A fork or a clone of a product store is a product store. */
	override newInstance(options: SettingsOptions): this {
		return new Settings(options) as this;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Factory Methods
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Initialize the global singleton.
	 * Call once at startup before accessing `settings`.
	 */
	static init(options: SettingsOptions = {}): Promise<Settings> {
		const inFlight = settingsInstancePromise();
		if (inFlight) return inFlight;

		// The promise recorded in the slot is the one that FILLS the slot, not the bare load. They are not
		// interchangeable: the bare load settles first, so a second caller awaiting it could resume before
		// `globalInstance` was set and see `isSettingsInitialized()` return false straight after `await
		// Settings.init()`. Recording the derived promise also makes `init()` return the same object every
		// time, which is what makes "a second init joins the first" checkable rather than merely likely.
		const instance = new Settings(options);
		const ready = instance.load().then(
			loaded => {
				setSettingsInstance(loaded);
				return loaded;
			},
			error => {
				setSettingsInstance(null);
				setSettingsInstancePromise(null);
				throw error;
			},
		);
		setSettingsInstancePromise(ready);
		return ready;
	}

	/**
	 * Load effective settings from config.yml and project providers without
	 * opening agent.db, migrating legacy settings, or writing marker files.
	 */
	static loadReadOnly(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings({ ...options, readOnly: true });
		return instance.loadReadOnly();
	}

	/**
	 * Load a persisted settings instance without touching the global singleton.
	 */
	static loadIsolated(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings(options);
		return instance.load();
	}

	/**
	 * Create an isolated instance for testing.
	 * Does not affect the global singleton.
	 */
	static isolated(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
		const instance = new Settings({ inMemory: true, overrides });
		instance.rebuildMerged();
		return instance;
	}

	/**
	 * Get the global singleton.
	 * Throws if not initialized.
	 */
	static get instance(): Settings {
		return settingsOrThrow();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Accessors
	// ─────────────────────────────────────────────────────────────────────────

	getPlansDirectory(): string {
		return path.join(this.getAgentDir(), "plans");
	}

	/**
	 * Get shell configuration based on settings.
	 */
	getShellConfig() {
		const shell = this.get("shellPath");
		return procmgr.getShellConfig(shell);
	}

	/**
	 * Get all settings in a group with full type safety.
	 */
	getGroup<G extends GroupPrefix>(prefix: G): GroupTypeMap[G] {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			if (key.startsWith(`${prefix}.`)) {
				const suffix = key.slice(prefix.length + 1);
				result[suffix] = this.get(key);
			}
		}
		return result as unknown as GroupTypeMap[G];
	}

	/**
	 * Get the edit variant for a specific model.
	 * Returns "patch", "replace", "hashline", "apply_patch", or null (use global default).
	 */
	getEditVariantForModel(model: string | undefined): EditMode | null {
		if (!model) return null;
		const variants = this.#getEditVariantEntries();
		if (variants.length === 0) return null;

		const modelLower = model.toLowerCase();

		for (let i = 0; i < variants.length; i++) {
			const variant = variants[i];
			if (modelLower.includes(variant.patternLower)) {
				return variant.mode;
			}
		}
		return null;
	}

	#getEditVariantEntries(): readonly EditVariantEntry[] {
		if (this.#hooks.editVariantCache !== undefined) return this.#hooks.editVariantCache;

		const value = this.get("edit.modelVariants");
		if (!isRecord(value)) {
			this.#hooks.editVariantCache = [];
			return this.#hooks.editVariantCache;
		}

		const variants: EditVariantEntry[] = [];
		for (const pattern in value) {
			if (!Object.hasOwn(value, pattern)) continue;
			const rawMode = value[pattern];
			if (typeof rawMode !== "string") continue;
			const mode = normalizeEditMode(rawMode);
			if (mode) {
				variants.push({ patternLower: pattern.toLowerCase(), mode });
			}
		}

		this.#hooks.editVariantCache = variants;
		return variants;
	}

	/**
	 * Get bash interceptor rules (typed accessor for complex array config).
	 */
	getBashInterceptorRules(): BashInterceptorRule[] {
		return this.get("bashInterceptor.patterns");
	}

	#modelRoleFromLayer(layer: "profile" | "config-file" | "runtime", role: ModelRole | string): string | undefined {
		const value = this.layerValue(layer, ["modelRoles"]);
		if (!isRecord(value)) return undefined;
		return modelRoleValueFromUnknown(value[role]);
	}

	#modelRolesFromLayer(layer: "profile" | "config-file" | "runtime"): Record<string, string> {
		const value = this.layerValue(layer, ["modelRoles"]);
		if (!isRecord(value)) return {};

		const roles: Record<string, string> = {};
		for (const role in value) {
			if (!Object.hasOwn(value, role)) continue;
			const modelId = modelRoleValueFromUnknown(value[role]);
			if (modelId !== undefined) {
				roles[role] = modelId;
			}
		}
		return roles;
	}

	/** Return one role from the profile layer, excluding project and runtime overrides. */
	getPersistedModelRole(role: ModelRole | string): string | undefined {
		return this.#modelRoleFromLayer("profile", role);
	}

	/** Identify the layer that supplies one effective model-role slot. */
	getModelRoleSource(role: ModelRole | string): SettingSource {
		if (this.#modelRoleFromLayer("runtime", role) !== undefined) return "runtime";
		if (this.#modelRoleFromLayer("config-file", role) !== undefined) return "config-file";
		if (this.#modelRoleFromLayer("profile", role) !== undefined) return "profile";
		return "default";
	}

	/**
	 * Persist one profile role without rewriting a higher-precedence override.
	 *
	 * This is the storage contract for profile-default controls. Interactive
	 * session model switches continue to use {@link setModelRole}.
	 */
	setPersistedModelRole(role: ModelRole | string, modelId: string | undefined): void {
		const current = this.#modelRolesFromLayer("profile");
		if (modelId === undefined) delete current[role];
		else current[role] = modelId;
		this.set("modelRoles", current);
	}

	/**
	 * Set a model role (helper for modelRoles record). Passing `undefined`
	 * clears the role from the persisted record and any runtime override.
	 */
	setModelRole(role: ModelRole | string, modelId: string | undefined): void {
		const current = this.#modelRolesFromLayer("profile");
		const runtimeOverrides = this.layerValue("runtime", ["modelRoles"]);
		const updateRuntimeOverride =
			!!runtimeOverrides &&
			typeof runtimeOverrides === "object" &&
			!Array.isArray(runtimeOverrides) &&
			Object.hasOwn(runtimeOverrides, role);

		if (modelId === undefined) {
			delete current[role];
		} else {
			current[role] = modelId;
		}
		this.set("modelRoles", current);

		if (updateRuntimeOverride) {
			const nextRuntimeOverride = this.#modelRolesFromLayer("runtime");
			if (modelId === undefined) {
				delete nextRuntimeOverride[role];
			} else {
				nextRuntimeOverride[role] = modelId;
			}
			this.override("modelRoles", nextRuntimeOverride);
		}
	}

	/**
	 * Get a model role (helper for modelRoles record).
	 */
	getModelRole(role: ModelRole | string): string | undefined {
		const roles: unknown = this.get("modelRoles");
		if (!isRecord(roles)) return undefined;
		return modelRoleValueFromUnknown(roles[role]);
	}

	/**
	 * Get all model roles (helper for modelRoles record).
	 */
	getModelRoles(): ReadOnlyDict<string> {
		const roles: unknown = this.get("modelRoles");
		if (!isRecord(roles)) return {};

		const normalized: Record<string, string> = {};
		for (const role in roles) {
			if (!Object.hasOwn(roles, role)) continue;
			const modelId = modelRoleValueFromUnknown(roles[role]);
			if (modelId !== undefined) {
				normalized[role] = modelId;
			}
		}
		return normalized;
	}

	/*
	 * Override model roles (helper for modelRoles record).
	 */
	overrideModelRoles(roles: ReadOnlyDict<string>): void {
		const next = this.#modelRolesFromLayer("runtime");
		for (const [role, modelId] of Object.entries(roles)) {
			if (modelId) {
				next[role] = modelId;
			}
		}
		this.override("modelRoles", next);
	}

	/**
	 * Set disabled providers (for compatibility with discovery system).
	 */
	setDisabledProviders(ids: string[]): void {
		this.set("disabledProviders", ids);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Setting Hooks
// ═══════════════════════════════════════════════════════════════════════════

type SettingHook<P extends SettingPath> = (value: SettingValue<P>, prev: SettingValue<P>) => void;

const SETTING_HOOKS: Partial<Record<SettingPath, SettingHook<any>>> = {
	"theme.dark": value => {
		if (typeof value === "string") {
			autoThemeMappingSignal.fire("dark", value);
		}
	},
	"theme.light": value => {
		if (typeof value === "string") {
			autoThemeMappingSignal.fire("light", value);
		}
	},
	symbolPreset: value => {
		if (typeof value === "string" && (value === "unicode" || value === "nerd" || value === "ascii")) {
			symbolPresetSignal.fire(value);
		}
	},
	colorBlindMode: value => {
		if (typeof value === "boolean") {
			colorBlindModeSignal.fire(value);
		}
	},
	"provider.appendOnlyContext": value => {
		if (typeof value === "string") {
			appendOnlyModeSignal.fire(value);
		}
	},
	"providers.maxInFlightRequests": value => {
		configureProviderMaxInFlightRequests(validateProviderMaxInFlightRequests(value));
	},
	"hindsight.bankId": () => hindsightScopeSignal.fire(),
	"hindsight.bankIdPrefix": () => hindsightScopeSignal.fire(),
	"hindsight.scoping": () => hindsightScopeSignal.fire(),
	"worktree.base": value => {
		const dir = typeof value === "string" && value.trim() ? value : undefined;
		// Always call so an unset/empty value clears a previously-applied override.
		// setWorktreesDir expands `~`, rejects relative paths, and returns the
		// applied absolute path (or undefined when cleared/rejected).
		if (dir && !setWorktreesDir(dir)) {
			logger.warn("Settings: worktree.base must be an absolute or ~-relative path; ignoring", { value: dir });
		} else if (!dir) {
			setWorktreesDir(undefined);
		}
	},
};

// ═══════════════════════════════════════════════════════════════════════════
// Global Singleton
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Teardown a downstream module asks `resetSettingsForTest` to run.
 *
 * The registry lives in `./settings-instance.ts` with the slot, and is re-exported here because this is
 * the name callers import. A module that only REGISTERS should import the leaf: `theme/markdown-theme.ts`
 * registers one hook and paid 95 modules of settings store for the privilege.
 *
 * @internal
 */
export { registerSettingsTestResetHook } from "./settings-instance";

/**
 * Reset the global singleton for testing.
 *
 * The signal listeners go too, and that is the point rather than a detail. A `SettingSignal`
 * subscription lives at module scope, so it outlives the `Settings` instance it was made against
 * and outlives the test file that made it. Anything that subscribed and did not unsubscribe stayed
 * attached for the rest of the process, and the next write to that setting called it -- a callback
 * closed over a torn-down instance, still free to write to the theme, the symbol preset or the
 * colour-blind flag, all of which are module-scope state of their own.
 *
 * That is cumulative rather than order-dependent, which is why it looked like nothing: a suite
 * passes alone and passes after two hundred predecessors, then fails somewhere past a thousand,
 * with a different case each run. The mermaid renderer producing NO output at all in a large run is
 * the recognisable shape of it, since what it renders depends on exactly this state.
 *
 * A listener that outlives its owner is a leak in a long session too, not only under a test runner;
 * `settingSignalListenerCounts` exists so a guard test can prove the set returns to empty.
 *
 * @internal
 */
export function resetSettingsForTest(): void {
	setSettingsInstance(null);
	setSettingsInstancePromise(null);
	configureProviderMaxInFlightRequests(undefined);
	clearSettingSignals();
	runSettingsTestResetHooks();
}

/**
 * The global settings singleton and the check for whether it exists yet.
 *
 * Both live in `./settings-instance.ts`, which owns the slot and imports nothing at runtime, and are
 * re-exported here because this is the name every caller already imports. A caller that needs only the
 * value should import the leaf directly: reaching it through this module costs 94 modules of store.
 */
export { isSettingsInitialized, settings } from "./settings-instance";
