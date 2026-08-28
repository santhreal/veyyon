/** The apply-patch envelope vocabulary, in one place. A patch envelope is a plain-text protocol: a model writes these exact strings and the */

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

/** The markers that open a file section, so a patch carrying more than one of them is a multi-file patch. `diff --git ` is git's own and is not part of this envelope, so */
export const FILE_OP_MARKERS = [UPDATE_FILE_MARKER, ADD_FILE_MARKER, DELETE_FILE_MARKER] as const;

/** The envelope wrapper lines, which carry no content and are stripped before parsing. */
export const PATCH_WRAPPER_MARKERS = [BEGIN_PATCH_MARKER, END_PATCH_MARKER] as const;
