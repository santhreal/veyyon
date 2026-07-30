/**
 * What to say when a mouse drag selected nothing.
 *
 * Scroll isolation holds the mouse so the wheel scrolls the transcript with the
 * prompt pinned, which also takes plain drag-select away from the terminal. The
 * hold is temporary -- it expires after a few seconds with no keystroke or wheel
 * tick -- so the drag that lands here is one that arrived while the operator was
 * still working, and the cheapest answer is to try again in a moment. The engine
 * reports the swallowed gesture (`TUI#onSelectionAttempt`) and this owns the
 * wording and the "say it once" policy, so the answer lives in one place rather
 * than being retyped at the call site.
 */

/**
 * The three ways out, in the order they cost the operator: the terminal's own override, veyyon's
 * picker, and turning the capture off. There is deliberately no "wait a moment" option: an
 * earlier version released the mouse after a few seconds of quiet, which unpinned the composer
 * at random and made selection depend on timing, so it was removed. The hint must not promise
 * a handback that never comes.
 * Named as the single owner of this wording; `docs/settings.md` and the `tui.scrollIsolation`
 * setting description state the same tradeoff for someone reading settings.
 */
export const SELECTION_HELD_HINT =
	"Scroll isolation holds the mouse so the wheel can scroll the transcript, so that drag selected nothing. Hold shift and drag to select the way your terminal normally does, or /copy to pick text or code out of the conversation. Set tui.scrollIsolation=false to hand the wheel and the mouse back to the terminal for good.";

/**
 * Wrap `show` so the hint is delivered on the first swallowed drag and never
 * again. Once, because the point is discovery: an operator who has been told
 * knows, and a line on every drag would be its own irritation.
 */
export function createSelectionAttemptNotice(show: (message: string) => void): () => void {
	let told = false;
	return () => {
		if (told) return;
		told = true;
		show(SELECTION_HELD_HINT);
	};
}
