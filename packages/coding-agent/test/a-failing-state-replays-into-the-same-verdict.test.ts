/**
 * A replayed corpus case produces the exact same oracle evaluation and frame geometry as the original mount.
 *
 * WHY THIS SUITE EXISTS:
 * When an interactive or automated sweep detects a composer defect, it serialises the scenario
 * as a CorpusCaseState JSON artifact. If serialisation is lossy (dropping fields like statusMessage,
 * transcriptLineMarkers, scroll isolation, or explicit transcript line arrays), replaying that artifact
 * reconstructs a different scenario where the defect may not manifest, creating false passes.
 * This suite proves that converting any RunnerOptions configuration to CorpusCaseState and replaying it
 * reproduces the identical oracle evaluation (failures and passes) and frame geometry.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Scenarios using `customParts`: live component instances/factories cannot be serialised to JSON,
 *   which is explicitly declared in `CORPUS_EXCLUDED_OPTION_KEYS`.
 * - Oracle predicates themselves: whether the oracle implementation correctly flags visual defects
 *   is owned by composer-defect-oracle.test.ts and composer-defect-sweep.test.ts.
 *
 * MUTATION GATE:
 * 1. Dropping `statusMessage` from runnerOptionsToCorpusState:
 *    Turns 20 tests red across Claim 3 (totalFrameRows height mismatch 11 vs 10, 8 vs 7, 30 vs 29),
 *    Claim 4 (fails by default naming ["customParts", "statusMessage"]), and Claim 5 (bleed failure reproduction).
 * 2. Removing `customParts` from CORPUS_EXCLUDED_OPTION_KEYS:
 *    Turns 1 test red in Claim 4 with exact equality disagreement on excluded set:
 *    expected [] but received ["customParts"].
 * 3. Dropping `transcriptLineMarkers` from runnerOptionsToCorpusState:
 *    Turns 3 tests red across Claim 4 (naming ["customParts", "transcriptLineMarkers"]),
 *    array preservation (expected markers array but received undefined), and Claim 5
 *    (expected failing verdict passed: false but received passed: true because the bleed oracle
 *    without markers inspects nothing).
 * 4. Failing verdict reproduction (Claim 5):
 *    Exercised across bleed oracle violation and duplicate prompt glyph scenarios, reproducing
 *    the exact oracle failure IDs and messages.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import { initTheme } from "../src/modes/theme/theme";
import { type RunnerOptions, type RunnerResult, runComposerOracleScenario } from "./helpers/composer-oracle-runner";
import {
	CORPUS_EXCLUDED_OPTION_KEYS,
	corpusStateToRunnerOptions,
	replayCorpusCase,
	runnerOptionsToCorpusState,
} from "./helpers/renderer-defect-corpus";
import { contentLines, FLAVOR_MARK, FLAVORS, ISOLATION, MODE_STATES } from "./helpers/renderer-differential";

beforeAll(async () => {
	await initTheme(false);
});

describe("CorpusCaseState round-trip totalness and option exclusion", () => {
	it("fails by default if any RunnerOptions key is dropped without being listed in CORPUS_EXCLUDED_OPTION_KEYS", () => {
		// `Required` is the fail-by-default mechanism: a key added to RunnerOptions and not populated
		// here is a compile error, so a new option cannot be silently absent from the round trip.
		const fullyPopulatedOptions: Required<RunnerOptions> = {
			width: 80,
			height: 24,
			modeState: {
				bypass: true,
				bashMode: false,
				pythonMode: false,
				planMode: true,
				focusedSubagent: false,
				sessionAccentAnsi: "\x1b[35m",
				thinkingLevel: ThinkingLevel.High,
			},
			editorText: "hello world\nline 2",
			transcriptLines: ["line 1", "line 2"],
			scrollIsolation: true,
			scrollOffset: 5,
			focused: false,
			statusMessage: "indexing workspace...",
			transcriptLineMarkers: ["line "],
			customParts: {},
		};

		const allOptionKeys = Object.keys(fullyPopulatedOptions) as (keyof RunnerOptions)[];
		const corpusState = runnerOptionsToCorpusState(fullyPopulatedOptions);
		const roundTrippedOptions = corpusStateToRunnerOptions(corpusState);

		const droppedKeys = allOptionKeys.filter(
			key => roundTrippedOptions[key] === undefined && fullyPopulatedOptions[key] !== undefined,
		);

		// Every dropped key MUST be explicitly listed in CORPUS_EXCLUDED_OPTION_KEYS by exact equality
		expect(droppedKeys.sort()).toEqual([...CORPUS_EXCLUDED_OPTION_KEYS].sort());
		expect([...CORPUS_EXCLUDED_OPTION_KEYS]).toEqual(["customParts"]);

		// Non-excluded fields must retain exact values
		expect(roundTrippedOptions.width).toBe(80);
		expect(roundTrippedOptions.height).toBe(24);
		expect(roundTrippedOptions.editorText).toBe("hello world\nline 2");
		expect(roundTrippedOptions.transcriptLines).toEqual(["line 1", "line 2"]);
		expect(roundTrippedOptions.scrollIsolation).toBe(true);
		expect(roundTrippedOptions.scrollOffset).toBe(5);
		expect(roundTrippedOptions.focused).toBe(false);
		expect(roundTrippedOptions.statusMessage).toBe("indexing workspace...");
		expect(roundTrippedOptions.transcriptLineMarkers).toEqual(["line "]);
		expect(roundTrippedOptions.modeState?.bypass).toBe(true);
		expect(roundTrippedOptions.modeState?.planMode).toBe(true);
		expect(roundTrippedOptions.modeState?.thinkingLevel).toBe(ThinkingLevel.High);
	});

	it("preserves numerical transcriptLines across round-trip", () => {
		const options: RunnerOptions = {
			width: 60,
			height: 15,
			transcriptLines: 12,
		};
		const state = runnerOptionsToCorpusState(options);
		expect(state.transcriptLines).toBe(12);
		const restored = corpusStateToRunnerOptions(state);
		expect(restored.transcriptLines).toBe(12);
	});

	it("preserves array transcriptLines across round-trip without reference aliasing", () => {
		const lines = ["row 1", "row 2", "row 3"];
		const markers = ["row "];
		const options: RunnerOptions = {
			width: 60,
			height: 15,
			transcriptLines: lines,
			transcriptLineMarkers: markers,
		};
		const state = runnerOptionsToCorpusState(options);
		expect(state.transcriptLines).toEqual(lines);
		expect(state.transcriptLines).not.toBe(lines); // cloned
		expect(state.transcriptLineMarkers).toEqual(markers);
		expect(state.transcriptLineMarkers).not.toBe(markers); // cloned

		const restored = corpusStateToRunnerOptions(state);
		expect(restored.transcriptLines).toEqual(lines);
		expect(restored.transcriptLineMarkers).toEqual(markers);
	});
});

describe("Faithful replay property across wide option matrix", () => {
	// Build property matrix covering geometries, flavours, mode states, scrolling, and status messages
	const WIDTHS = [36, 60, 100];
	const HEIGHTS = [4, 8, 18]; // 4 tests short terminal boundary, 18 tests comfortable height
	const LINE_COUNTS = [0, 3, 20]; // underfill and overfill
	const EDITOR_TEXTS = ["", "short text", "line 1\nline 2\nline 3"];
	const STATUS_MESSAGES = [undefined, "Processing step 3/5..."];
	const SCROLL_OFFSETS = [0, 4];
	const FOCUSED_STATES = [true, false];

	// Create orthogonal configurations sampling the space comprehensively
	const scenarios: Array<{ name: string; options: RunnerOptions }> = [];

	let counter = 0;
	for (const flavor of FLAVORS) {
		for (const modeState of MODE_STATES) {
			const width = WIDTHS[counter % WIDTHS.length]!;
			const height = HEIGHTS[counter % HEIGHTS.length]!;
			const count = LINE_COUNTS[counter % LINE_COUNTS.length]!;
			const scrollIsolation = ISOLATION[counter % ISOLATION.length]!;
			const scrollOffset = SCROLL_OFFSETS[counter % SCROLL_OFFSETS.length]!;
			const focused = FOCUSED_STATES[counter % FOCUSED_STATES.length]!;
			const editorText = EDITOR_TEXTS[counter % EDITOR_TEXTS.length]!;
			const statusMessage = STATUS_MESSAGES[counter % STATUS_MESSAGES.length];

			const lines = count > 0 ? contentLines(flavor, count) : [];
			const markers = [FLAVOR_MARK[flavor]];

			const name = `flavor=${flavor} mode=${JSON.stringify(modeState)} w=${width} h=${height} lines=${count} iso=${scrollIsolation} scroll=${scrollOffset} focused=${focused} status=${Boolean(statusMessage)}`;
			scenarios.push({
				name,
				options: {
					width,
					height,
					modeState,
					editorText,
					transcriptLines: lines,
					transcriptLineMarkers: markers,
					scrollIsolation,
					scrollOffset,
					focused,
					statusMessage,
				},
			});
			counter++;
		}
	}

	for (const { name, options } of scenarios) {
		it(`replays faithfully: ${name}`, async () => {
			let original: RunnerResult | null = null;
			let replayed: RunnerResult | null = null;
			try {
				original = await runComposerOracleScenario(options);
				const corpusState = runnerOptionsToCorpusState(options);
				replayed = await replayCorpusCase(corpusState);

				// 1. Oracle evaluation verdicts MUST match identically
				expect(replayed.evaluation.passed).toBe(original.evaluation.passed);
				expect(replayed.evaluation.failures.map(f => ({ oracle: f.oracle, message: f.message }))).toEqual(
					original.evaluation.failures.map(f => ({ oracle: f.oracle, message: f.message })),
				);

				// 2. Frame state geometry and viewport lines MUST match identically
				expect(replayed.frameState.width).toBe(original.frameState.width);
				expect(replayed.frameState.height).toBe(original.frameState.height);
				expect(replayed.frameState.totalFrameRows).toBe(original.frameState.totalFrameRows);
				expect(replayed.frameState.windowTopRow).toBe(original.frameState.windowTopRow);
				expect(replayed.frameState.pinnedFooterChildCount).toBe(original.frameState.pinnedFooterChildCount);
				expect(replayed.frameState.pinnedFooterRows).toBe(original.frameState.pinnedFooterRows);
				expect(replayed.frameState.virtualScrollTop).toBe(original.frameState.virtualScrollTop);
				expect(replayed.frameState.expectedPromptGlyph).toBe(original.frameState.expectedPromptGlyph);
				expect(replayed.frameState.editorFocused).toBe(original.frameState.editorFocused);
				expect(replayed.frameState.liveFooterLines).toEqual(original.frameState.liveFooterLines);

				expect(replayed.frameState.screenBounds).toEqual(original.frameState.screenBounds);
				expect(replayed.frameState.cursor).toEqual(original.frameState.cursor);
				expect(replayed.frameState.viewportLines).toEqual(original.frameState.viewportLines);
			} finally {
				original?.cleanUp();
				replayed?.cleanUp();
			}
		});
	}
});

describe("Replay of a failing oracle verdict reproduces the failure identically", () => {
	it("faithfully reproduces a bleed oracle failure when transcript marker leaks into footer", async () => {
		// Construct a scenario that triggers noOutputBleedPastComposer:
		// The transcript marker "[BLEED_DEFECT_MARKER]" is also present in statusMessage (which renders in footer)
		const bleedMarker = "[BLEED_DEFECT_MARKER]";
		const failingOptions: RunnerOptions = {
			width: 60,
			height: 12,
			transcriptLines: [`Normal line 1`, `Line with ${bleedMarker}`],
			transcriptLineMarkers: [bleedMarker],
			statusMessage: `Status carrying ${bleedMarker} in footer`,
			scrollIsolation: true,
			scrollOffset: 0,
			focused: true,
		};

		let original: RunnerResult | null = null;
		let replayed: RunnerResult | null = null;
		try {
			original = await runComposerOracleScenario(failingOptions);

			// Assert that the original mount genuinely fails the oracle
			expect(original.evaluation.passed).toBe(false);
			expect(original.evaluation.failures.length).toBeGreaterThanOrEqual(1);
			expect(original.evaluation.failures.some(f => f.oracle === "noOutputBleedPastComposer")).toBe(true);

			// Convert to CorpusCaseState and replay
			const corpusState = runnerOptionsToCorpusState(failingOptions);
			replayed = await replayCorpusCase(corpusState);

			// The replay MUST produce the exact same failing verdict and failure details
			expect(replayed.evaluation.passed).toBe(false);
			expect(replayed.evaluation.failures.map(f => ({ oracle: f.oracle, message: f.message }))).toEqual(
				original.evaluation.failures.map(f => ({ oracle: f.oracle, message: f.message })),
			);
			expect(replayed.frameState.viewportLines).toEqual(original.frameState.viewportLines);
		} finally {
			original?.cleanUp();
			replayed?.cleanUp();
		}
	});

	it("faithfully reproduces multiple prompt glyph defect when prompt marker is duplicated in transcript", async () => {
		// Construct a scenario where transcript contains an un-indented prompt glyph "› " that is visible in viewport
		const failingOptions: RunnerOptions = {
			width: 60,
			height: 10,
			transcriptLines: ["  › fake prompt in transcript line 1", "  › fake prompt in transcript line 2"],
			scrollIsolation: true,
			scrollOffset: 0,
			focused: true,
		};

		let original: RunnerResult | null = null;
		let replayed: RunnerResult | null = null;
		try {
			original = await runComposerOracleScenario(failingOptions);

			// Assert that the original mount genuinely fails exactlyOneComposerPrompt
			expect(original.evaluation.passed).toBe(false);
			expect(original.evaluation.failures.some(f => f.oracle === "exactlyOneComposerPrompt")).toBe(true);

			// Convert to CorpusCaseState and replay
			const corpusState = runnerOptionsToCorpusState(failingOptions);
			replayed = await replayCorpusCase(corpusState);

			// The replay MUST produce the exact same failing verdict and failure details
			expect(replayed.evaluation.passed).toBe(false);
			expect(replayed.evaluation.failures.map(f => ({ oracle: f.oracle, message: f.message }))).toEqual(
				original.evaluation.failures.map(f => ({ oracle: f.oracle, message: f.message })),
			);
			expect(replayed.frameState.viewportLines).toEqual(original.frameState.viewportLines);
		} finally {
			original?.cleanUp();
			replayed?.cleanUp();
		}
	});
});
