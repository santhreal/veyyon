// Vendored from the standalone `argot` SDK. See ./constants.ts for the sync note.

/**
 * The public codec handed to a harness. Every method is inert when the project
 * has no vocabulary: `promptFragment()` returns `""` and `expand()` is identity.
 */
export interface AgentDict {
	/**
	 * The system-prompt block that advertises the handles to the model. Append it
	 * to the system prompt unconditionally; it is `""` when there is no
	 * vocabulary, so a non-adopting project has nothing said to it.
	 */
	promptFragment(): string;

	/**
	 * Replace every known `<sigil><name>` handle with its exact expansion. Run
	 * this over model output at the earliest point, before the harness fans it out
	 * to the display, the transcript, the tools, or another agent. Identity when
	 * there is no vocabulary. An unknown handle is passed through unchanged.
	 */
	expand(text: string): string;
}

/** Optional per-handle metadata. Never shown to the model; for reviewers and tooling. */
export interface HandleMeta {
	/** A human note explaining the handle, surfaced in review tooling. */
	note?: string;
	/** A glob under which the handle is relevant. Reserved for scope-aware activation. */
	scope?: string;
}

/** A parsed, validated `AGENTS.dict`. */
export interface Vocabulary {
	/** Format major the file targets. */
	version: number;
	/** The marker every handle carries, e.g. `§`. */
	sigil: string;
	/** Handle name (without the sigil) to its expansion, in file order. */
	handles: Map<string, string>;
	/** Handle name to its optional metadata. */
	meta: Map<string, HandleMeta>;
}
