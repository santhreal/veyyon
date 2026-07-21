// Vendored from the standalone `argot` SDK. See ./constants.ts for the sync note.

import { DICT_FILENAME } from "./constants";

/**
 * The fixed, model-facing notation block. A harness injects this once into the
 * system prompt, always, whether or not a project has an `AGENTS.dict`. It
 * teaches the model how the shorthand works and tells it to read the dictionary
 * when it starts on a project; the dictionary itself then rides in through that
 * read, so it needs no prose of its own and can be a dense name-to-expansion
 * table.
 *
 * This is the one home for the notation. Keep the wording here in sync with the
 * SPEC and the blog.
 */
export const ARGOT_PREAMBLE = `## Project shorthand (Argot)

A project may keep a file named ${DICT_FILENAME} at its root. It defines shorthand
handles: each entry maps a short name to a longer string the project repeats a
lot, such as a full path or a canonical command. The file declares a marker in
its \`sigil\` field (\`§\` by default), and a handle is that marker followed by the
name, for example \`§dbconn\`.

When you begin work in a project, read ${DICT_FILENAME} from its root if it exists.
Once you have read it, write a handle wherever you would have written its exact
expansion, and write everything else normally. The harness restores every handle
to its full text before anything runs or is shown, so handles are lossless and
cost you nothing in accuracy. Only use a handle for the exact string it stands
for; never invent one that the file does not define.`;
