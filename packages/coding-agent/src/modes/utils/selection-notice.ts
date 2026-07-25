/**
 * What to say when a mouse drag selected nothing.
 *
 * Scroll isolation holds the mouse so the wheel scrolls the transcript with the
 * prompt pinned, which also takes plain drag-select away from the terminal. The
 * engine reports the swallowed gesture (`TUI#onSelectionAttempt`) and this owns
 * the wording and the "say it once" policy, so the answer lives in one place
 * rather than being retyped at the call site.
 */

/**
 * The three ways out, in the order they cost the operator: the terminal's own
 * override, veyyon's picker, and turning the capture off. Named as the single
 * owner of this wording; `docs/settings.md` and the `tui.scrollIsolation`
 * setting description state the same tradeoff for someone reading settings.
 */
export const SELECTION_HELD_HINT =
	"Selecting with the mouse needs shift+drag while the transcript owns the wheel. /copy picks text or code from the conversation, and tui.scrollIsolation=false hands scrolling back to the terminal.";

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
