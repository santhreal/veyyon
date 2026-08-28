/** The edits a Mnemopi memory accepts, in one leaf module. Two layers need this list: the store, which has a branch per verb, and the `memory_edit` tool schema, */

/** Every `memory_edit` operation, in the order the tool offers them. */
export const MNEMOPI_MEMORY_EDIT_OPERATIONS = ["update", "forget", "invalidate"] as const;

/** One `memory_edit` operation. Derived from the list, so the two cannot drift. */
export type MnemopiMemoryEditOperation = (typeof MNEMOPI_MEMORY_EDIT_OPERATIONS)[number];
