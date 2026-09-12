/**
 * Editor state to `ComposerState`.
 *
 * The composer owns its own text while the operator types; this states what the
 * session tells it to show. The mode is derived rather than passed, because the
 * three conditions that disable input (a turn in flight, a pending approval, a
 * shell prefix) are session facts, and a renderer that decides for itself will
 * disagree with the one beside it.
 */

import { clampLow } from "@veyyon/utils/math";
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
	/** Explicit mode override when set directly. */
	mode?: ComposerMode;
}

/** The `/` prefix opens the search-and-command surface. */
const SEARCH_PREFIX = "/";

const EMPTY_ATTACHMENTS: readonly Attachment[] = [];

/**
 * Which mode the composer is in.
 *
 * A locked session outranks everything: nothing typed into it can be sent. An
 * approval prompt is next, because the answer is not composer text. Only then
 * does the text itself decide, and a busy session still accepts input — it
 * queues, which is what `queueOnSubmit` reports.
 */
export function resolveComposerMode(input: ComposerInput): ComposerMode {
	if (input.mode !== undefined) return input.mode;
	if (input.locked) return "disabled";
	if (input.awaitingApproval) return "awaiting-approval";
	const first = input.text.length > 0 ? input.text[0] : "";
	if (first === "!" || first === "$") return "shell";
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
		attachments: input.attachments ?? EMPTY_ATTACHMENTS,
		queueOnSubmit: input.busy && mode !== "disabled",
	};
	if (input.completion !== undefined) state.completion = input.completion;
	if (input.hint !== undefined) state.hint = input.hint;
	return state;
}

/**
 * Convert a 0-based character offset into line and column coordinates.
 */
export function offsetToCursor(lines: readonly string[], offset: number): { line: number; col: number } {
	let remaining = Math.max(0, Math.trunc(offset));
	for (let i = 0; i < lines.length; i++) {
		const lineLen = lines[i]?.length ?? 0;
		if (remaining <= lineLen || i === lines.length - 1) {
			return { line: i, col: Math.min(lineLen, remaining) };
		}
		remaining -= lineLen + 1;
	}
	return { line: 0, col: 0 };
}

/**
 * Convert line and column coordinates into a 0-based character offset.
 */
export function cursorToOffset(lines: readonly string[], cursor: { line: number; col: number }): number {
	const maxLine = clampLow(Math.trunc(cursor.line), 0, lines.length - 1);
	let offset = 0;
	for (let i = 0; i < maxLine; i++) {
		offset += (lines[i]?.length ?? 0) + 1;
	}
	const curLine = lines[maxLine] ?? "";
	offset += clampLow(Math.trunc(cursor.col), 0, curLine.length);
	return offset;
}
