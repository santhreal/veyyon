/** The one home for every Argot constant. */

/** Format major this loader understands. A file targeting a newer major is refused loudly. */
export const SUPPORTED_VERSION = 1;

/** Sigil used when a dict omits the `sigil` field. */
export const DEFAULT_SIGIL = "§";

/** Token budget for generated dictionary if unspecified. */
export const DEFAULT_TOKEN_BUDGET = 1000;

/** Target fraction of achievable savings to capture before stopping handle selection. */
export const DEFAULT_SAVINGS_COVERAGE = 0.9;

/** Counter bumped when generator algorithm changes and cached dicts should invalidate. */
export const GENERATOR_REVISION: number = 3;

/** Share of line structure emitted inside tool-call arguments vs plain text. */
export const DEFAULT_TOOL_CALL_STRUCTURE_SHARE = 0.4176;

/** Ratio of output token value to input token value for cost comparison. */
export const DEFAULT_OUTPUT_TO_INPUT_PRICE_RATIO = 5;

/** A handle name (the part after the sigil) must match this. */
export const HANDLE_NAME_RE = /^[a-z0-9_]+$/;

/** Single handle-name character matcher. */
export const HANDLE_NAME_CHAR_RE = /[a-z0-9_]/;

/** Characters a sigil may not contain, so it can never blur into a handle name or whitespace. */
export const SIGIL_FORBIDDEN_RE = /[a-z0-9_\s]/;

/** A handle stands for a recurring string, not a document; an expansion past this is rejected. */
export const MAX_EXPANSION_BYTES = 8192;

/** The committed vocabulary file, resolved at the project root. */
export const DICT_FILENAME = "AGENTS.dict";

/** Name of agent tool that activates folder shorthand. */
export const ARGOT_LOAD_TOOL = "argot_load";

/** Name of agent tool that deactivates folder shorthand. */
export const ARGOT_UNLOAD_TOOL = "argot_unload";
