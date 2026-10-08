/**
 * The shape a domain publishes for how one of its tools' results is stored in a session file.
 *
 * A tool result's `details` can repeat what its `content` or its own other fields already hold: the
 * read card's text is the file's rows without the line numbers the model reads, and an edit's
 * post-edit file is its pre-edit file with its diff applied. Writing both doubles the session file
 * for no information. A codec drops the repeated field from the line the session writes and rebuilds
 * it when the session is loaded, so the entry in memory holds what the tool returned.
 *
 * WHY THE WRITTEN LINE AND NOT THE ENTRY. A result's content is replaced after it is recorded: a
 * prune, a shake and a compaction tail elision each swap it for a notice. A field rebuilt from the
 * content has to be rebuilt from the content it was dropped against, so the drop is decided per
 * write from the content the same line holds, and an entry whose content was replaced keeps the
 * field in full.
 *
 * The kernel looks a codec up by tool name and never reads `details` itself, which is how the
 * session spine slims a read result without naming the read tool.
 */
import type { ToolResultMessage } from "@veyyon/ai";

export interface ToolResultCodec {
	/** The tool whose results this codec stores, which is also the key the kernel looks it up under. */
	readonly toolName: string;
	/**
	 * The details to write for a result holding `content`: `details` itself when nothing is dropped,
	 * otherwise a copy without what {@link restore} rebuilds from that same `content` or from the
	 * fields the copy keeps. Never mutates `details`.
	 */
	slim(details: unknown, content: ToolResultMessage["content"]): unknown;
	/**
	 * Rebuild, in place, what {@link slim} dropped from `details`, reading the `content` the line was
	 * written with. Leaves details that were written whole unchanged.
	 */
	restore(details: unknown, content: ToolResultMessage["content"]): void;
	/**
	 * Replace, in place, each field {@link slim} would drop from a result a persisting session has
	 * just recorded with the form {@link restore} builds from `content`, so the entry in memory holds
	 * the repeated text once, as a loaded entry does. Leaves `details` unchanged when no rebuild
	 * reproduces a field. A codec without it leaves the recorded result as the tool returned it.
	 */
	settle?(details: unknown, content: ToolResultMessage["content"]): void;
}
