import { isValidThemeColor, type ThemeColor } from "../modes/theme/color";
import type { Settings } from "./settings";

export const MODEL_ROLE_ALIAS_PREFIX = "@";

export const LEGACY_MODEL_ROLE_ALIAS_PREFIX = "pi/";

export const DEFAULT_MODEL_ROLE_ALIAS = "*";

export function formatModelRoleAlias(role: string): string {
	return `${MODEL_ROLE_ALIAS_PREFIX}${role}`;
}

export type ModelRole = "default" | "smol" | "slow" | "vision" | "plan" | "designer" | "commit" | "tiny" | "advisor";

export interface ModelRoleInfo {
	tag?: string;
	name: string;
	color?: ThemeColor;
	hidden?: boolean;
	unsetLabel?: string;
}

export const ROLE_INHERIT_LABEL = "inherit (follows main model)";

export const MODEL_ROLES: Record<ModelRole, ModelRoleInfo> = {
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

export const SELECTABLE_MODEL_ROLE_IDS: ModelRole[] = MODEL_ROLE_IDS;

export const DEFAULT_MODEL_SLOT = "default" as const;

export const DEFAULT_MODEL_SLOT_ALIASES: readonly string[] = ["default", "interactive"];

export function isDefaultModelSlot(role: string): boolean {
	return DEFAULT_MODEL_SLOT_ALIASES.includes(role);
}

export function resolveModelSlot(role: string): string {
	return isDefaultModelSlot(role) ? DEFAULT_MODEL_SLOT : role;
}

export type RoleInfo = ModelRoleInfo;

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
