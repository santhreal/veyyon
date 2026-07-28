/**
 * How a surface SPELLS a key, in one place.
 *
 * Every chord a user sees printed in the UI has to be the chord they actually
 * have. Keybindings are remappable, so a hint written out as a literal is right
 * until somebody edits `keybindings.yml` and then quietly wrong, in the surface
 * whose job is telling them which key to press. That went wrong three times over
 * for one gesture: the Agent Control Center's footer chip and fold line both said
 * `ctrl+o`, and the rule-injection notice said `(ctrl+o to expand)` in three
 * places, all for `app.tools.expand`, which the handlers were reading properly the
 * whole time.
 *
 * Two entry points, because the surfaces differ in what they can reach. A
 * component the host constructs with injected keys uses {@link keyHint}; one that
 * is built deep in a render path with no injection point uses
 * {@link actionKeyHint}, which reads the process-wide manager.
 *
 * Both return LOWERCASE, because that is how chips and inline hints are written
 * across the TUI, while `formatKeyHints` produces the title-case form the settings
 * UI and `/hotkeys` use.
 */
import { getKeybindings, type Keybinding } from "@veyyon/tui";
import { formatKeyHints, type KeyId } from "../../config/keybindings";

/**
 * These keys as a hint, or `""` when there are none.
 *
 * The empty case is a real answer, not a fallback. An action bound to nothing
 * cannot be triggered, so a surface that names a key anyway is inviting the user
 * to press something that does nothing; the callers drop the hint instead.
 */
export function keyHint(keys: readonly KeyId[]): string {
	return keys.length === 0 ? "" : formatKeyHints([...keys]).toLowerCase();
}

/** The live chord for an action, from the process-wide manager. */
export function actionKeyHint(action: Keybinding): string {
	return keyHint(getKeybindings().getKeys(action));
}

/**
 * ` (<key> to expand)` for `app.tools.expand`, or `""` when nothing is bound.
 *
 * Five surfaces append exactly this to a truncation notice: the bash block, the
 * eval block, the shared execution footer and both `ssh` hints. It is one function
 * so the phrasing cannot drift between them and so the empty case is decided once.
 *
 * The COUNT that precedes it is never conditional at any call site. A block that
 * hid eighty lines and says nothing reads as a block that had none, which is the
 * failure the notice exists to prevent; losing the key hint only costs the reader
 * a trip to `/hotkeys`.
 */
export function expandHintSuffix(): string {
	const hint = actionKeyHint("app.tools.expand");
	return hint ? ` (${hint} to expand)` : "";
}
