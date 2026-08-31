import type { SelectItem, SelectListLayoutOptions } from "@veyyon/tui";
import { SelectList } from "@veyyon/tui";
import { getSelectListTheme } from "../../theme/theme";
import type { SetupKeyHint } from "./types";

/**
 * The one way a setup scene builds a picker.
 *
 * `SelectList` prints its own key legend on the status row ("↑↓ move · ↵ select
 * · esc close"), which is right for a picker that owns the screen and wrong for
 * every list inside this wizard: the wizard footer already names the keys for
 * the whole step, and Escape belongs to the wizard, not the list. Every scene
 * therefore had to remember `statusLegend: false`, and the approvals scene did
 * not. It got away with it only because its four rows never overflow, so the
 * status row never renders: an opt-out that is load-bearing and silently
 * unenforced is the same defect as no opt-out at all.
 *
 * Going through here removes the choice. `statusLegend` is not in the accepted
 * layout type, so a scene cannot set it, forget it, or re-enable it by mistake.
 * `test/modes/setup-wizard-list-construction.test.ts` pins that no scene
 * bypasses this factory.
 */
export function createWizardList(
	items: readonly SelectItem[],
	maxVisible: number,
	layout: Omit<SelectListLayoutOptions, "statusLegend"> = {},
): SelectList {
	return new SelectList(items, maxVisible, getSelectListTheme(), { ...layout, statusLegend: false });
}

/**
 * Escape's meaning while `list` holds a search the user typed, or `undefined`
 * when Escape should keep its wizard-wide meaning of leaving setup.
 *
 * The wizard's Escape is its exit, and a scene only gets the keystroke if it
 * claims it (see {@link SetupSceneController.escapeAction}). A searchable list
 * consumes Escape to clear its filter, so a scene that does NOT claim it while
 * a filter is live ends onboarding on the one key the user reached for to undo
 * a mistyped search. Every scene that mounts a list routes its Escape claim
 * through this, so the claim and the hint can never disagree between scenes.
 */
export function filterEscapeHint(list: SelectList): SetupKeyHint | undefined {
	return list.hasActiveFilter() ? { keys: "esc", label: "clear search" } : undefined;
}
