/**
 * The row a surface shows while it is waiting for something to finish.
 *
 * WHY THIS HAS AN OWNER. Thirty-one surfaces wrote this row and they disagreed
 * on the one character it is made of. Half spelled the wait with three ASCII
 * periods — `Sharing session...`, `Summarizing branch... (esc to cancel)`,
 * `waiting for workflow jobs...` — and half with the ellipsis the rest of the
 * product uses — `Running… (esc to cancel)`, `Loading themes…`. Compaction
 * managed both from one function: `compactionActionLabel` returned
 * `Compacting context...` for a manual compaction and `Auto-compacting context`
 * for an automatic one, and the automatic caller then appended an `…` of its
 * own, so the same operation announced itself with three periods on the turn a
 * person asked for it and with an ellipsis on the turn the session asked.
 *
 * The row is the subject and one ellipsis, plus the cancel hint when `esc` stops
 * it. Nothing else: no three periods anywhere on screen, and no second spelling
 * of the hint.
 *
 * {@link waitingRow} paints it in the quiet weight a standalone waiting row
 * takes. A caller that supplies its own colour — a loader whose message colour
 * shimmers, a wizard row in the default weight, a dashboard row in `warning` —
 * takes {@link waitingText} and paints it itself.
 *
 * The subject's case belongs to the caller, because a row can be a sentence of
 * its own (`Waiting for workflow jobs…`) or the tail of one whose subject is the
 * word before it (`autoresearch running…`).
 *
 * Out of the class: a state word in a list row (`checking`, `logged in`), which
 * names what a thing IS rather than announcing a wait; text written for the
 * model rather than the screen; and a path or selector that ends in `/...`,
 * which is a fragment, not a sentence.
 */
import { theme } from "../theme/theme-binding";
import type { Theme } from "../theme/theme-class";

export interface WaitingRowOptions {
	/**
	 * Whether `esc` stops the wait. The row states it in the product's one
	 * spelling, so a caller never writes the hint itself.
	 */
	escCancels?: boolean;
	/**
	 * The theme to paint with, for a renderer handed one rather than reading the
	 * active theme.
	 */
	theme?: Theme;
}

/**
 * ` (esc to cancel)`, the one spelling of the hint a waiting row carries. A row
 * whose subject is followed by a note of its own — the compaction label names
 * the provider doing the work — appends this after the note, since the ellipsis
 * belongs to the verb phrase and the hint comes last.
 */
export const ESC_CANCEL_HINT = " (esc to cancel)";

/** `Compacting context… (esc to cancel)`, unpainted, for a caller with its own colour. */
export function waitingText(subject: string, options: Pick<WaitingRowOptions, "escCancels"> = {}): string {
	return `${subject}…${options.escCancels ? ESC_CANCEL_HINT : ""}`;
}

/** `Compacting context…`, in the one weight a standalone waiting row takes. */
export function waitingRow(subject: string, options: WaitingRowOptions = {}): string {
	return (options.theme ?? theme).fg("dim", waitingText(subject, options));
}
