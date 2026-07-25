/**
 * Built-in model roles and role metadata helpers.
 */

// Import from the leaf color module, not the heavy `theme` barrel. The barrel pulls
// modes/theme/shimmer -> config/settings -> discovery -> ... -> config/model-resolver,
// and model-resolver imports this file back, so routing through the barrel forms an
// import cycle whose top-level `const MODEL_ROLE_ALIAS_PREFIXES = [...]` reads this
// module's still-uninitialized exports (a TDZ ReferenceError) whenever model-roles is
// the entry point. color.ts is a true leaf (arktype only), so this edge breaks the cycle.
import { isValidThemeColor, type ThemeColor } from "../modes/theme/color";
import type { Settings } from "./settings";

/** Canonical prefix for a configured model role selector. */
export const MODEL_ROLE_ALIAS_PREFIX = "@";

/** Legacy prefix accepted for backwards-compatible role selectors. */
export const LEGACY_MODEL_ROLE_ALIAS_PREFIX = "pi/";

/** Shorthand selector for the default model role. */
export const DEFAULT_MODEL_ROLE_ALIAS = "*";

/** Format a model role as its canonical selector. */
export function formatModelRoleAlias(role: string): string {
	return `${MODEL_ROLE_ALIAS_PREFIX}${role}`;
}

export type ModelRole = "default" | "smol" | "slow" | "vision" | "plan" | "designer" | "commit" | "tiny" | "advisor";

export interface ModelRoleInfo {
	tag?: string;
	name: string;
	color?: ThemeColor;
	/** If true, the role is functional but not shown in the model selector UI. */
	hidden?: boolean;
	/**
	 * What an unset role resolves to, shown in role pickers. EVERY role inherits
	 * the live main model when unset (resolveRoleSelectionWithInherit) — no role
	 * carries a built-in model chain, so a picker never has to explain a model
	 * the operator did not choose.
	 */
	unsetLabel?: string;
}

/** Picker label for roles that follow the live main model when unset. */
export const ROLE_INHERIT_LABEL = "inherit (follows main model)";

/**
 * There is deliberately NO `task` role. The model a subagent runs lives in the
 * Subagents settings area (`subagent.model`, and `subagent.agents.<name>.model`
 * per agent), which is its one owner. A `modelRoles.task` entry beside those was
 * a second owner for the same value, and it is what made "I changed the subagent
 * model" fail to take: role expansion answered first. Old configs are migrated
 * onto `subagent.model`; see `#migrateSubagentSettings`.
 */
export const MODEL_ROLES: Record<ModelRole, ModelRoleInfo> = {
	/** Legacy only — not selectable; interactive model is the session model, not a role. */
	default: { tag: "DEFAULT", name: "Default", color: "success", hidden: true },
	smol: { tag: "SMOL", name: "Fast", color: "warning" },
	slow: { tag: "SLOW", name: "Thinking", color: "accent" },
	vision: { tag: "VISION", name: "Vision", color: "error" },
	plan: { tag: "PLAN", name: "Architect", color: "muted" },
	designer: { tag: "DESIGNER", name: "Designer", color: "muted" },
	commit: { tag: "COMMIT", name: "Commit", color: "dim" },
	tiny: { tag: "TINY", name: "Tiny", color: "dim" },
	advisor: { tag: "ADVISOR", name: "Advisor", color: "accent" },
};

export const MODEL_ROLE_IDS: ModelRole[] = ["smol", "slow", "vision", "plan", "designer", "commit", "tiny", "advisor"];

/** Built-in roles that may appear in settings-backed role assignment UI. */
export const SELECTABLE_MODEL_ROLE_IDS: ModelRole[] = MODEL_ROLE_IDS;

/**
 * The slot every interactive model choice persists to, and the ONE name for it.
 *
 * It is not a selectable role: pickers list the named roles (smol, slow, plan, …)
 * while this holds "the model you are working with", the one startup restores.
 */
export const DEFAULT_MODEL_SLOT = "default" as const;

/**
 * Every spelling a CALLER may pass to mean {@link DEFAULT_MODEL_SLOT}.
 *
 * The slot accumulated names — `default` in storage, `interactive` in `setModel`'s
 * parameter default and in the session log — with the translation between them
 * written inline at each call site, including one line that stored `default` and
 * logged `interactive` for the same write (operator review 2026-07-24). Callers now
 * pass whatever they have and {@link resolveModelSlot} translates, once, here.
 *
 * This is about role arguments only. Enumerating CONFIGURED roles (cycle order,
 * `modelRoles` keys) compares against {@link DEFAULT_MODEL_SLOT} itself, because
 * storage only ever holds the canonical key and a custom role a user happened to
 * name `interactive` must still appear in pickers.
 */
export const DEFAULT_MODEL_SLOT_ALIASES: readonly string[] = ["default", "interactive"];

/** True when `role` is any spelling of the default slot. */
export function isDefaultModelSlot(role: string): boolean {
	return DEFAULT_MODEL_SLOT_ALIASES.includes(role);
}

/**
 * The slot a role name refers to: any alias of the default slot collapses to
 * {@link DEFAULT_MODEL_SLOT}, and every named role passes through unchanged.
 *
 * This is the single translation point. Comparing a role against `"interactive"`
 * or `"default"` anywhere else re-creates the divergence this replaced.
 */
export function resolveModelSlot(role: string): string {
	return isDefaultModelSlot(role) ? DEFAULT_MODEL_SLOT : role;
}

export type RoleInfo = ModelRoleInfo;

/**
 * Return the canonical set of known roles for selector/carousel UI.
 *
 * Built-ins always come first. Configured cycle order, model assignments, and
 * tag metadata can introduce additional custom roles without requiring duplicate
 * entries across settings.
 */
export function getKnownRoleIds(settings: Settings): string[] {
	const roles = SELECTABLE_MODEL_ROLE_IDS.filter(role => !MODEL_ROLES[role as ModelRole]?.hidden) as string[];
	const seen = new Set<string>(roles);
	const addRole = (role: string) => {
		if (seen.has(role)) return;
		seen.add(role);
		roles.push(role);
	};

	for (const role of settings.get("cycleOrder")) {
		if (role === DEFAULT_MODEL_SLOT) continue;
		addRole(role);
	}
	for (const role in settings.getModelRoles()) {
		if (role === DEFAULT_MODEL_SLOT) continue;
		addRole(role);
	}
	for (const role in settings.get("modelTags")) addRole(role);

	return roles;
}

/**
 * Get role info for a role name (built-in or custom).
 * Configured metadata overrides built-in defaults when present.
 */
export function getRoleInfo(role: string, settings: Settings): RoleInfo {
	const builtIn = role in MODEL_ROLES ? MODEL_ROLES[role as ModelRole] : undefined;
	const configured = settings.get("modelTags")[role];

	if (configured) {
		return {
			tag: builtIn?.tag,
			name: configured.name || builtIn?.name || role,
			color: configured.color && isValidThemeColor(configured.color) ? configured.color : builtIn?.color,
			hidden: configured.hidden ?? builtIn?.hidden,
			unsetLabel: builtIn?.unsetLabel,
		};
	}

	if (builtIn) return builtIn;

	return { name: role, color: "muted" };
}
