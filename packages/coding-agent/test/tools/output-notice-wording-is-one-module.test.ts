import { describe, expect, it } from "bun:test";
import type { OutputMeta } from "@veyyon/coding-agent/tools/output-notice";
import {
	formatFullOutputReference,
	formatOutputNotice,
	formatTruncationMetaNotice,
	RETIRED_TRUNCATION_NOTICES,
	stripGeneratedOutputNotice,
	stripOutputNotice,
	stripRawOutputArtifactNotice,
} from "@veyyon/coding-agent/tools/output-notice";

/**
 * Contracts: the notice a tool appends to its output has ONE wording, and one module owns it.
 *
 * WHY THIS SUITE EXISTS. `formatOutputNotice` and the two strippers used to live in
 * `tools/output-meta.ts` beside the fluent builder, the tool wrapper and the spill configuration, so
 * that module reaches `config/settings`, the streaming output sink and the artifact store: 177 modules.
 * `session/messages.ts` needs the WORDING only, to append a notice when it converts a message for the
 * model, and it is imported by `session/session-context.ts` and through it by
 * `session/session-manager.ts`, which 206 test files import. So one string formatter was priced at 97
 * extra modules across most of the suite. The wording, the metadata shape and the strippers moved to
 * `tools/output-notice.ts` (81 modules); `output-meta.ts` re-exports every one of them, so no caller
 * changed.
 *
 * THE RISK THE MOVE CREATES, and what is pinned here. `stripOutputNotice` removes a notice by REBUILDING
 * it with `formatOutputNotice` and matching the tail of the text. That makes the writer and the remover
 * one contract: any wording change that reaches one and not the other leaves the notice visible twice,
 * once verbatim in the message body and once as the styled warning the TUI draws. Splitting the pair
 * across two modules would have made that possible; keeping them together is the reason this module
 * exists rather than a `notice-text.ts` and a `notice-strip.ts`. Every case below asserts an EXACT
 * string, because the strippers match on exact bytes and a shape-only assertion would pass while the
 * pair silently drifted.
 *
 * The second thing pinned is what the wording must NOT depend on. A notice that read a setting or a
 * theme would vary between the write and the strip, and the graph reason and the correctness reason are
 * the same reason. `test/architecture/leveraged-imports-stay-cut.test.ts` holds the module-graph half of
 * that (this module reaches neither `config/settings` nor the theme); what is here is the behavioural
 * half, driven through the new import path with no settings loaded at all, which is the capability the
 * split actually added.
 */

/** The shape a `read` of a long file produces: a line window out of a known total. */
function lineWindowMeta(): OutputMeta {
	return {
		truncation: {
			direction: "head",
			truncatedBy: "lines",
			totalLines: 4_000,
			totalBytes: 180_000,
			outputLines: 500,
			outputBytes: 22_000,
			shownRange: { start: 1, end: 500 },
		},
	};
}

/** The shape an upstream-truncated payload produces: a tail kept, elided amount unmeasurable. */
function unknownElisionMeta(): OutputMeta {
	return {
		truncation: {
			direction: "tail",
			truncatedBy: "bytes",
			outputLines: 12,
			outputBytes: 2_048,
			elidedAmountUnknown: true,
		},
	};
}

describe("the notice text", () => {
	/**
	 * The most common notice there is, asserted to the byte including the brackets. The brackets are not
	 * decoration: `stripGeneratedOutputNotice` recognises a notice by `[`, `]` and the leading `Showing `,
	 * so losing them turns every strip into a no-op and the reader sees the notice twice.
	 */
	it("renders a line window as one bracketed sentence", () => {
		expect(formatOutputNotice(lineWindowMeta())).toBe("\n\n[Showing lines 1-500 of 4000]");
	});

	/**
	 * A byte-limited truncation names the limit, because "showing 500 of 4000 lines" without it reads as
	 * a line cap the caller could raise with `limit=`, when the actual cause is the byte budget.
	 */
	it("names the byte limit when bytes are what truncated", () => {
		const notice = formatTruncationMetaNotice({
			direction: "tail",
			truncatedBy: "bytes",
			totalLines: 900,
			totalBytes: 400_000,
			outputLines: 120,
			outputBytes: 51_200,
			maxBytes: 51_200,
		});

		expect(notice).toBe("Showing 120 of 900 lines (50.0KB limit)");
	});

	/**
	 * A middle elision reports both windows and what was dropped between them, and points at the
	 * artifact. The agent's next move depends on this sentence: it has to know the gap exists and that
	 * the full text is retrievable, or it answers from a body it believes is complete.
	 */
	it("reports both windows, the elided amount, and where the full output is", () => {
		const notice = formatTruncationMetaNotice({
			direction: "middle",
			truncatedBy: "middle",
			totalLines: 1_000,
			totalBytes: 500_000,
			outputLines: 200,
			outputBytes: 100_000,
			headRange: { start: 1, end: 100 },
			tailRange: { start: 901, end: 1_000 },
			elidedLines: 800,
			elidedBytes: 400_000,
			artifactId: "42",
		});

		expect(notice).toBe(
			"Showing lines 1-100 and 901-1000 of 1000; 800 middle lines (390.6KB) elided. Read artifact://42 for full output",
		);
	});

	/**
	 * The case where the amount elided is genuinely unknown, which is a bash pipeline truncating before
	 * veyyon saw the bytes. It must say so rather than invent a total: a fabricated "of 4000" would be
	 * read as a measurement.
	 */
	it("says the elided amount was not reported rather than inventing one", () => {
		const notice = formatTruncationMetaNotice({
			direction: "tail",
			truncatedBy: "bytes",
			totalLines: 0,
			totalBytes: 0,
			outputLines: 12,
			outputBytes: 2_048,
			elidedAmountUnknown: true,
		});

		expect(notice).toBe("Truncated upstream: 2.0KB kept, elided amount not reported");
	});

	/**
	 * Limit notices carry the flag to raise, not just the fact of a limit. An agent told "100 matches
	 * limit reached" with no `limit=` suggestion re-runs the same search and gets the same 100.
	 */
	it("names the flag that raises each limit", () => {
		expect(formatOutputNotice({ limits: { matchLimit: { reached: 100, suggestion: 500 } } })).toBe(
			"\n\n[100 matches limit reached. Use limit=500 for more]",
		);
		expect(formatOutputNotice({ limits: { resultLimit: { reached: 50, suggestion: 200 } } })).toBe(
			"\n\n[50 results limit reached. Use limit=200 for more]",
		);
		expect(formatOutputNotice({ limits: { columnTruncated: { maxColumn: 400 } } })).toBe(
			"\n\n[Some lines truncated to 400 chars]",
		);
	});

	/** Several notices join into one bracketed run separated by full stops, not one bracket each. */
	it("joins several notices into a single bracketed run", () => {
		const meta: OutputMeta = {
			...lineWindowMeta(),
			limits: { matchLimit: { reached: 100, suggestion: 500 }, columnTruncated: { maxColumn: 400 } },
		};

		expect(formatOutputNotice(meta)).toBe(
			"\n\n[Showing lines 1-500 of 4000. 100 matches limit reached. Use limit=500 for more. Some lines truncated to 400 chars]",
		);
	});

	/**
	 * Diagnostics render as their own section AFTER the bracketed run, because they are content the agent
	 * has to act on rather than a note about the transport.
	 */
	it("puts diagnostics in their own section after the bracket, grouped by file", () => {
		const notice = formatOutputNotice({
			diagnostics: {
				summary: "2 errors",
				messages: [
					"src/a.ts:3:1 error TS2304: Cannot find name 'x'.",
					"src/a.ts:9:4 error TS2322: Type 'string' is not assignable to type 'number'.",
				],
			},
		});

		// Grouped by directory then file, with the shared prefix lifted out of every line: two errors in
		// one file must not repeat the path twice, which is the whole point of the grouping.
		expect(notice).toBe(
			"\n\nLSP Diagnostics (2 errors):\n# src/\n## a.ts\n  3:1 error TS2304: Cannot find name 'x'.\n  9:4 error TS2322: Type 'string' is not assignable to type 'number'.",
		);
	});

	/** No metadata means no notice, not an empty bracket. */
	it("renders nothing for absent or empty metadata", () => {
		expect(formatOutputNotice(undefined)).toBe("");
		expect(formatOutputNotice({})).toBe("");
	});

	/** The artifact reference has one wording, and three call sites depend on it being this exact one. */
	it("renders the artifact reference the agent has to follow", () => {
		expect(formatFullOutputReference("7")).toBe("Read artifact://7 for full output");
	});
});

describe("the strippers agree with the text, byte for byte", () => {
	/**
	 * THE CONTRACT THE SPLIT PUT AT RISK. `stripOutputNotice` rebuilds the notice and matches the tail,
	 * so this is the round trip: write it, strip it, get the body back unchanged. If the writer's wording
	 * and the stripper's expectation ever diverge the notice survives the strip and the reader sees it
	 * twice, once here and once in the styled warning.
	 */
	it("removes exactly what formatOutputNotice appended", () => {
		const meta = lineWindowMeta();
		const body = "line one\nline two";
		const withNotice = body + formatOutputNotice(meta);

		expect(withNotice).toBe("line one\nline two\n\n[Showing lines 1-500 of 4000]");
		expect(stripOutputNotice(withNotice, meta)).toBe(body);
	});

	/**
	 * And it tolerates the padding that really arrives. The output sink pads, diagnostics add their own
	 * blank lines, and callers may or may not have trimmed, so the match is on trimmed tails. Asserted
	 * with real trailing whitespace rather than a tidy string, because the tidy case passes either way.
	 */
	it("removes the notice through trailing padding", () => {
		const meta = lineWindowMeta();
		const withNotice = `body${formatOutputNotice(meta)}\n\n  \n`;

		expect(stripOutputNotice(withNotice, meta)).toBe("body");
	});

	/**
	 * A body that does not end in the notice is returned UNCHANGED, not trimmed and not partially cut.
	 * This is the streaming case: the notice is appended when the tool finishes, and every frame before
	 * that runs through the same strip.
	 */
	it("returns text unchanged when the notice is not there yet", () => {
		const meta = lineWindowMeta();

		expect(stripOutputNotice("still streaming\n", meta)).toBe("still streaming\n");
		expect(stripOutputNotice("no notice here", undefined)).toBe("no notice here");
	});
	/**
	 * A RESULT OUTLIVES THE WORDING THAT WROTE IT. The stripper rebuilds the notice from the metadata,
	 * so it folds only what this build would write, and a session recorded under an earlier wording
	 * would print its notice twice: verbatim in the body and again in the styled warning. That shipped
	 * once, when the upstream-truncation sentence was compacted for tokens and the strip silently
	 * stopped matching, so every retired wording keeps a builder in `RETIRED_TRUNCATION_NOTICES` and
	 * every one of them is exercised here rather than only the sentence someone remembered.
	 *
	 * Enumerated from the list at run time, so retiring a wording without teaching the stripper is not
	 * possible: the entry is what the case is built from. The other half of the guard is the exact
	 * string pinned above for the CURRENT wording, which goes red the moment the text changes and is
	 * what forces the old sentence to be recorded here instead of deleted.
	 */
	it("folds a notice written by every wording this module has shipped", () => {
		const meta = unknownElisionMeta();
		expect(RETIRED_TRUNCATION_NOTICES.length).toBeGreaterThan(0);

		for (const retired of RETIRED_TRUNCATION_NOTICES) {
			const legacy = retired(meta.truncation!);
			expect(legacy).toBeDefined();
			// The retired wording is genuinely different from what we write now, or the case would
			// be asserting the current one twice and proving nothing about the fold.
			expect(legacy).not.toBe(formatTruncationMetaNotice(meta.truncation!));
			expect(stripOutputNotice(`body\n\n[${legacy}]`, meta)).toBe("body");
		}
	});

	/** A retired wording is not a licence to eat any bracketed line: the body still has to END with it. */
	it("leaves a legacy-looking line that is not the trailing notice alone", () => {
		const meta = unknownElisionMeta();
		const legacy = RETIRED_TRUNCATION_NOTICES[0]!(meta.truncation!);
		const body = `[${legacy}]\nmore output after it`;

		expect(stripOutputNotice(body, meta)).toBe(body);
	});

	/**
	 * The metadata-free stripper recognises a generated notice by its shape, and must not eat a line the
	 * TOOL wrote that merely looks bracketed. `[warning] something` is output, not a notice.
	 */
	it("strips a generated notice without metadata and leaves other bracketed lines alone", () => {
		expect(stripGeneratedOutputNotice("body\n[Showing lines 1-500 of 4000]")).toBe("body");
		expect(stripGeneratedOutputNotice("body\n[100 matches limit reached. Use limit=500 for more]")).toBe("body");
		expect(stripGeneratedOutputNotice("body\n[warning] disk almost full")).toBe("body\n[warning] disk almost full");
		expect(stripGeneratedOutputNotice("body\nnot bracketed at all")).toBe("body\nnot bracketed at all");
	});

	/**
	 * The raw-output footer keeps its artifact id on the way out, because the caller re-attaches it to a
	 * styled reference. Losing the id there means the agent is told output was elided and not where to
	 * read it.
	 */
	it("keeps the artifact id when stripping the raw-output footer", () => {
		expect(stripRawOutputArtifactNotice("body\n[raw output: artifact://31]")).toEqual({
			text: "body",
			artifactId: "31",
		});
	});

	/**
	 * And it refuses anything that is not exactly that footer. The id must be digits: `artifact://xyz` is
	 * not an id this store issues, and treating it as one would strip a line the tool wrote.
	 */
	it("refuses a footer with a non-numeric id or no id", () => {
		expect(stripRawOutputArtifactNotice("body\n[raw output: artifact://xyz]")).toEqual({
			text: "body\n[raw output: artifact://xyz]",
		});
		expect(stripRawOutputArtifactNotice("body\n[raw output: artifact://]")).toEqual({
			text: "body\n[raw output: artifact://]",
		});
		expect(stripRawOutputArtifactNotice("body only")).toEqual({ text: "body only" });
	});
});
