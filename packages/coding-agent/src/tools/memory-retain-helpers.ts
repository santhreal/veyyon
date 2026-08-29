import { type } from "arktype";
import { MEMORY_RETAIN_MAX_BYTES, MEMORY_RETAIN_MAX_ITEM_BYTES, MEMORY_RETAIN_MAX_ITEMS } from "../hindsight/state";
import { abortedPartway } from "./aborted-partway";

export const memoryRetainSchema = type({
	items: type({
		content: type("string").atMostLength(MEMORY_RETAIN_MAX_ITEM_BYTES).describe("information to remember"),
		"context?": type("string").atMostLength(MEMORY_RETAIN_MAX_ITEM_BYTES).describe("source context"),
	})
		.array()
		.atLeastLength(1)
		.atMostLength(MEMORY_RETAIN_MAX_ITEMS)
		.describe("memories to retain"),
});

export type MemoryRetainParams = typeof memoryRetainSchema.infer;

export function assertMemoryRetainLimits(items: ReadonlyArray<{ content: string; context?: string }>): void {
	if (items.length > MEMORY_RETAIN_MAX_ITEMS) {
		throw new Error(`Retain accepts at most ${MEMORY_RETAIN_MAX_ITEMS} memories per call.`);
	}
	let totalBytes = 0;
	for (const [index, item] of items.entries()) {
		const bytes = Buffer.byteLength(item.content, "utf8") + Buffer.byteLength(item.context ?? "", "utf8");
		if (bytes > MEMORY_RETAIN_MAX_ITEM_BYTES) {
			throw new Error(`Retain item ${index + 1} exceeds the ${MEMORY_RETAIN_MAX_ITEM_BYTES}-byte per-item limit.`);
		}
		totalBytes += bytes;
		if (!Number.isSafeInteger(totalBytes) || totalBytes > MEMORY_RETAIN_MAX_BYTES) {
			throw new Error(`Retain request exceeds the ${MEMORY_RETAIN_MAX_BYTES}-byte aggregate limit.`);
		}
	}
}

/** One item as the abort message names it: its context when it has one, else its opening words. */
export function itemLabel(item: { content: string; context?: string }, index: number): string {
	const context = item.context?.trim();
	if (context) return context;
	const head = item.content.trim().split("\n")[0] ?? "";
	return head.length > 48 ? `${head.slice(0, 45)}...` : head || `item ${index + 1}`;
}

/** The abort for a retain cancelled between items, with mnemopi as the backend. `rememberScoped` writes to the store per item, so a cancellation halfway leaves some */
export function retainAbortedPartway(
	stored: readonly string[],
	remaining: ReadonlyArray<{ content: string; context?: string }>,
	cause: unknown,
) {
	return abortedPartway(
		{
			operation: "Retain",
			unit: { one: "memory", many: "memories" },
			done: stored,
			pending: remaining.map((item, index) => itemLabel(item, stored.length + index)),
			doneLabel: "already stored",
			pendingLabel: "NOT stored",
			adviceWhenDone: "the memories above are in the store and were not rolled back",
		},
		cause,
	);
}
