import { describe, expect, test } from "bun:test";
import {
	assertValidCompactionResult,
	type CompactionPreparation,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "@veyyon/agent-core/compaction";

function preparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "safe-cut-point",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		recentMessages: [],
		isSplitTurn: false,
		tokensBefore: 50_000,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}

describe("compaction result commit validation", () => {
	/** A blank extension summary cannot replace the history it failed to describe. */
	test("rejects blank summaries before history rewrite", () => {
		expect(() =>
			assertValidCompactionResult(preparation(), {
				summary: "  \n ",
				firstKeptEntryId: "safe-cut-point",
				tokensBefore: 50_000,
			}),
		).toThrow("summary is empty");
	});

	/** A foreign or missing cut point would make context rebuilding discard the retained tail. */
	test("rejects a cut point different from the prepared safe boundary", () => {
		expect(() =>
			assertValidCompactionResult(preparation(), {
				summary: "Durable summary",
				firstKeptEntryId: "missing-entry",
				tokensBefore: 50_000,
			}),
		).toThrow("does not match the safe cut point");
	});

	/** Non-finite token metadata must not enter a durable session entry or telemetry. */
	test("rejects invalid token metadata", () => {
		expect(() =>
			assertValidCompactionResult(preparation(), {
				summary: "Durable summary",
				firstKeptEntryId: "safe-cut-point",
				tokensBefore: Number.NaN,
			}),
		).toThrow("finite non-negative");
	});

	/** A complete result at the exact prepared boundary remains byte-preserving and accepted. */
	test("accepts a valid result without rewriting its summary", () => {
		const result = {
			summary: "  Durable summary bytes  ",
			firstKeptEntryId: "safe-cut-point",
			tokensBefore: 50_000,
		};

		expect(assertValidCompactionResult(preparation(), result)).toBeUndefined();
		expect(result.summary).toBe("  Durable summary bytes  ");
	});
});
