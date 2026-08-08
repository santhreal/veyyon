import { describe, expect, it } from "bun:test";
import type { OutputMeta, TruncationMeta } from "@veyyon/coding-agent/tools/output-meta";
import { formatTruncationMetaNotice, OutputMetaBuilder } from "@veyyon/coding-agent/tools/output-meta";

/**
 * Output truncated by something that did not say how much it dropped must be
 * reported as incomplete, never as complete.
 *
 * WHY THIS SUITE EXISTS (EXEC-1). Veyyon's own sink knows exactly how many bytes
 * it elided, because it counted them on the way past. A truncation that happens
 * OUTSIDE veyyon does not come with that number. The ACP `terminal/output`
 * response is the case in hand: it carries `{output, truncated}` and no
 * pre-truncation size at all, so when an ACP client trims a long-running
 * command's buffer, the only fact veyyon has is that trimming occurred.
 *
 * The bash tool used to paper over the gap by copying the KEPT length into
 * `totalBytes` and `totalLines`. Every consumer downstream then did the obvious
 * arithmetic, found kept == total, computed an elision of zero, and printed
 *
 *     Showing lines 1-4 of 4
 *
 * over output that had been visibly cut. That notice is worse than no notice:
 * an agent reading it concludes the command produced four lines and reasons
 * from a truncated tail as though it were the whole result. This is the Law 10
 * shape - an unknown quietly presented as a known - and it is the reason the
 * flag exists rather than a heuristic guess at the original size.
 *
 * The contract asserted here: a summary that claims truncation while accounting
 * for every one of its own bytes is a summary with no totals, and it must say
 * so. The negative twins matter just as much, because the detection is a shape
 * match: a summary with a REAL elision must keep its exact range, and a summary
 * that was never truncated must produce no notice at all.
 */

function noticeFor(meta: OutputMeta): string {
	const truncation = meta.truncation;
	if (!truncation) throw new Error("expected truncation metadata");
	return formatTruncationMetaNotice(truncation);
}

describe("a truncation with no reported total is reported as unmeasured", () => {
	/**
	 * THE REGRESSION. Kept size equals total size while `truncated` is true, which
	 * is exactly the shape an ACP client's reply produces. Before the fix this
	 * printed "Showing lines 1-4 of 4".
	 */
	it("does not claim the whole output was shown", () => {
		const meta =
			new OutputMetaBuilder()
				.truncationFromSummary(
					{ output: "a\nb\nc\nd", outputBytes: 7, outputLines: 4, totalBytes: 7, totalLines: 4, truncated: true },
					{ direction: "tail" },
				)
				.get() ?? {};

		expect(meta.truncation?.elidedAmountUnknown).toBe(true);
		expect(noticeFor(meta)).toBe("Truncated upstream: 7B kept, elided amount not reported");
	});

	/**
	 * No range is emitted, because a range is a claim about where the kept text
	 * sits in the original and nothing here knows that. Consumers that render a
	 * range must find none rather than find a wrong one.
	 */
	it("emits no shown range to derive a false position from", () => {
		const meta =
			new OutputMetaBuilder()
				.truncationFromSummary(
					{ output: "x", outputBytes: 1, outputLines: 1, totalBytes: 1, totalLines: 1, truncated: true },
					{ direction: "tail" },
				)
				.get() ?? {};

		expect(meta.truncation?.shownRange).toBeUndefined();
		expect(meta.truncation?.elidedBytes).toBeUndefined();
		expect(meta.truncation?.elidedLines).toBeUndefined();
	});

	/**
	 * The kept size is still reported, because it is the one number that IS known
	 * and it tells the agent how much it is looking at. Only the total is absent.
	 */
	it("still reports how much survived", () => {
		const meta =
			new OutputMetaBuilder()
				.truncationFromSummary(
					{ output: "", outputBytes: 4096, outputLines: 40, totalBytes: 4096, totalLines: 40, truncated: true },
					{ direction: "tail" },
				)
				.get() ?? {};

		expect(meta.truncation?.outputBytes).toBe(4096);
		expect(noticeFor(meta)).toContain("4.0KB kept");
	});

	/**
	 * The recoverable handle survives. Losing the total is not a reason to lose
	 * the pointer to the full capture, which is the one way back to the missing
	 * bytes.
	 */
	it("keeps the artifact reference so the full output stays reachable", () => {
		const meta =
			new OutputMetaBuilder()
				.truncationFromSummary(
					{
						artifactId: "abc123",
						output: "tail",
						outputBytes: 4,
						outputLines: 1,
						totalBytes: 4,
						totalLines: 1,
						truncated: true,
					},
					{ direction: "tail" },
				)
				.get() ?? {};

		expect(meta.truncation?.artifactId).toBe("abc123");
		expect(noticeFor(meta)).toContain("artifact://abc123");
	});

	/** The head direction takes the same path: an unknown total is unknown either way. */
	it("applies to head-direction truncation too", () => {
		const meta =
			new OutputMetaBuilder()
				.truncationFromSummary(
					{ output: "head", outputBytes: 4, outputLines: 1, totalBytes: 4, totalLines: 1, truncated: true },
					{ direction: "head" },
				)
				.get() ?? {};

		expect(meta.truncation?.elidedAmountUnknown).toBe(true);
		expect(meta.truncation?.nextOffset).toBeUndefined();
	});
});

describe("a measured truncation keeps its exact numbers", () => {
	/**
	 * THE NEGATIVE TWIN THAT MATTERS MOST. The fix is a shape match on
	 * kept == total, so a summary that really did elide must be untouched by it.
	 * If this ever starts producing the unknown-elision notice, veyyon's own sink
	 * has stopped reporting the sizes it measures.
	 */
	it("reports the real line range for a tail-truncated sink summary", () => {
		const meta =
			new OutputMetaBuilder()
				.truncationFromSummary(
					{
						output: "",
						outputBytes: 2048,
						outputLines: 20,
						totalBytes: 999_999,
						totalLines: 5000,
						truncated: true,
					},
					{ direction: "tail" },
				)
				.get() ?? {};

		expect(meta.truncation?.elidedAmountUnknown).toBeUndefined();
		expect(meta.truncation?.shownRange).toEqual({ start: 4981, end: 5000 });
		expect(noticeFor(meta)).toBe("Showing lines 4981-5000 of 5000 (2.0KB limit)");
	});

	/** A middle elision reports both windows and the elided count, as before. */
	it("reports head and tail windows for a middle elision", () => {
		const meta =
			new OutputMetaBuilder()
				.truncationFromSummary(
					{
						elidedBytes: 900_000,
						elidedLines: 4960,
						output: "",
						outputBytes: 2048,
						outputLines: 21,
						totalBytes: 999_999,
						totalLines: 5000,
						truncated: true,
					},
					{ direction: "tail" },
				)
				.get() ?? {};

		expect(meta.truncation?.direction).toBe("middle");
		expect(meta.truncation?.elidedAmountUnknown).toBeUndefined();
		expect(meta.truncation?.elidedLines).toBe(4960);
	});

	/**
	 * A line-only elision (every byte kept, some lines dropped) is still a
	 * measured truncation. The detection therefore cannot key on bytes alone, or
	 * this case would be misreported as unmeasured.
	 */
	it("reports a truncation that dropped lines but no bytes as measured", () => {
		const meta =
			new OutputMetaBuilder()
				.truncationFromSummary(
					{ output: "", outputBytes: 100, outputLines: 10, totalBytes: 100, totalLines: 40, truncated: true },
					{ direction: "tail" },
				)
				.get() ?? {};

		expect(meta.truncation?.elidedAmountUnknown).toBeUndefined();
		expect(meta.truncation?.shownRange).toEqual({ start: 31, end: 40 });
	});

	/** Untruncated output produces no truncation metadata and therefore no notice. */
	it("adds no metadata when nothing was truncated", () => {
		const meta =
			new OutputMetaBuilder()
				.truncationFromSummary(
					{ output: "short", outputBytes: 5, outputLines: 1, totalBytes: 5, totalLines: 1, truncated: false },
					{ direction: "tail" },
				)
				.get() ?? {};

		expect(meta.truncation).toBeUndefined();
	});
});

describe("the unknown-elision notice reads as incomplete", () => {
	/**
	 * The wording is asserted verbatim, not merely for the presence of the word
	 * "truncated". The whole defect was a notice that parsed as reassurance, so
	 * the exact sentence an agent reads is the contract.
	 */
	it("names who truncated and admits the amount is unreported", () => {
		const truncation: TruncationMeta = {
			direction: "tail",
			elidedAmountUnknown: true,
			outputBytes: 1024,
			outputLines: 12,
			totalBytes: 1024,
			totalLines: 12,
			truncatedBy: "bytes",
		};

		expect(formatTruncationMetaNotice(truncation)).toBe("Truncated upstream: 1.0KB kept, elided amount not reported");
	});

	/**
	 * No "of N" and no byte-limit suffix. Both are the vocabulary of a measured
	 * truncation, and either one reintroduces a number nobody measured.
	 */
	it("mentions no total and no limit", () => {
		const notice = formatTruncationMetaNotice({
			direction: "tail",
			elidedAmountUnknown: true,
			outputBytes: 500,
			outputLines: 5,
			totalBytes: 500,
			totalLines: 5,
			truncatedBy: "bytes",
		});

		expect(notice).not.toContain(" of ");
		expect(notice).not.toContain("limit");
		expect(notice).not.toContain("Showing lines");
	});
});
