import * as fs from "node:fs";
import * as path from "node:path";
import {
	type Keybinding,
	type KeybindingsConfig,
	type KeyId,
	setKeybindings,
	KeybindingsManager as TuiKeybindingsManager,
} from "@veyyon/tui";
import { atomicWriteFileSync } from "@veyyon/utils/atomic-write";
import { getActiveProfile, getAgentDir, getProfileRootDir } from "@veyyon/utils/dirs";
import { isEnoent } from "@veyyon/utils/fs-error";
import * as logger from "@veyyon/utils/logger";
import { quarantineUnparseableFileSync } from "@veyyon/utils/quarantine-file";
import { syncYamlTextToSettings } from "@veyyon/utils/yaml-sync";
import { JSONC, YAML } from "bun";

export { type AppKeybinding, getDefaultPasteImageKeys, KEYBINDINGS } from "./keybinding-defs";

import type { AppKeybinding } from "./keybinding-defs";
import { KEYBINDINGS } from "./keybinding-defs";

const KEYBINDING_NAME_MIGRATIONS = {
	interrupt: "app.interrupt",
	clear: "app.clear",
	exit: "app.exit",
	suspend: "app.suspend",
	displayReset: "app.display.reset",
	cycleThinkingLevel: "app.thinking.cycle",
	cycleModelForward: "app.model.cycleForward",
	cycleModelBackward: "app.model.cycleBackward",
	selectModel: "app.model.select",
	selectModelTemporary: "app.model.selectTemporary",
	togglePlanMode: "app.plan.toggle",
	historySearch: "app.history.search",
	expandTools: "app.tools.expand",
	toggleThinking: "app.thinking.toggle",
	externalEditor: "app.editor.external",
	followUp: "app.message.followUp",
	retry: "app.retry",
	dequeue: "app.message.dequeue",
	pasteImage: "app.clipboard.pasteImage",
	pasteTextRaw: "app.clipboard.pasteTextRaw",
	copyLine: "app.clipboard.copyLine",
	copyPrompt: "app.clipboard.copyPrompt",
	newSession: "app.session.new",
	tree: "app.session.tree",
	fork: "app.session.fork",
	resume: "app.session.resume",
	observeSessions: "app.session.observe",
	toggleSTT: "app.stt.toggle",
	cursorUp: "tui.editor.cursorUp",
	cursorDown: "tui.editor.cursorDown",
	cursorLeft: "tui.editor.cursorLeft",
	cursorRight: "tui.editor.cursorRight",
	cursorWordLeft: "tui.editor.cursorWordLeft",
	cursorWordRight: "tui.editor.cursorWordRight",
	cursorLineStart: "tui.editor.cursorLineStart",
	cursorLineEnd: "tui.editor.cursorLineEnd",
	jumpForward: "tui.editor.jumpForward",
	jumpBackward: "tui.editor.jumpBackward",
	pageUp: "tui.editor.pageUp",
	pageDown: "tui.editor.pageDown",
	deleteCharBackward: "tui.editor.deleteCharBackward",
	deleteCharForward: "tui.editor.deleteCharForward",
	deleteWordBackward: "tui.editor.deleteWordBackward",
	deleteWordForward: "tui.editor.deleteWordForward",
	deleteToLineStart: "tui.editor.deleteToLineStart",
	deleteToLineEnd: "tui.editor.deleteToLineEnd",
	yank: "tui.editor.yank",
	yankPop: "tui.editor.yankPop",
	undo: "tui.editor.undo",
	newLine: "tui.input.newLine",
	submit: "tui.input.submit",
	tab: "tui.input.tab",
	selectUp: "tui.select.up",
	selectDown: "tui.select.down",
	selectPageUp: "tui.select.pageUp",
	selectPageDown: "tui.select.pageDown",
	selectConfirm: "tui.select.confirm",
	selectCancel: "tui.select.cancel",
} as const satisfies Record<string, Keybinding>;

function isLegacyKeybindingName(key: string): key is keyof typeof KEYBINDING_NAME_MIGRATIONS {
	return key in KEYBINDING_NAME_MIGRATIONS;
}

function toKeybindingsConfig(value: unknown): KeybindingsConfig {
	if (typeof value !== "object" || value === null) {
		return {};
	}

	const config: KeybindingsConfig = {};
	for (const [key, val] of Object.entries(value)) {
		if (val === undefined) {
			config[key] = undefined;
		} else if (typeof val === "string") {
			config[key] = val as KeyId;
		} else if (Array.isArray(val) && val.every(v => typeof v === "string")) {
			config[key] = val as KeyId[];
		}
	}
	return config;
}

function migrateKeybindingNames(rawConfig: unknown): {
	config: KeybindingsConfig;
	migrated: boolean;
} {
	const config = toKeybindingsConfig(rawConfig);
	const migrated: KeybindingsConfig = {};
	let didMigrate = false;

	for (const [key, value] of Object.entries(config)) {
		if (isLegacyKeybindingName(key)) {
			const newKey = KEYBINDING_NAME_MIGRATIONS[key];
			migrated[newKey] = value;
			didMigrate = true;
		} else {
			migrated[key] = value;
		}
	}

	return { config: migrated, migrated: didMigrate };
}

function orderKeybindingsConfig(config: KeybindingsConfig): KeybindingsConfig {
	const ordered: KeybindingsConfig = {};
	for (const key of Object.keys(KEYBINDINGS)) {
		const value = config[key];
		if (value !== undefined) {
			ordered[key] = value;
		}
	}
	for (const key of Object.keys(config)) {
		if (!(key in ordered)) {
			ordered[key] = config[key];
		}
	}
	return ordered;
}

const KEYBINDINGS_YML = "keybindings.yml";
const KEYBINDINGS_YAML = "keybindings.yaml";
const LEGACY_KEYBINDINGS_JSON = "keybindings.json";

interface KeybindingsConfigPaths {
	readPath: string;
	writeBackPath: string;
}

export interface KeybindingsCreateOptions {
	inheritedAgentDir?: string;
	seedFromDefault?: boolean;
}

function loadRawConfig(filePath: string): unknown {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		if (isEnoent(error)) return null;
		logger.warn("Failed to read keybindings config", { path: filePath, error: String(error) });
		return null;
	}

	let parsed: unknown;
	try {
		if (filePath.endsWith(".json")) {
			parsed = JSONC.parse(content);
		} else if (filePath.endsWith(".yml") || filePath.endsWith(".yaml")) {
			parsed = YAML.parse(content);
		} else {
			throw new Error(`Unsupported keybindings config extension: ${filePath}`);
		}
	} catch (error) {
		quarantineUnparseableFileSync(filePath, content, error);
		return null;
	}

	if (parsed === null || parsed === undefined) {
		return null;
	}
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		quarantineUnparseableFileSync(
			filePath,
			content,
			new Error("keybindings root must be a mapping, not a scalar or sequence"),
		);
		return null;
	}
	return parsed;
}

function writeKeybindingsConfig(filePath: string, config: KeybindingsConfig): boolean {
	try {
		let existingText = "";
		try {
			existingText = fs.readFileSync(filePath, "utf8");
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		atomicWriteFileSync(
			filePath,
			syncYamlTextToSettings(existingText, config as Record<string, unknown>, {
				renamedKeys: KEYBINDING_NAME_MIGRATIONS,
			}),
		);
		logger.debug("Migrated keybindings config", { path: filePath });
		return true;
	} catch (error) {
		logger.warn("Failed to write migrated keybindings config", { path: filePath, error: String(error) });
		return false;
	}
}

function resolveKeybindingsConfigPaths(agentDir: string): KeybindingsConfigPaths {
	const ymlPath = path.join(agentDir, KEYBINDINGS_YML);
	if (fs.existsSync(ymlPath)) {
		return { readPath: ymlPath, writeBackPath: ymlPath };
	}

	const yamlPath = path.join(agentDir, KEYBINDINGS_YAML);
	if (fs.existsSync(yamlPath)) {
		return { readPath: yamlPath, writeBackPath: yamlPath };
	}

	const jsonPath = path.join(agentDir, LEGACY_KEYBINDINGS_JSON);
	if (fs.existsSync(jsonPath)) {
		return { readPath: jsonPath, writeBackPath: ymlPath };
	}

	return { readPath: ymlPath, writeBackPath: ymlPath };
}

export function profileHasKeybindingsFile(agentDir: string): boolean {
	for (const filename of [KEYBINDINGS_YML, KEYBINDINGS_YAML, LEGACY_KEYBINDINGS_JSON]) {
		if (fs.existsSync(path.join(agentDir, filename))) return true;
	}
	return false;
}

export function seedKeybindingsFromAgentDir(targetAgentDir: string, sourceAgentDir: string): boolean {
	if (profileHasKeybindingsFile(targetAgentDir)) return false;
	const sourcePaths = resolveKeybindingsConfigPaths(sourceAgentDir);
	const rawConfig = loadRawConfig(sourcePaths.readPath);
	if (rawConfig === null) return false;

	const { config: migratedConfig } = migrateKeybindingNames(rawConfig);
	fs.mkdirSync(targetAgentDir, { recursive: true });
	const targetPath = path.join(targetAgentDir, KEYBINDINGS_YML);
	const ordered = orderKeybindingsConfig(migratedConfig);
	return writeKeybindingsConfig(targetPath, ordered);
}

function maybeSeedProfileKeybindings(agentDir: string, options: KeybindingsCreateOptions): void {
	if (options.seedFromDefault === false) return;
	if (!getActiveProfile()) return;
	if (profileHasKeybindingsFile(agentDir)) return;

	const defaultAgentDir = path.join(getProfileRootDir(undefined), "agent");
	if (path.resolve(defaultAgentDir) === path.resolve(agentDir)) return;

	if (seedKeybindingsFromAgentDir(agentDir, defaultAgentDir)) {
		logger.info("Seeded profile keybindings from the default profile (one-time)", {
			profile: getActiveProfile(),
			path: path.join(agentDir, KEYBINDINGS_YML),
		});
	}
}

function loadProfileKeybindingsConfig(agentDir: string): {
	config: KeybindingsConfig;
	profilePath: string;
} {
	const profilePaths = resolveKeybindingsConfigPaths(agentDir);
	const profile = loadKeybindingsConfig(profilePaths.readPath, profilePaths.writeBackPath);
	return { config: profile.config, profilePath: profile.persistedPath };
}

function loadKeybindingsConfig(
	filePath: string,
	writeBackPath: string | undefined,
): {
	config: KeybindingsConfig;
	persistedPath: string;
} {
	const rawConfig = loadRawConfig(filePath);

	if (rawConfig === null) {
		return { config: {}, persistedPath: filePath };
	}

	const { config: migratedConfig, migrated } = migrateKeybindingNames(rawConfig);
	const shouldWriteBack = writeBackPath !== undefined && (migrated || writeBackPath !== filePath);
	if (shouldWriteBack) {
		const ordered = orderKeybindingsConfig(migratedConfig);
		const persistedPath = writeKeybindingsConfig(writeBackPath, ordered) ? writeBackPath : filePath;
		return { config: migratedConfig, persistedPath };
	}

	return { config: migratedConfig, persistedPath: filePath };
}

function migrateKeybindingsConfigFile(agentDir: string): void {
	const { readPath, writeBackPath } = resolveKeybindingsConfigPaths(agentDir);
	loadKeybindingsConfig(readPath, writeBackPath);
}

const FOLLOW_UP_KEYBINDING: AppKeybinding = "app.message.followUp";
const WINDOWS_FOLLOW_UP_FALLBACK_KEY: KeyId = "ctrl+q";
function keyListIncludes(keys: KeyId | KeyId[] | undefined, target: KeyId): boolean {
	if (keys === undefined) return false;
	const keyList = Array.isArray(keys) ? keys : [keys];
	for (const key of keyList) {
		if (key.toLowerCase() === target) return true;
	}
	return false;
}

function userBindingClaimsKey(config: KeybindingsConfig, target: KeyId, except: Keybinding): boolean {
	for (const [keybinding, keys] of Object.entries(config)) {
		if (!(keybinding in KEYBINDINGS)) continue;
		if (keybinding === except) continue;
		if (keyListIncludes(keys, target)) return true;
	}
	return false;
}

function removeKey(keys: KeyId[], target: KeyId): KeyId[] {
	return keys.filter(key => key !== target);
}

function keyConfigValue(keys: KeyId[]): KeyId | KeyId[] {
	if (keys.length === 1) {
		const key = keys[0];
		if (key !== undefined) return key;
	}
	return keys.slice();
}

export class KeybindingsManager extends TuiKeybindingsManager {
	#configPath: string | undefined;
	#userBindings: KeybindingsConfig;

	constructor(userBindings: KeybindingsConfig = {}, configPath?: string) {
		super(KEYBINDINGS, userBindings);
		this.#configPath = configPath;
		this.#userBindings = userBindings;
	}

	static create(agentDir: string = getAgentDir(), options: KeybindingsCreateOptions = {}): KeybindingsManager {
		maybeSeedProfileKeybindings(agentDir, options);
		const { config: userBindings, profilePath } = loadProfileKeybindingsConfig(agentDir);
		const manager = new KeybindingsManager(userBindings, profilePath);
		setKeybindings(manager);
		return manager;
	}

	static inMemory(userBindings: KeybindingsConfig = {}): KeybindingsManager {
		return new KeybindingsManager(userBindings);
	}

	reload(): void {
		if (!this.#configPath) return;
		const { config: profileConfig } = KeybindingsManager.#loadFromFile(this.#configPath);
		this.setUserBindings(profileConfig);
	}

	setUserBindings(userBindings: KeybindingsConfig): void {
		this.#userBindings = userBindings;
		super.setUserBindings(userBindings);
	}

	getKeys(keybinding: Keybinding): KeyId[] {
		const keys = super.getKeys(keybinding);
		if (keybinding === FOLLOW_UP_KEYBINDING) {
			if (this.#userBindings[FOLLOW_UP_KEYBINDING] !== undefined) return keys;
			if (!userBindingClaimsKey(this.#userBindings, WINDOWS_FOLLOW_UP_FALLBACK_KEY, FOLLOW_UP_KEYBINDING)) {
				return keys;
			}
			return removeKey(keys, WINDOWS_FOLLOW_UP_FALLBACK_KEY);
		}
		return keys;
	}

	getResolvedBindings(): KeybindingsConfig {
		const resolved = super.getResolvedBindings();
		resolved[FOLLOW_UP_KEYBINDING] = keyConfigValue(this.getKeys(FOLLOW_UP_KEYBINDING));
		return resolved;
	}

	getEffectiveConfig(): KeybindingsConfig {
		return this.getResolvedBindings();
	}

	getDisplayString(keybinding: Keybinding): string {
		const keys = this.getKeys(keybinding);
		return formatKeyHints(keys.length === 0 ? [] : keys);
	}

	static #loadFromFile(
		filePath: string,
		writeBackPath?: string,
	): { config: KeybindingsConfig; persistedPath: string } {
		return loadKeybindingsConfig(filePath, writeBackPath);
	}
}

const MODIFIER_LABELS: Record<string, string> = {
	ctrl: "Ctrl",
	shift: "Shift",
	alt: "Alt",
};

const KEY_LABELS: Record<string, string> = {
	esc: "Esc",
	escape: "Esc",
	enter: "Enter",
	return: "Enter",
	space: "Space",
	tab: "Tab",
	backspace: "Backspace",
	delete: "Delete",
	home: "Home",
	end: "End",
	pageup: "PgUp",
	pagedown: "PgDn",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
};

function formatKeyPart(part: string): string {
	const lower = part.toLowerCase();
	const modifier = MODIFIER_LABELS[lower];
	if (modifier) return modifier;
	const label = KEY_LABELS[lower];
	if (label) return label;
	if (part.length === 1) return part.toUpperCase();
	return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
}

export function formatKeyHint(key: KeyId): string {
	return key.split("+").map(formatKeyPart).join("+");
}

export function formatKeyHints(keys: KeyId | KeyId[]): string {
	const list = Array.isArray(keys) ? keys : [keys];
	return list.map(formatKeyHint).join("/");
}

export type { Keybinding, KeybindingsConfig, KeyId };
export { migrateKeybindingsConfigFile };
