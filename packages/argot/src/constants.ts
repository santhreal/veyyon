/** The one home for every Argot constant. */

/** Format major this loader understands. A file targeting a newer major is refused loudly. */
export const SUPPORTED_VERSION = 1;

/** Sigil used when a dict omits the `sigil` field. */
export const DEFAULT_SIGIL = "§";

/**
 * Token budget a generated dictionary must itself fit under, when the caller
 * names none. This is the ONE home for that number: the generator falls back to
 * it, and a harness that surfaces the budget as a setting uses it as the default
 * and as the "unchanged" sentinel, so the compiled default and the configured
 * default can never drift apart.
 */
export const DEFAULT_TOKEN_BUDGET = 1000;

/** A handle name (the part after the sigil) must match this. */
export const HANDLE_NAME_RE = /^[a-z0-9_]+$/;

/**
 * A single handle-name character. This is the per-character form of
 * {@link HANDLE_NAME_RE} and of the boundary guard `(?![a-z0-9_])` the expander
 * builds (see `buildHandlePattern`). The streaming decoder tests one character at
 * a time to find where a handle-in-progress ends, so it needs the char form; it
 * lives here so the name-character class has one definitional home.
 */
export const HANDLE_NAME_CHAR_RE = /[a-z0-9_]/;

/** Characters a sigil may not contain, so it can never blur into a handle name or whitespace. */
export const SIGIL_FORBIDDEN_RE = /[a-z0-9_\s]/;

/** A handle stands for a recurring string, not a document; an expansion past this is rejected. */
export const MAX_EXPANSION_BYTES = 8192;

/** The committed vocabulary file, resolved at the project root. */
export const DICT_FILENAME = "AGENTS.dict";

/**
 * The canonical name of the agent tool that activates a folder's shorthand in
 * the current context (arms this session's codec and teaches the handles). A
 * harness that exposes the tool registers it under exactly this name, and the
 * preamble names it here, so the model and the harness agree in one place.
 */
export const ARGOT_LOAD_TOOL = "argot_load";

/**
 * The canonical name of the agent tool that stops writing a folder's shorthand.
 * Decoding of that folder stays on regardless (a handle already written must
 * always expand), so this only removes the folder from what the model is taught.
 */
export const ARGOT_UNLOAD_TOOL = "argot_unload";
