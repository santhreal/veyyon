/**
 * The edits a Mnemopi memory accepts, in one leaf module.
 *
 * Two layers need this list: the store, which has a branch per verb, and the `memory_edit` tool schema,
 * which offers them to the model. The tool restated the union as an arktype string, and the two only met
 * at the call to `editScopedMemory`, so the schema described the vocabulary rather than deriving it.
 *
 * It lives here rather than in `state.ts` because the tool needs the VALUES at run time: importing them
 * from `state.ts` would put the whole memory subsystem, and `bun:sqlite` behind it, on the graph of a tool
 * that otherwise reaches the store through the session interface alone.
 */

/** Every `memory_edit` operation, in the order the tool offers them. */
export const MNEMOPI_MEMORY_EDIT_OPERATIONS = ["update", "forget", "invalidate"] as const;

/** One `memory_edit` operation. Derived from the list, so the two cannot drift. */
export type MnemopiMemoryEditOperation = (typeof MNEMOPI_MEMORY_EDIT_OPERATIONS)[number];
