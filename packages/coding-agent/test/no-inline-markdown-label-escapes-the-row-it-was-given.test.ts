/**
 * WHY THIS SUITE EXISTS:
 * `renderInlineMarkdown` returns a fragment its caller concatenates into a row it has already sized
 * and bordered. Twelve call sites do that: an ask-dialog question, an ask-dialog option label and
 * description, a hook-selector label and description, and the option rows of the ask tool. None of
 * them wraps, measures or sanitizes the result afterwards.
 *
 * The text is not trusted. An ask-dialog option label and description come from a tool call the model
 * wrote; a hook label comes from a hook definition in user configuration. Both reach the function as
 * written, and the function forwards a line break, a tab, a control byte and an escape sequence
 * unchanged. That is the defect field this suite pins.
 *
 * THE CLASS THIS CLOSES:
 * A fragment that damages the row around it. Not "this label looked wrong once": the sweep drives every
 * source in every caller shape, and each of the ten guarantees is a property of every fragment rather
 * than of a construct. A source added to the runner is judged by all ten without being named here.
 *
 * WHAT IT DOES NOT CATCH:
 * Whether the styling is the styling the theme intended. A code span that paints in the wrong token
 * colour satisfies every guarantee here; only a cell painted with no attribute at all is a defect this
 * suite can see. It also does not judge which constructs are styled: a renderer that stopped painting
 * bold entirely would stay green, because bold text is still text.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
	INLINE_MARKDOWN_ORACLE_GUARANTEES,
	type InlineMarkdownOracleFrameState,
	type InlineMarkdownOracleGuarantee,
	plainFragment,
} from "../src/modes/components/defect-oracles";
import { initTheme } from "../src/modes/theme/theme";
import {
	evaluateInlineMarkdownCase,
	INLINE_CALLER_SHAPES,
	INLINE_SOURCE_NAMES,
	type InlineMarkdownCase,
	inlineMarkdownCases,
	inlineMarkdownStateFor,
	promoteInlineMarkdownFailureToCorpus,
} from "./helpers/defect-oracles";

interface Judged {
	spec: InlineMarkdownCase;
	state: InlineMarkdownOracleFrameState;
	failures: readonly InlineMarkdownOracleGuarantee[];
	blind: readonly InlineMarkdownOracleGuarantee[];
	skipped: readonly InlineMarkdownOracleGuarantee[];
	inspected: readonly InlineMarkdownOracleGuarantee[];
}

/** The case label a ledger row uses, which is what the oracle's own failure message names. */
function key(spec: InlineMarkdownCase): string {
	return `${spec.fixture}@${spec.shape}`;
}

/**
 * The rows every ledger is pinned to.
 *
 * A ledger row is a decision to ship a known defect, not a tolerance. Each of these is a fragment the
 * function returns today that damages the row it lands in, and each names the input that produces it,
 * so a fix removes a row rather than turning a suite green by accident.
 */
const LEDGERS: Readonly<Record<InlineMarkdownOracleGuarantee, readonly string[]>> = {
	// A source with two lines returns two lines. The caller painted a border for one.
	theRenderedFragmentIsASingleLine: ["twoLines@based", "twoLines@bare", "crlf@based", "crlf@bare"],
	// A tab is forwarded raw, so the label jumps to the next stop, past the caller's border.
	theRenderedFragmentForwardsNoRawTab: ["tab@based", "tab@bare"],
	// A BEL rings and a NUL paints nothing while counting as a cell.
	theRenderedFragmentCarriesNoC0Control: ["contentBell@based", "contentBell@bare", "nul@based", "nul@bare"],
	// A base colour wrapper injected inside a content OSC cuts the sequence in half, and the terminal
	// consumes the rest of the row as the hyperlink's payload.
	everyEscapeInTheFragmentIsComplete: ["contentOscLink@based"],
	// Every escape byte the source carried reaches the fragment unchanged.
	noContentSuppliedEscapeSurvivesIntoTheFragment: [
		"contentSgr@based",
		"contentSgr@bare",
		"contentSgrUnterminated@based",
		"contentSgrUnterminated@bare",
		"contentOscLink@based",
		"contentOscLink@bare",
		"contentCsiCursor@based",
		"contentCsiCursor@bare",
		"contentSgrMimic@based",
		"contentSgrMimic@bare",
	],
	// An unterminated SGR the source supplied is still open when the caller paints the rest of its row.
	theFragmentClosesEveryStyleItOpens: ["contentSgrUnterminated@based", "contentSgrUnterminated@bare"],
	// A code span paints with no attribute open, so it reads in whatever colour the row above left, and
	// a content reset turns the base colour off for the rest of the label.
	everyPaintedCellSitsInsideAStyle: ["code@based", "contentSgr@based", "contentSgrMimic@based"],
	// A pipe table in a label renders as nothing at all: the token is neither a paragraph nor a list nor
	// one carrying text, so the walk skips it and the label disappears.
	noWordOfTheSourceIsDroppedFromTheFragment: ["table@based", "table@bare"],
	aSecondRenderReturnsTheSameFragment: [],
	// Severing the content OSC changes which cells are painted, so the coloured path and the bare path
	// paint different text from the same source.
	strippingTheStylesLeavesWhatAnUnstyledRenderPaints: ["contentOscLink@based"],
};

/**
 * Why a guarantee reads nothing on a state, as a predicate over the state rather than a fixture list.
 *
 * A guarantee absent from this table is asserted never blind. A blind verdict that no predicate
 * explains is a guarantee that has quietly stopped judging anything.
 */
const BLIND_REASONS: Readonly<
	Partial<Record<InlineMarkdownOracleGuarantee, (state: InlineMarkdownOracleFrameState) => boolean>>
> = {
	theRenderedFragmentIsASingleLine: state => state.fragment.length === 0,
	theRenderedFragmentForwardsNoRawTab: state => state.fragment.length === 0,
	theRenderedFragmentCarriesNoC0Control: state => state.fragment.length === 0,
	aSecondRenderReturnsTheSameFragment: state => state.fragment.length === 0,
	strippingTheStylesLeavesWhatAnUnstyledRenderPaints: state => state.fragment.length === 0,
	theFragmentClosesEveryStyleItOpens: state => (state.fragment.match(/\x1b\[[0-9;:]*m/g) ?? []).length === 0,
	everyPaintedCellSitsInsideAStyle: state => plainFragment(state.fragment).length === 0,
	noWordOfTheSourceIsDroppedFromTheFragment: state =>
		(plainFragment(state.source).match(/[A-Za-z0-9]{3,}/g) ?? []).length === 0,
	everyEscapeInTheFragmentIsComplete: state => (state.fragment.match(/\x1b/g) ?? []).length === 0,
	noContentSuppliedEscapeSurvivesIntoTheFragment: state => (state.source.match(/\x1b/g) ?? []).length === 0,
};

let judged: readonly Judged[] = [];

beforeAll(async () => {
	await initTheme(false);
	judged = inlineMarkdownCases().map(spec => {
		const state = inlineMarkdownStateFor(spec);
		const evaluation = evaluateInlineMarkdownCase(spec);
		return {
			spec,
			state,
			failures: evaluation.failures.map(failure => failure.oracle),
			blind: evaluation.blind,
			skipped: evaluation.skipped,
			inspected: evaluation.inspected,
		};
	});
	// One case per guarantee rather than one per offending fragment, and only under
	// VEYYON_ORACLE_CORPUS=record. Recording runs inside the sweep because a recorded fragment carries
	// theme colour bytes: a fragment recorded in a terminal of another colour depth replays as
	// different bytes.
	const promoted = new Set<InlineMarkdownOracleGuarantee>();
	for (const spec of inlineMarkdownCases()) {
		for (const failure of evaluateInlineMarkdownCase(spec).failures) {
			if (promoted.has(failure.oracle)) continue;
			promoted.add(failure.oracle);
			promoteInlineMarkdownFailureToCorpus(spec, failure, [inlineMarkdownStateFor(spec).fragment], {
				template: "inline-markdown-sweep",
			});
		}
	}
}, 900_000);

describe("the inline markdown sweep", () => {
	it("drives every source in both caller shapes", () => {
		expect(judged.length).toBe(INLINE_SOURCE_NAMES.length * INLINE_CALLER_SHAPES.length);
		expect(new Set(judged.map(entry => entry.spec.shape))).toEqual(new Set(["based", "bare"]));
	});

	it("reports one verdict per fragment, never one per sweep", () => {
		for (const entry of judged) {
			const seen = [...entry.inspected, ...entry.blind, ...entry.skipped].sort();
			expect(seen).toEqual([...INLINE_MARKDOWN_ORACLE_GUARANTEES].sort());
			// A failing id is inspected as well, so the partition covers every guarantee exactly once.
			expect(new Set(seen).size).toBe(INLINE_MARKDOWN_ORACLE_GUARANTEES.length);
			for (const failure of entry.failures) expect(entry.inspected).toContain(failure);
		}
	});
});

describe.each(INLINE_MARKDOWN_ORACLE_GUARANTEES.map(id => [id] as const))("%s", id => {
	it("fails on exactly the cases its ledger names", () => {
		const failing = judged.filter(entry => entry.failures.includes(id)).map(entry => key(entry.spec));
		expect(failing.sort()).toEqual([...LEDGERS[id]].sort());
	});

	it("reads nothing only where a predicate over the state explains it", () => {
		const reason = BLIND_REASONS[id];
		const blind = judged.filter(entry => entry.blind.includes(id));
		if (reason === undefined) {
			expect(blind.map(entry => key(entry.spec))).toEqual([]);
			return;
		}
		for (const entry of blind) {
			expect(reason(entry.state), `${id} is blind on ${key(entry.spec)} with no reason`).toBe(true);
		}
	});

	it("judges at least one fragment", () => {
		expect(judged.some(entry => entry.inspected.includes(id))).toBe(true);
	});
});

describe("the defects the ledgers record", () => {
	it("keeps a source that carries no hostile byte clean on every guarantee", () => {
		// The control for the ledgers above: the ordinary labels a dialog actually paints satisfy all
		// ten, so a ledger row is a property of its input rather than of the function as a whole.
		const clean = ["plain", "bold", "italic", "link", "bareUrl", "strike", "nested", "wideGlyphs", "homePath"];
		for (const fixture of clean) {
			for (const shape of ["based", "bare"] as const) {
				const entry = judged.find(
					candidate => candidate.spec.fixture === fixture && candidate.spec.shape === shape,
				);
				expect(entry, `${fixture}@${shape} was not swept`).toBeDefined();
				expect(entry?.failures, `${fixture}@${shape} fails a guarantee`).toEqual([]);
			}
		}
	});

	it("keeps every fragment byte-identical across two renders", () => {
		// The lexer caches across calls and a dialog re-renders on every keystroke, so this is the one
		// guarantee with an empty ledger that has to stay empty rather than being pinned.
		expect(judged.filter(entry => entry.failures.includes("aSecondRenderReturnsTheSameFragment"))).toEqual([]);
	});
});
