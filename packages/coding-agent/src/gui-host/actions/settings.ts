import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync } from "@veyyon/utils/atomic-write";
import { syncYamlTextToSettings } from "@veyyon/utils/yaml-sync";
import { YAML } from "bun";
import { KEYBINDINGS, KeybindingsManager } from "../../config/keybindings";
import { Settings } from "../../config/settings";
import {
	describeSettingTypeMismatch,
	getDefault,
	getUi,
	SETTINGS_SCHEMA,
	type SettingPath,
} from "../../config/settings-schema";
import { getAvailableThemes, isLightTheme } from "../../modes/theme/theme";
import type { KeybindingView, SettingEntryView, ThemesView, ThemeView } from "../wire";
import type { ActionHandler, ActionHandlersMap } from "./types";

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
			// JSON.stringify drops undefined fields, so an entry emitted with one
			// arrives at the desktop missing value or default and fails to
			// decode; treat an unresolvable pair as an unresolvable setting.
			if (value === undefined || defaultValue === undefined) {
				continue;
			}
			dumped[key] = {
				value,
				default: defaultValue,
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
				hidden: ui?.hidden === true || "retiredBy" in def,
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
		const settings =
			ctx.clientState.agentSession?.settings ??
			(await Settings.loadIsolated({ cwd: ctx.cwd, agentDir: ctx.agentDir }));
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			Settings: dumpSettings(settings),
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Settings",
			code: "SETTINGS_LOAD_FAILED",
			message: error instanceof Error ? error.message : String(error),
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
		const settings =
			ctx.clientState.agentSession?.settings ??
			(await Settings.loadIsolated({ cwd: ctx.cwd, agentDir: ctx.agentDir }));
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
			message: error instanceof Error ? error.message : String(error),
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
		const settings =
			ctx.clientState.agentSession?.settings ??
			(await Settings.loadIsolated({ cwd: ctx.cwd, agentDir: ctx.agentDir }));
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
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

const handleLoadThemes: ActionHandler = async ctx => {
	try {
		const themeNames = await getAvailableThemes();
		const settings =
			ctx.clientState.agentSession?.settings ??
			(await Settings.loadIsolated({ cwd: ctx.cwd, agentDir: ctx.agentDir }));

		const themes: ThemeView[] = themeNames.map(name => ({
			id: name,
			name,
			dark: !isLightTheme(name),
		}));
		const current = (settings.get("theme" as never) as string) ?? "dark";

		const themesView: ThemesView = {
			themes,
			current,
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
			message: error instanceof Error ? error.message : String(error),
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
	binding?: string;
	command?: string;
}

const handleSetKeybinding: ActionHandler<SetKeybindingPayload | undefined> = (ctx, payload) => {
	const action = payload?.action ?? payload?.command;
	const keys = payload?.keys ?? (payload?.binding ? [payload.binding] : undefined);

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
			message: error instanceof Error ? error.message : String(error),
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
