/** What to say when a mouse drag selected nothing. Scroll isolation holds the mouse so the wheel scrolls the transcript with the */

/** The three ways out, in the order they cost the operator: the terminal's own override, veyyon's picker, and turning the capture off. There is deliberately no "wait a moment" option: an */
export const SELECTION_HELD_HINT =
	"Scroll isolation holds the mouse so the wheel can scroll the transcript, so that drag selected nothing. Hold shift and drag to select the way your terminal normally does, or /copy to pick text or code out of the conversation. Set tui.scrollIsolation=false to hand the wheel and the mouse back to the terminal for good.";

/** Wrap `show` so the hint is delivered on the first swallowed drag and never again. Once, because the point is discovery: an operator who has been told */
export function createSelectionAttemptNotice(show: (message: string) => void): () => void {
	let told = false;
	return () => {
		if (told) return;
		told = true;
		show(SELECTION_HELD_HINT);
	};
}
