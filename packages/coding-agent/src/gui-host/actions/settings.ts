import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import { atomicWriteFileSync } from "@veyyon/utils/atomic-write";
import { syncYamlTextToSettings } from "@veyyon/utils/yaml-sync";
import { YAML } from "bun";
import { KEYBINDINGS, KeybindingsManager } from "../../config/keybindings";
import { SETTING_CONDITIONS, type SettingCondition } from "../../config/setting-conditions";
import type { Settings } from "../../config/settings";
import {
	describeSettingTypeMismatch,
	getDefault,
	getUi,
	SETTINGS_SCHEMA,
	type SettingPath,
} from "../../config/settings-schema";
import { getAvailableThemes, isLightTheme } from "../../theme/theme";
import { actingSettings } from "../acting-settings";
import type { KeybindingView, SettingEntryView, ThemesView, ThemeView } from "../wire";
import type { ActionHandler, ActionHandlersMap } from "./types";

/**
 * The predicates the desktop resolves a setting's `ui.condition` through.
 *
 * The settings-backed names are the shared vocabulary, so a condition declared
 * for the terminal reaches the desktop page as well. Only a capability a store
 * cannot answer is stated here.
 */
export const DESKTOP_SETTING_CONDITIONS: Record<string, SettingCondition> = {
	...SETTING_CONDITIONS,
	// A terminal answers this from its graphics protocol. The desktop window
	// decodes and draws the picture itself, so the answer is yes, and the row
	// stays on the page: `terminal.showImages` still decides whether the
	// picture is drawn and what the model is told about it.
	hasImageProtocol: () => true,
};

/**
 * Every setting with its effective value, its provenance and the schema it is
 * declared with. The desktop renders its settings screen from this alone, so
 * the copy, the choices and the bounds travel with the value rather than being
 * restated on the other side of the wire.
 */
export function dumpSettings(settings: Settings): Record<string, SettingEntryView> {
	const dumped: Record<string, SettingEntryView> = {};
	for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		const def = SETTINGS_SCHEMA[key];
		const ui = getUi(key);
		const options = Array.isArray(ui?.options) ? ui.options : [];
		try {
			const value = settings.get(key as never);
			const defaultValue = getDefault(key as never);
			// A setting with no value and no default — a memory database path
			// nobody set, an agent model chain left to the session's model —
			// crosses as null rather than being dropped. `JSON.stringify` drops
			// an undefined field, and an entry arriving without `value` or
			// `default` fails to decode, so the pair used to cost the whole row:
			// 13 settings the terminal screen offers had no row on the desktop
			// page at all. Null decodes as `Value::Null`, which every control
			// draws as empty.
			dumped[key] = {
				value: value ?? null,
				default: defaultValue ?? null,
				source: settings.getSource(key),
				type: def.type,
				label: ui?.label ?? null,
				description: ui?.description ?? null,
				tab: ui?.tab ?? null,
				group: ui?.group ?? null,
				values: "values" in def ? [...def.values] : [],
				options: options.map(option => ({
					value: option.value,
					label: option.label,
					description: option.description ?? null,
				})),
				min: ui?.min ?? null,
				max: ui?.max ?? null,
				global: ui?.scope === "global",
				advanced: ui?.advanced === true,
				hidden:
					ui?.hidden === true ||
					"retiredBy" in def ||
					(ui?.condition ? DESKTOP_SETTING_CONDITIONS[ui.condition]?.(settings) === false : false),
			};
		} catch {
			// Ignore unresolvable settings
		}
	}
	return dumped;
}

export function loadKeybindingsSnapshot(agentDir: string): KeybindingView[] {
	let rawUser: Record<string, unknown> = {};
	try {
		const ymlPath = path.join(agentDir, "keybindings.yml");
		if (fs.existsSync(ymlPath)) {
			const text = fs.readFileSync(ymlPath, "utf-8");
			rawUser = (YAML.parse(text) as Record<string, unknown>) ?? {};
		}
	} catch {
		// Ignore parse errors
	}
	const manager = KeybindingsManager.create(agentDir, { seedFromDefault: false });
	return Object.keys(KEYBINDINGS).map(action => {
		const keys = manager.getKeys(action as never);
		const isUser = rawUser[action] !== undefined;
		return {
			action,
			keys: Array.isArray(keys) ? [...keys] : [keys],
			source: isUser ? "user" : "default",
		};
	});
}

export function saveKeybindingToAgentDir(agentDir: string, action: string, keys: string[]): void {
	const ymlPath = path.join(agentDir, "keybindings.yml");
	let existingContent = "";
	try {
		existingContent = fs.readFileSync(ymlPath, "utf-8");
	} catch {
		// Ignore ENOENT
	}
	let raw: Record<string, unknown> = {};
	try {
		if (existingContent.trim()) {
			raw = (YAML.parse(existingContent) as Record<string, unknown>) ?? {};
		}
	} catch {
		// Ignore parse error
	}
	raw[action] = keys.length === 1 ? keys[0] : keys;
	fs.mkdirSync(agentDir, { recursive: true });
	const newText = syncYamlTextToSettings(existingContent, raw);
	atomicWriteFileSync(ymlPath, newText);
}

const handleLoadSettings: ActionHandler = async ctx => {
	try {
		const settings = await actingSettings(ctx);
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			Settings: dumpSettings(settings),
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Settings",
			code: "SETTINGS_LOAD_FAILED",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

interface SetSettingPayload {
	key?: string;
	value?: unknown;
}

const handleSetSetting: ActionHandler<SetSettingPayload | undefined> = async (ctx, payload) => {
	if (!payload?.key || payload.value === undefined) {
		ctx.reply.failure({
			scope: "Settings",
			code: "INVALID_ARGUMENTS",
			message: "SetSetting requires key and value parameters",
			retryable: false,
		});
		return;
	}

	if (!(payload.key in SETTINGS_SCHEMA)) {
		ctx.reply.failure({
			scope: "Settings",
			code: "INVALID_SETTING",
			message: `Unknown setting key '${payload.key}'`,
			retryable: false,
		});
		return;
	}

	const mismatch = describeSettingTypeMismatch(payload.key, payload.value);
	if (mismatch) {
		ctx.reply.failure({
			scope: "Settings",
			code: "INVALID_VALUE",
			message: mismatch,
			retryable: false,
		});
		return;
	}

	try {
		const settings = await actingSettings(ctx);
		settings.set(payload.key as never, payload.value as never);
		await settings.flush();

		ctx.reply.snapshot({
			Settings: dumpSettings(settings),
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Settings",
			code: "SET_SETTING_FAILED",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

interface ResetSettingPayload {
	key?: string;
}

const handleResetSetting: ActionHandler<ResetSettingPayload | undefined> = async (ctx, payload) => {
	if (!payload?.key) {
		ctx.reply.failure({
			scope: "Settings",
			code: "INVALID_ARGUMENTS",
			message: "ResetSetting requires a key parameter",
			retryable: false,
		});
		return;
	}

	if (!(payload.key in SETTINGS_SCHEMA)) {
		ctx.reply.failure({
			scope: "Settings",
			code: "INVALID_SETTING",
			message: `Unknown setting key '${payload.key}'`,
			retryable: false,
		});
		return;
	}

	try {
		const settings = await actingSettings(ctx);
		settings.unset(payload.key as never);
		await settings.flush();

		ctx.reply.snapshot({
			Settings: dumpSettings(settings),
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Settings",
			code: "RESET_SETTING_FAILED",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

const handleLoadThemes: ActionHandler = async ctx => {
	try {
		const themeNames = await getAvailableThemes();
		const settings = await actingSettings(ctx);

		const themes: ThemeView[] = themeNames.map(name => ({
			id: name,
			name,
			dark: !isLightTheme(name),
		}));
		const themesView: ThemesView = {
			themes,
			dark: settings.get("theme.dark") ?? SETTINGS_SCHEMA["theme.dark"].default,
			light: settings.get("theme.light") ?? SETTINGS_SCHEMA["theme.light"].default,
		};

		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			Themes: themesView,
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Settings",
			code: "THEMES_LOAD_FAILED",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

const handleLoadKeybindings: ActionHandler = ctx => {
	ctx.clientState.revision += 1;
	ctx.reply.snapshot({
		Keybindings: loadKeybindingsSnapshot(ctx.agentDir),
	});
	ctx.reply.success();
};

interface SetKeybindingPayload {
	action?: string;
	keys?: string[];
}

const handleSetKeybinding: ActionHandler<SetKeybindingPayload | undefined> = (ctx, payload) => {
	const { action, keys } = payload ?? {};

	if (!action || !keys || !Array.isArray(keys) || keys.length === 0) {
		ctx.reply.failure({
			scope: "Settings",
			code: "INVALID_ARGUMENTS",
			message: "SetKeybinding requires action and keys parameters",
			retryable: false,
		});
		return;
	}

	if (!(action in KEYBINDINGS)) {
		ctx.reply.failure({
			scope: "Settings",
			code: "UNKNOWN_ACTION",
			message: `Unknown keybinding action '${action}'`,
			retryable: false,
		});
		return;
	}

	try {
		saveKeybindingToAgentDir(ctx.agentDir, action, keys);
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			Keybindings: loadKeybindingsSnapshot(ctx.agentDir),
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Settings",
			code: "SET_KEYBINDING_FAILED",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

export const settingsActionHandlers: ActionHandlersMap = {
	LoadSettings: handleLoadSettings as ActionHandler<never>,
	SetSetting: handleSetSetting as ActionHandler<never>,
	ResetSetting: handleResetSetting as ActionHandler<never>,
	LoadThemes: handleLoadThemes as ActionHandler<never>,
	LoadKeybindings: handleLoadKeybindings as ActionHandler<never>,
	SetKeybinding: handleSetKeybinding as ActionHandler<never>,
};
