/**
 * Composer view-model: the input surface's state, expressed so a terminal
 * editor and a browser textarea can both render it.
 *
 * The composer owns its own text while the operator types; this state is what
 * the session tells it to show and what it reports back on submit.
 */

import type { Attachment } from "./transcript";

/** What the composer is currently accepting. */
export type ComposerMode = "input" | "disabled" | "awaiting-approval" | "shell" | "search";

/** One completion candidate offered under the cursor. */
export interface CompletionCandidate {
	/** Text inserted when the candidate is accepted. */
	value: string;
	/** Text shown in the list, when it differs from `value`. */
	label?: string;
	/** Secondary text shown beside the label. */
	detail?: string;
}

/** The completion popup, absent when nothing is offered. */
export interface CompletionState {
	/** Source token the candidates were derived from. */
	prefix: string;
	candidates: readonly CompletionCandidate[];
	/** Index into `candidates`; -1 when nothing is highlighted. */
	selectedIndex: number;
}

export interface ComposerState {
	mode: ComposerMode;
	/** Current text. The renderer owns the cursor within it. */
	text: string;
	/** Cursor offset in UTF-16 code units. */
	cursorOffset: number;
	/** Placeholder shown while `text` is empty. */
	placeholder: string;
	attachments: readonly Attachment[];
	completion?: CompletionState;
	/** True when the session will queue a submit rather than run it now. */
	queueOnSubmit: boolean;
	/** Rendered hint line under the input, absent when there is nothing to say. */
	hint?: string;
}
