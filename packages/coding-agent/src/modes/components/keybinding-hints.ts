import { getKeybindings, type Keybinding, type KeyId } from "@veyyon/tui";
import type { AppKeybinding, KeybindingsManager } from "../../config/keybindings";
import { theme } from "../../modes/theme/theme";

function formatKeys(keys: KeyId[]): string {
	if (keys.length === 0) return "";
	if (keys.length === 1) return keys[0]!;
	return keys.join("/");
}

export function editorKey(action: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(action));
}

export function appKey(keybindings: KeybindingsManager, action: AppKeybinding): string {
	return formatKeys(keybindings.getKeys(action));
}

export function keyHint(action: Keybinding, description: string): string {
	return theme.fg("dim", editorKey(action)) + theme.fg("muted", ` ${description}`);
}
