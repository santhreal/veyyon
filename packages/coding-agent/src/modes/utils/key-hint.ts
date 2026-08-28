/** How a surface SPELLS a key, in one place. Every chord a user sees printed in the UI has to be the chord they actually */
import { getKeybindings, type Keybinding } from "@veyyon/tui";
import { formatKeyHints, type KeyId } from "../../config/keybindings";

/** These keys as a hint, or `""` when there are none. The empty case is a real answer, not a fallback. An action bound to nothing */
export function keyHint(keys: readonly KeyId[]): string {
	return keys.length === 0 ? "" : formatKeyHints(keys.slice()).toLowerCase();
}

/** The live chord for an action, from the process-wide manager. */
export function actionKeyHint(action: Keybinding): string {
	return keyHint(getKeybindings().getKeys(action));
}

/** ` (<key> to expand)` for `app.tools.expand`, or `""` when nothing is bound. Five surfaces append exactly this to a truncation notice: the bash block, the */
export function expandHintSuffix(): string {
	const hint = actionKeyHint("app.tools.expand");
	return hint ? ` (${hint} to expand)` : "";
}
