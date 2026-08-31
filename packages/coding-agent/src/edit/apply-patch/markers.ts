/**
 * The apply-patch envelope vocabulary, in one place.
 *
 * A patch envelope is a plain-text protocol: a model writes these exact strings and the
 * parser reads them back. Three modules under `edit/` need them, and each had its own
 * copy. `apply-patch/parser.ts` declared `BEGIN_PATCH_MARKER` and `END_PATCH_MARKER` as
 * private constants while its sibling `streaming.ts` imported the same two names from
 * `@veyyon/hashline`, and `diff.ts` wrote all of them out as inline literals, twice for
 * the file operations. A marker that drifts does not raise an error at the seam, it makes
 * every patch stop parsing, so the copies are worth removing before they are wrong.
 *
 * The three envelope markers below are hashline's, re-exported rather than restated:
 * hashline is the library both this package and its own parser read the format from, and
 * it stays the definition. The file-operation markers are apply-patch's own and live here.
 *
 * NO TRAILING SPACE. `parser.ts` used to spell these with one (`"*** Add File: "`) and
 * `diff.ts` without, and both then trimmed whatever followed, so the space was decoration
 * in one file and absent in the other. One spelling, and it is the lenient one: a model
 * that writes `*** Add File:src/a.ts` with no space is understood rather than rejected,
 * which is what `diff.ts` already did.
 */

import { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER } from "@veyyon/hashline";

export { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER };

/** Introduces a file the patch creates. The path follows. */
export const ADD_FILE_MARKER = "*** Add File:";

/** Introduces a file the patch removes. The path follows. */
export const DELETE_FILE_MARKER = "*** Delete File:";

/** Introduces a file the patch edits in place. The path follows. */
export const UPDATE_FILE_MARKER = "*** Update File:";

/** Follows an update marker to rename the file. The new path follows. */
export const MOVE_TO_MARKER = "*** Move to:";

/** Closes a file section that runs to the end of the file. */
export const EOF_MARKER = "*** End of File";

/**
 * The markers that open a file section, so a patch carrying more than one of them is a
 * multi-file patch. `diff --git ` is git's own and is not part of this envelope, so
 * callers that accept both add it themselves.
 */
export const FILE_OP_MARKERS = [UPDATE_FILE_MARKER, ADD_FILE_MARKER, DELETE_FILE_MARKER] as const;

/** The envelope wrapper lines, which carry no content and are stripped before parsing. */
export const PATCH_WRAPPER_MARKERS = [BEGIN_PATCH_MARKER, END_PATCH_MARKER] as const;
