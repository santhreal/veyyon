/**
 * Editor state to `ComposerState`.
 *
 * The composer owns its own text while the operator types; this states what the
 * session tells it to show. The mode is derived rather than passed, because the
 * three conditions that disable input (a turn in flight, a pending approval, a
 * shell prefix) are session facts, and a renderer that decides for itself will
 * disagree with the one beside it.
 */

import type { Attachment, CompletionState, ComposerMode, ComposerState } from "@veyyon/wire/presentation";

/** What the composer is built from. */
export interface ComposerInput {
	text: string;
	cursorOffset: number;
	attachments?: readonly Attachment[];
	completion?: CompletionState;
	/** True while a turn is in flight: a submit queues instead of running. */
	busy: boolean;
	/** True while a tool call waits for the operator's answer. */
	awaitingApproval: boolean;
	/** True when the session accepts no input at all (shutting down, replaying). */
	locked: boolean;
	hint?: string;
}

/** The `!` and `$` prefixes route a line to the shell and the Python kernel. */ const SHELL_PREFIXES = [
	"!",
	"$",
] as const;

/** The `/` prefix opens the search-and-command surface. */
const SEARCH_PREFIX = "/";

/**
 * Which mode the composer is in.
 *
 * A locked session outranks everything: nothing typed into it can be sent. An
 * approval prompt is next, because the answer is not composer text. Only then
 * does the text itself decide, and a busy session still accepts input — it
 * queues, which is what `queueOnSubmit` reports.
 */
export function resolveComposerMode(input: ComposerInput): ComposerMode {
	if (input.locked) return "disabled";
	if (input.awaitingApproval) return "awaiting-approval";
	const first = input.text.slice(0, 1);
	if (SHELL_PREFIXES.some(prefix => prefix === first)) return "shell";
	if (first === SEARCH_PREFIX) return "search";
	return "input";
}

/** The placeholder for a mode. Empty when the composer already has text to show. */
export function resolvePlaceholder(mode: ComposerMode, hasText: boolean): string {
	if (hasText) return "";
	switch (mode) {
		case "disabled":
			return "Session is not accepting input";
		case "awaiting-approval":
			return "Answer the pending approval to continue";
		case "shell":
			return "";
		case "search":
			return "";
		case "input":
			return "Ask, or / for commands";
	}
}

export function toComposerState(input: ComposerInput): ComposerState {
	const mode = resolveComposerMode(input);
	const text = input.text;
	const state: ComposerState = {
		mode,
		text,
		// A cursor past the end of the text would put a renderer's caret outside
		// its own buffer, so it is clamped rather than trusted.
		cursorOffset: Math.min(text.length, Math.max(0, Math.trunc(input.cursorOffset))),
		placeholder: resolvePlaceholder(mode, text.length > 0),
		attachments: input.attachments ?? [],
		queueOnSubmit: input.busy && mode !== "disabled",
	};
	if (input.completion !== undefined) state.completion = input.completion;
	if (input.hint !== undefined) state.hint = input.hint;
	return state;
}
