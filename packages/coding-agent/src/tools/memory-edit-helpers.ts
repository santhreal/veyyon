import { type } from "arktype";
import { MNEMOPI_MEMORY_EDIT_OPERATIONS } from "../mnemopi/verbs";

export const memoryEditSchema = type({
	// Derived from the store's own list, so a verb cannot be offered to the model without a branch that
	// applies it. `type.enumerated` takes the values; the union spelling had to be kept in step by hand.
	op: type.enumerated(...MNEMOPI_MEMORY_EDIT_OPERATIONS).describe("memory edit operation"),
	id: type("string").describe("memory id from recall output"),
	"content?": type("string").describe("replacement content for update"),
	"importance?": type("number").describe("replacement importance for update (0–1)"),
	"replacement_id?": type("string").describe("replacement memory id for invalidate"),
});

export type MemoryEditParams = typeof memoryEditSchema.infer;
