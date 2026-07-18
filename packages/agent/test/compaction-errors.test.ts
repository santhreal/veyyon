import { describe, expect, it } from "bun:test";
import { CompactionCancelledError } from "../src/compaction/errors";

// Production (agent-session.ts, command-controller.ts) discriminates a
// deliberate compaction abort purely via `instanceof CompactionCancelledError`
// and reads `.name`/`.message`. Lock that contract.
describe("CompactionCancelledError", () => {
	it("defaults to the canonical cancellation message", () => {
		const err = new CompactionCancelledError();
		expect(err.message).toBe("Compaction cancelled");
	});

	it("carries a caller-supplied message", () => {
		const err = new CompactionCancelledError("operator pressed Esc");
		expect(err.message).toBe("operator pressed Esc");
	});

	it("exposes the stable typed name used for source-agnostic classification", () => {
		expect(new CompactionCancelledError().name).toBe("CompactionCancelledError");
	});

	it("is both an Error and a CompactionCancelledError for instanceof discrimination", () => {
		const err = new CompactionCancelledError();
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(CompactionCancelledError);
	});

	it("is catchable as a distinct sentinel, not confused with a plain Error", () => {
		const plain = new Error("Compaction cancelled");
		expect(plain).not.toBeInstanceOf(CompactionCancelledError);
	});
});
