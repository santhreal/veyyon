import {
	type Keybinding,
	type KeybindingsConfig,
	type KeyId,
	setKeybindings,
	KeybindingsManager as TuiKeybindingsManager,
} from "@veyyon/tui";
import { getAgentDir } from "@veyyon/utils/dirs";

export { type AppKeybinding, getDefaultPasteImageKeys, KEYBINDINGS } from "./keybinding-defs";

import { KEYBINDINGS } from "./keybinding-defs";
import type { KeybindingsCreateOptions } from "./keybindings-helpers";
import {
	FOLLOW_UP_KEYBINDING,
	keyConfigValue,
	loadKeybindingsConfig,
	loadProfileKeybindingsConfig,
	maybeSeedProfileKeybindings,
	migrateKeybindingsConfigFile,
	removeKey,
	userBindingClaimsKey,
	WINDOWS_FOLLOW_UP_FALLBACK_KEY,
} from "./keybindings-helpers";

export { profileHasKeybindingsFile, seedKeybindingsFromAgentDir } from "./keybindings-helpers";

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
