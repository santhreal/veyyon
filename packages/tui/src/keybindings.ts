import type {
	Keybinding,
	KeybindingConflict,
	KeybindingDefinition,
	KeybindingDefinitions,
	KeybindingsConfig,
} from "./keybindings-helpers";

export * from "./keybindings-helpers";

import { addKeyAliases, canonicalKeyId, normalizeKeys, TUI_KEYBINDINGS } from "./keybindings-helpers";
import { type KeyId, parseKey } from "./keys";

export type { KeybindingsConfig };
export { TUI_KEYBINDINGS };

export class KeybindingsManager {
	#definitions: KeybindingDefinitions;
	#userBindings: KeybindingsConfig;
	#keysById = new Map<Keybinding, KeyId[]>();
	#matchKeysById = new Map<Keybinding, Set<string>>();
	#conflicts: KeybindingConflict[] = [];

	constructor(definitions: KeybindingDefinitions, userBindings: KeybindingsConfig = {}) {
		this.#definitions = definitions;
		this.#userBindings = userBindings;
		this.#rebuild();
	}

	#rebuild(): void {
		this.#keysById.clear();
		this.#matchKeysById.clear();
		this.#conflicts = [];

		const userClaims = new Map<KeyId, Set<Keybinding>>();
		for (const [keybinding, keys] of Object.entries(this.#userBindings)) {
			if (!(keybinding in this.#definitions)) continue;
			for (const key of normalizeKeys(keys)) {
				const claimants = userClaims.get(key) ?? new Set<Keybinding>();
				claimants.add(keybinding as Keybinding);
				userClaims.set(key, claimants);
			}
		}

		for (const [key, keybindings] of userClaims) {
			if (keybindings.size > 1) {
				this.#conflicts.push({ key, keybindings: Array.from(keybindings) });
			}
		}

		for (const [id, definition] of Object.entries(this.#definitions)) {
			const userKeys = this.#userBindings[id];
			const keys = userKeys === undefined ? normalizeKeys(definition.defaultKeys) : normalizeKeys(userKeys);
			this.#keysById.set(id as Keybinding, keys);
			const matchKeys = new Set<string>();
			for (const key of keys) {
				addKeyAliases(matchKeys, key);
			}
			this.#matchKeysById.set(id as Keybinding, matchKeys);
		}
	}

	matches(data: string, keybinding: Keybinding): boolean {
		const parsed = parseKey(data);
		if (parsed === undefined) return false;
		const matchKeys = this.#matchKeysById.get(keybinding);
		return matchKeys?.has(canonicalKeyId(parsed)) ?? false;
	}

	getKeys(keybinding: Keybinding): KeyId[] {
		return Array.from(this.#keysById.get(keybinding) ?? []);
	}

	getDefinition(keybinding: Keybinding): KeybindingDefinition {
		return this.#definitions[keybinding];
	}

	getConflicts(): KeybindingConflict[] {
		return this.#conflicts.map(conflict => ({ ...conflict, keybindings: conflict.keybindings.slice() }));
	}

	setUserBindings(userBindings: KeybindingsConfig): void {
		this.#userBindings = userBindings;
		this.#rebuild();
	}

	getUserBindings(): KeybindingsConfig {
		return { ...this.#userBindings };
	}

	getResolvedBindings(): KeybindingsConfig {
		const resolved: KeybindingsConfig = {};
		for (const id of Object.keys(this.#definitions)) {
			const keys = this.#keysById.get(id as Keybinding) ?? [];
			resolved[id] = keys.length === 1 ? keys[0]! : keys.slice();
		}
		return resolved;
	}
}

let globalKeybindings: KeybindingsManager | null = null;

export function setKeybindings(keybindings: KeybindingsManager): void {
	globalKeybindings = keybindings;
}

export function getKeybindings(): KeybindingsManager {
	if (!globalKeybindings) {
		globalKeybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	}
	return globalKeybindings;
}

export function resetKeybindingsForTests(): void {
	globalKeybindings = null;
}
