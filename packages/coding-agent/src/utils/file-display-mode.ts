/**
 * Resolve line-display mode for file-like outputs (read, grep, @file mentions).
 */

import { resolveEditMode } from "./edit-mode";

export interface FileDisplayMode {
	lineNumbers: boolean;
	hashLines: boolean;
}

/** Session-like object providing settings and tool availability for display mode resolution. */
export interface FileDisplayModeSession {
	/** Whether the edit tool is available. Hashlines are suppressed without it. */
	hasEditTool?: boolean;
	settings: {
		get(key: "readLineNumbers" | "edit.mode"): unknown;
	};
}

/**
 * Computes effective line display mode from session settings/env.
 * Hashline mode takes precedence and implies line-addressed output everywhere.
 * Hashlines are suppressed when the edit tool is not available (e.g. scout agents),
 * when the caller signals a `raw` read, and when the source is `immutable`
 * (e.g. internal URLs like artifact://, agent://, memory:// — there is no edit
 * path that could consume the anchors). Raw output is returned as-is.
 *
 * A `ranged` read of an immutable source prints plain line numbers whatever
 * `readLineNumbers` is set to: a line selector is a request for specific
 * lines, and with hashlines off for the source nothing else marks which
 * printed line is which, so `arc.zip:src/a.ts:2-3` and `artifact://x:2-3`
 * would come back as bare, unattributable text.
 */
export function resolveFileDisplayMode(
	session: FileDisplayModeSession,
	options?: { raw?: boolean; immutable?: boolean; ranged?: boolean },
): FileDisplayMode {
	const { settings } = session;
	const hasEditTool = session.hasEditTool ?? true;
	const editMode = resolveEditMode(session);
	const usesHashLineAnchors = editMode === "hashline";
	const raw = options?.raw === true;
	const immutable = options?.immutable === true;
	const ranged = options?.ranged === true;
	const hashLines = !raw && !immutable && hasEditTool && usesHashLineAnchors;
	return {
		hashLines,
		lineNumbers: !raw && (hashLines || (immutable && ranged) || settings.get("readLineNumbers") === true),
	};
}
