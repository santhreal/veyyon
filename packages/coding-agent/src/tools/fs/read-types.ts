/**
 * Types every read step shares: the details a read result records and the context a step runs with.
 */

import type { ToolSession } from "../../sdk";
import type { TruncationSummary } from "../../session/streaming-output";
import type { OutputMeta } from "../core/output-meta";
import type { ReadDisplayContent } from "./read-display";

/**
 * The session and the settings the read tool resolves once at construction. Every read step
 * receives it, so each step applies the same line limit and image settings the tool description
 * states.
 */
export interface ReadContext {
	readonly session: ToolSession;
	/** `read.defaultLimit`, clamped to 1..`DEFAULT_MAX_LINES`. */
	readonly defaultLimit: number;
	/** `images.autoResize`. */
	readonly autoResizeImages: boolean;
	/** `inspect_image.enabled`. */
	readonly inspectImageEnabled: boolean;
}

export interface ReadToolDetails {
	kind?: "file" | "url";
	truncation?: TruncationSummary;
	isDirectory?: boolean;
	resolvedPath?: string;
	suffixResolution?: { from: string; to: string };
	url?: string;
	finalUrl?: string;
	contentType?: string;
	method?: string;
	notes?: string[];
	meta?: OutputMeta;
	/** Raw text + start line for user-visible TUI rendering, set when content is text-like.
	 * Mirrors the same lines the model receives but without hashline/line-number prefixes,
	 * so the TUI can render the file content with its own gutter without re-parsing the formatted text. */
	displayContent?: ReadDisplayContent;
	summary?: { lines: number; elidedSpans: number; elidedLines: number };
	/** Number of unresolved git conflicts surfaced by this read (TUI uses for inline `warn N` badge). */
	conflictCount?: number;
	/** Paths recovered from a delimited read argument; used only by the TUI to render one call as multiple read rows. */
	displayReadTargets?: string[];
	/**
	 * Set when the tool could not deliver the target's content as text (a binary
	 * file or archive entry, or a failed document conversion). The result is left
	 * non-`isError` on purpose so the agent gets the bracketed guidance (for
	 * example the `:raw` hint) without a retry storm; this marker lets the
	 * `veyyon read` CLI exit non-zero instead of reporting the refusal as success.
	 */
	contentUnavailable?: { reason: "binary" | "conversion-failed" };
}
