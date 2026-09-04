/**
 * What an edit reports about itself, for whoever shows it.
 *
 * The shape every edit mode fills in and every card, transcript export and ACP client reads: the
 * change as a diff, where it starts, which file it touched, what the language server said about the
 * file afterwards, and the before/after text a checkpoint restores from. It names no host and no
 * renderer, which is why it is here rather than beside a card.
 */

import type { FileDiagnosticsResult } from "../lsp";
import type { OutputMeta } from "../tools/core/output-meta";
import type { Operation } from "./modes/patch";

export interface EditToolPerFileResult {
	path: string;
	diff: string;
	firstChangedLine?: number;
	diagnostics?: FileDiagnosticsResult;
	op?: Operation;
	move?: string;
	isError?: boolean;
	errorText?: string;
	/** Error text written for a reader. When present, shown instead of `errorText`.
	 * Set when the underlying error carries a `displayMessage` (e.g. {@link HashlineMismatchError}). */
	displayErrorText?: string;
	meta?: OutputMeta;
	/** Source-of-truth content before the edit; `undefined` for create operations. */
	oldText?: string;
	/** Source-of-truth content after the edit; `undefined` for delete operations. */
	newText?: string;
	/** True when {@link pruneOversizedEditSnapshots} dropped `oldText`/`newText` from this entry. Aggregators check this to suppress misleading combined snapshots when at least one entry of a multi-entry single-path edit was pruned. */
	snapshotsPruned?: boolean;
	/** Pre-move source path; set only when the edit moved/renamed the file. The card shows `sourcePath → path`. */
	sourcePath?: string;
}

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** Diagnostic result (if available) */
	diagnostics?: FileDiagnosticsResult;
	/** Operation type (patch mode only) */
	op?: Operation;
	/** New path after move/rename (patch mode only) */
	move?: string;
	/** Structured output metadata */
	meta?: OutputMeta;
	/** Per-file results (multi-file edits) */
	perFileResults?: EditToolPerFileResult[];
	/** Absolute file path for single-file edit results. Required by ACP diff metadata consumers. */
	path?: string;
	/** Source-of-truth content before the edit; `undefined` for create operations. */
	oldText?: string;
	/** Source-of-truth content after the edit; `undefined` for delete operations. */
	newText?: string;
	/** True when {@link pruneOversizedEditSnapshots} dropped `oldText`/`newText` from this entry. Aggregators check this to suppress misleading combined snapshots when at least one entry of a multi-entry single-path edit was pruned. */
	snapshotsPruned?: boolean;
	/** Pre-move source path; set only when the edit moved/renamed the file. The card shows `sourcePath → path`. */
	sourcePath?: string;
}
