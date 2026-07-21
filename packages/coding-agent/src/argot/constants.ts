// Vendored from the standalone `argot` SDK (santhsecurity/argot, canonical
// source at Santh/libs/context/argot). Kept in-tree because argot is not yet
// published to npm; once it is, this directory is replaced by a dependency on
// the published package. Keep the codec logic byte-for-byte in sync with the
// SDK — the only edits here are dropping `.js` import extensions for veyyon's
// bundler module resolution.

/** The one home for every Argot constant. */

/** Format major this loader understands. A file targeting a newer major is refused loudly. */
export const SUPPORTED_VERSION = 1;

/** Sigil used when a dict omits the `sigil` field. */
export const DEFAULT_SIGIL = "§";

/** A handle name (the part after the sigil) must match this. */
export const HANDLE_NAME_RE = /^[a-z0-9_]+$/;

/** Characters a sigil may not contain, so it can never blur into a handle name or whitespace. */
export const SIGIL_FORBIDDEN_RE = /[a-z0-9_\s]/;

/** A handle stands for a recurring string, not a document; an expansion past this is rejected. */
export const MAX_EXPANSION_BYTES = 8192;

/** The committed vocabulary file, resolved at the project root. */
export const DICT_FILENAME = "AGENTS.dict";
