/**
 * No composer state in the swept space produces a defect, and every oracle reads a real subject in
 * that space rather than reporting a pass on nothing.
 *
 * WHY THIS SUITE EXISTS:
 * A rendering defect reaches an operator when the tests assert authored fixture frames: bleed past
 * the composer, a second composer, a misrouted footer click, a pad row painting a background, a row
 * wider than the terminal. This sweep drives real TUI and composer components over the Ghostty
 * virtual terminal across the whole state space and judges each frame with all twelve oracles.
 *
 * The sweep also has to defend itself. Two oracles were once inspecting nothing across four thousand
 * states and reporting clean, so a green sweep alone means little; the per-oracle accounting below is
 * what makes the green mean something. The mode axis is derived from the accent state's own fields,
 * so a new composer mode enters the sweep as a compile error rather than as silence.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Colour theme fidelity, image protocol placement, or a terminal that disagrees with Ghostty.
 * - Transitions. Every state here is a cold mount; the differential, the overlay suite and the
 *   transition sweep drive sequences.
 * - Whether an oracle's judgement is right. This sweep proves the oracles found nothing to report on
 *   a subject they actually read; the mutation suite proves each predicate can fire.
 *
 * MUTATION GATE (each restored in the same step, product diff proven empty after):
 * 1. `packages/tui/src/tui.ts:1588`, `#pinnedFooterRows` minus one: the footer geometry oracles fail
 *    across the sweep and the failure list names them per state.
 * 2. `packages/tui/src/tui.ts:4141`, `windowTop` minus one: bleed and footer placement fail.
 * 3. `subject: () => ({ kind: "rows", rows: [] })` on `noHorizontalOverflow` in the oracle registry:
 *    the sweep stays green on failures and goes red on the per-oracle accounting instead, which is
 *    the whole point of keeping both claims.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import {
	COMPOSER_ORACLE_GUARANTEES,
	type ComposerOracleGuarantee,
} from "../src/modes/components/composer-defect-oracle";
import { initTheme } from "../src/modes/theme/theme";
import { type RunnerOptions, runComposerOracleScenario } from "./helpers/composer-oracle-runner";
import { promoteFailureToCorpus, runnerOptionsToCorpusState } from "./helpers/renderer-defect-corpus";
import {
	ACCENT_FLAGS,
	ACCENT_VARIANTS,
	type BooleanAccentFlag,
	type ModeVariant,
	THINKING_LEVELS,
} from "./helpers/renderer-differential";

const MODES: readonly ModeVariant[] = ACCENT_VARIANTS;

const WIDTHS = [10, 20, 40, 80, 120] as const;
const HEIGHTS = [4, 6, 8, 12, 24] as const;
const TRANSCRIPTS = [0, 5, 50] as const;
const TEXTS = [
	{ name: "empty-placeholder", text: "" },
	{ name: "short-prompt", text: "explain quantum computing" },
	{ name: "multiline-code", text: "function main() {\n  console.log('hello');\n  return 42;\n}" },
	{ name: "long-wrapping", text: "a".repeat(150) },
	{ name: "wide-cjk", text: "你好世界 こんにちは 🚀" },
	{ name: "combining-marks", text: "e\u0301 a\u0308 n\u0303 cafe\u0301" },
	{ name: "astral-emoji", text: "👨‍👩‍👧‍👦 🌟 🚀 ✨" },
] as const;

/** How each oracle fared over the whole sweep. */
interface OracleTally {
	inspected: number;
	skipped: number;
	blind: number;
}

const failures: string[] = [];
const tallies = new Map<ComposerOracleGuarantee, OracleTally>();
let statesDriven = 0;

function tally(id: ComposerOracleGuarantee): OracleTally {
	const existing = tallies.get(id);
	if (existing) return existing;
	const fresh: OracleTally = { inspected: 0, skipped: 0, blind: 0 };
	tallies.set(id, fresh);
	return fresh;
}

/** Oracles already written to the corpus by this run, so one defect does not promote thousands of files. */
const promotedOracles = new Set<ComposerOracleGuarantee>();

beforeAll(async () => {
	await initTheme(false);

	for (const mode of MODES) {
		for (const width of WIDTHS) {
			for (const height of HEIGHTS) {
				for (const depth of TRANSCRIPTS) {
					for (const text of TEXTS) {
						const options: RunnerOptions = {
							width,
							height,
							modeState: mode.state,
							editorText: text.text,
							transcriptLines: depth,
							scrollIsolation: true,
							scrollOffset: depth > height ? 2 : 0,
							focused: true,
						};
						const name = `${mode.name}/${width}x${height}/d${depth}/${text.name}`;
						const result = await runComposerOracleScenario(options);
						try {
							statesDriven += 1;
							for (const id of result.evaluation.inspected) tally(id).inspected += 1;
							for (const id of result.evaluation.skipped) tally(id).skipped += 1;
							for (const id of result.evaluation.blind) tally(id).blind += 1;
							for (const failure of result.evaluation.failures) {
								failures.push(`${name}: [${failure.oracle}] ${failure.message}`);
							}
							// One case per oracle, not one per state: a single defect fails thousands of the
							// states below and a corpus of thousands of copies of it is a dump, not a
							// reproduction. The first state that reaches an oracle is the one recorded.
							for (const failure of result.evaluation.failures) {
								if (promotedOracles.has(failure.oracle)) continue;
								promotedOracles.add(failure.oracle);
								promoteFailureToCorpus(
									runnerOptionsToCorpusState(options),
									failure,
									result.frameState.viewportLines,
								);
							}
						} finally {
							result.cleanUp();
						}
					}
				}
			}
		}
	}
}, 900_000);

describe("the swept space is the one the composer can reach", () => {
	it("sweeps every thinking level the enum declares", () => {
		expect([...THINKING_LEVELS].sort()).toEqual(
			[
				ThinkingLevel.Inherit,
				ThinkingLevel.Off,
				ThinkingLevel.Minimal,
				ThinkingLevel.Low,
				ThinkingLevel.Medium,
				ThinkingLevel.High,
				ThinkingLevel.XHigh,
				ThinkingLevel.Max,
			].sort(),
		);
		for (const level of THINKING_LEVELS) {
			expect(
				MODES.some(m => m.state.thinkingLevel === level),
				`thinking level ${level} is unswept`,
			).toBe(true);
		}
	});

	it("sweeps every accent flag the composer state declares", () => {
		const pinned: BooleanAccentFlag[] = ["bashMode", "bypass", "focusedSubagent", "planMode", "pythonMode"];
		expect([...ACCENT_FLAGS].sort()).toEqual(pinned.sort());
		for (const flag of ACCENT_FLAGS) {
			expect(
				MODES.some(m => m.state[flag] === true),
				`accent flag ${flag} is unswept`,
			).toBe(true);
		}
	});

	it("drove the whole cross-product", () => {
		expect(statesDriven).toBe(MODES.length * WIDTHS.length * HEIGHTS.length * TRANSCRIPTS.length * TEXTS.length);
	});
});

describe("no state in the swept space produces a composer defect", () => {
	it("reports no oracle failure anywhere in the sweep", () => {
		expect(failures).toEqual([]);
	});
});

describe("the sweep judged the composer rather than passing on nothing", () => {
	it("read a real subject for every guarantee somewhere in the sweep", () => {
		const never = COMPOSER_ORACLE_GUARANTEES.filter(id => (tallies.get(id)?.inspected ?? 0) === 0);
		expect([...never].sort()).toEqual([]);
	});

	it("went blind only where the state cannot supply the subject", () => {
		const blind = COMPOSER_ORACLE_GUARANTEES.filter(id => (tallies.get(id)?.blind ?? 0) > 0);
		// A state with no transcript row on screen paints nothing the two bleed oracles can read, and a
		// four-row terminal paints the footer's tail only, so the input's breathing rows are off screen
		// and the padding oracle has no row to judge. Pinned by exact equality: any other oracle
		// reaching a blind state is the defect class that produced two silent holes in this module, and
		// a new oracle that reads nothing anywhere lands here.
		expect([...blind].sort()).toEqual([
			"composerCardPadsAreUnpaintedAir",
			"noMixedTranscriptAndChromeRows",
			"noOutputBleedPastComposer",
		]);
	});

	it("accounts for every guarantee in every state it drove", () => {
		const wrong: string[] = [];
		for (const id of COMPOSER_ORACLE_GUARANTEES) {
			const seen = tallies.get(id) ?? { inspected: 0, skipped: 0, blind: 0 };
			const total = seen.inspected + seen.skipped + seen.blind;
			if (total !== statesDriven) wrong.push(`${id}: accounted ${total} of ${statesDriven}`);
		}
		expect(wrong).toEqual([]);
	});
});
