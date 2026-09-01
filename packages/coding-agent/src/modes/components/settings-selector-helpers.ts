import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Effort, Model } from "@veyyon/ai";
import type { ImageBudget, Tab } from "@veyyon/tui";
import type { ModelRegistry } from "../../config/model-registry";
import type { SettingPath, SettingSource } from "../../config/settings";
import type { SettingTab, StatusLinePreset, StatusLineSegmentId } from "../../config/settings-schema";
import { getUi, SETTING_TABS, TAB_METADATA } from "../../config/settings-schema";
import { theme } from "../../modes/theme/theme";
import type { ModalShortcut } from "./modal-shell";
import {
	barePickerSelector,
	type ModelChainSlot,
	ModelChainSubmenu,
	replaceModelChainEntry,
} from "./settings-submenus/index";

export { barePickerSelector, type ModelChainSlot, ModelChainSubmenu, replaceModelChainEntry };

export const DECIMAL_NUMBER = /^-?\d+(?:\.\d+)?$/;

export const UNSET_NUMBER_INPUT = "unset";

export function parseNumberSetting(path: SettingPath, text: string): number | typeof UNSET_NUMBER_INPUT {
	if (text.trim() === "") return UNSET_NUMBER_INPUT;
	if (!DECIMAL_NUMBER.test(text)) throw new Error(`"${text}" is not a number. Type digits only, for example 250.`);
	const parsed = Number(text);
	if (!Number.isFinite(parsed)) throw new Error(`"${text}" is too large to store.`);
	const ui = getUi(path);
	if (ui?.min !== undefined && parsed < ui.min) throw new Error(`Must be at least ${ui.min}.`);
	if (ui?.max !== undefined && parsed > ui.max) throw new Error(`Must be at most ${ui.max}.`);
	return parsed;
}

export const ADVANCED_TOGGLE_ID_PREFIX = "__advanced:";

export function advancedToggleId(tab: SettingTab): string {
	return `${ADVANCED_TOGGLE_ID_PREFIX}${tab}`;
}

export function isAdvancedToggleId(id: string): boolean {
	return id.startsWith(ADVANCED_TOGGLE_ID_PREFIX);
}

export const SETTINGS_TIPS: readonly string[] = [
	'Tip · Ask the agent: "change theme to titanium" or "what does compact do?"',
	"Tip · Ask the agent to change a setting",
];

export const SIDEBAR_GAP_COLS = 3;
export const MIN_SETTINGS_CONTENT_WIDTH = 32;

export const SETTING_SOURCE_LABELS: Record<SettingSource, string> = {
	default: "default",
	profile: "profile",
	"config-file": "--config file",
	runtime: "runtime override",
	global: "global config",
};

export const SETTINGS_SIDEBAR_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down category" },
	{ label: "right/enter settings" },
	{ label: "/ search" },
	{ label: "esc close", clickable: true, id: "close" },
];

export const SETTINGS_READ_ONLY_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "read-only" },
	{ label: "/ search" },
	{ label: "esc close", clickable: true, id: "close" },
];

export function getSettingsTabs(): Tab[] {
	const entry = (id: string, icon: string, label: string): Tab => ({
		id,
		label: icon ? `${icon} ${label}` : label,
		short: icon || label.charAt(0),
	});
	return [
		...SETTING_TABS.map(id => {
			const meta = TAB_METADATA[id];
			return entry(id, theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]), meta.label);
		}),
		entry("plugins", theme.icon.package, "Plugins"),
	];
}

export interface SettingsRuntimeContext {
	availableThinkingLevels: Effort[];
	thinkingLevel: ThinkingLevel | undefined;
	availableThemes: string[];
	availablePersonalities: string[];
	providers: string[];
	cwd: string;
	model?: Model;
	imageBudget?: ImageBudget;
	requestRender?: () => void;
	modelRegistry?: ModelRegistry;
	availableModels?: ReadonlyArray<Model>;
}

export interface StatusLinePreviewSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	sessionAccent?: boolean;
	compactThinkingLevel?: boolean;
}

export const ROLLBACK_ROW_ID = "__action:rollback";

export interface SettingsCallbacks {
	onChange: (path: SettingPath, newValue: unknown) => void;
	onThemePreview?: (theme: string) => void | Promise<void>;
	onStatusLinePreview?: (settings: StatusLinePreviewSettings) => void;
	getStatusLinePreview?: () => string;
	onPluginsChanged?: () => void | Promise<void>;
	onCancel: () => void;
	onOpenUrl?: (url: string) => void;
	onRollback?: (version: string) => Promise<void>;
	onError?: (message: string) => void;
}
