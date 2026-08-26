/**
 * The edits a Mnemopi memory accepts, in one leaf module. Two layers need this list: the store (branch
 per verb) and the `memory_edit` tool schema. Lives here not `state.ts` because the tool needs the VALUES
 at run time — importing from `state.ts` would put `bun:sqlite` on the tool's graph.
 */

/** Every `memory_edit` operation, in the order the tool offers them. */
export const MNEMOPI_MEMORY_EDIT_OPERATIONS = ["update", "forget", "invalidate"] as const;

/** One `memory_edit` operation. Derived from the list, so the two cannot drift. */
export type MnemopiMemoryEditOperation = (typeof MNEMOPI_MEMORY_EDIT_OPERATIONS)[number];
