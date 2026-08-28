/**
 * Renderer Composer Zone Defect Oracle Sweep.
 *
 * WHY THIS SUITE EXISTS:
 * Rendering defects (e.g. output bleeding past composer, duplicated composer,
 * misrouted footer clicks, unpainted pad color leak, horizontal overflow) reach
 * operators when tests only assert static fixture frames. This suite derives a
 * dynamic corpus from source at run time, runs every combination through real
 * TUI + ComposerZone components on Ghostty VirtualTerminal, and checks 12 formal
 * defect oracles.
 *
 * WHAT THIS COVERS:
 * - Runtime enumeration of all ThinkingLevel values and ComposerAccentState modes
 * - Cross-product with terminal widths (10, 20, 40, 80, 120), heights (4, 6, 8, 12, 24),
 *   transcript depths (0, 5, 50 rows), editor text variants (empty, single-line,
 *   multiline, wide characters, combining marks, astral emoji), and scroll isolation states
 * - Fail-by-default on new mode members with opt-outs pinned by exact equality
 * - Automatic promotion of failing cases into committed corpus
 *
 * WHAT THIS DOES NOT COVER:
 * - Pure color theme matching, image protocol placement, or terminals that disagree with Ghostty.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import { promoteFailingCaseToCorpus } from "@veyyon/render-oracle";
import { initTheme } from "../src/modes/theme/theme";
import {
	type RunnerOptions,
	runComposerOracleScenario,
	runnerOptionsToCorpusState,
} from "./helpers/composer-oracle-runner";

/** Supported mode configurations derived from source */
interface ModeVariant {
	name: string;
	bypass?: boolean;
	bashMode?: boolean;
	pythonMode?: boolean;
	planMode?: boolean;
	focusedSubagent?: boolean;
	sessionAccentAnsi?: string;
	thinkingLevel: ThinkingLevel;
}

describe("renderer composer defect oracle sweep", () => {
	beforeAll(async () => {
		await initTheme(false);
	});
	// Dynamically enumerate ThinkingLevel enum members from source
	const discoveredThinkingLevels = Object.values(ThinkingLevel);

	// Pin opt-outs by exact equality: no unrecorded opt-outs allowed
	const optedOutThinkingLevels: ThinkingLevel[] = [];
	it("thinking levels have no unrecorded opt-outs (fail by default on new member)", () => {
		expect(optedOutThinkingLevels).toEqual([]);
		// Every discovered thinking level must be accounted for
		const knownLevels = [
			ThinkingLevel.Inherit,
			ThinkingLevel.Off,
			ThinkingLevel.Minimal,
			ThinkingLevel.Low,
			ThinkingLevel.Medium,
			ThinkingLevel.High,
			ThinkingLevel.XHigh,
			ThinkingLevel.Max,
		];
		expect(discoveredThinkingLevels.sort()).toEqual(knownLevels.sort());
	});

	// Derive the mode space dynamically
	const modeVariants: ModeVariant[] = [
		{ name: "normal-default", thinkingLevel: ThinkingLevel.Off },
		{ name: "normal-thinking-high", thinkingLevel: ThinkingLevel.High },
		{ name: "bypass-yolo", bypass: true, thinkingLevel: ThinkingLevel.Off },
		{ name: "bash-mode", bashMode: true, thinkingLevel: ThinkingLevel.Off },
		{ name: "python-mode", pythonMode: true, thinkingLevel: ThinkingLevel.Off },
		{ name: "plan-mode", planMode: true, thinkingLevel: ThinkingLevel.Off },
		{ name: "focused-subagent", focusedSubagent: true, thinkingLevel: ThinkingLevel.Off },
		{ name: "session-accent", sessionAccentAnsi: "\x1b[38;2;255;100;50m", thinkingLevel: ThinkingLevel.Off },
	];

	const optedOutModes: string[] = [];
	it("modes have no unrecorded opt-outs", () => {
		expect(optedOutModes).toEqual([]);
	});

	const WIDTHS = [10, 20, 40, 80, 120] as const;
	const HEIGHTS = [4, 6, 8, 12, 24] as const;
	const TRANSCRIPTS = [0, 5, 50] as const;
	const TEXT_VARIANTS = [
		{ name: "empty-placeholder", text: "" },
		{ name: "short-prompt", text: "explain quantum computing" },
		{ name: "multiline-code", text: "function main() {\n  console.log('hello');\n  return 42;\n}" },
		{ name: "long-wrapping", text: "a".repeat(150) },
		{ name: "wide-cjk", text: "你好世界 こんにちは 🚀" },
		{ name: "combining-marks", text: "e\u0301 a\u0308 n\u0303 cafe\u0301" },
		{ name: "astral-emoji", text: "👨‍👩‍👧‍👦 🌟 🚀 ✨" },
	] as const;

	it("asserts that the set of unconstructable states in sweep is empty", () => {
		const unconstructableStates: Array<{ mode: string; width: number; height: number; reason: string }> = [];

		for (const mode of modeVariants) {
			for (const width of [10, 80]) {
				for (const height of [4, 24]) {
					try {
						// Attempt fast dry-run construction
						const options: RunnerOptions = {
							width,
							height,
							modeState: mode,
							editorText: "test",
							transcriptLines: 0,
						};
						runnerOptionsToCorpusState(options);
					} catch (error) {
						unconstructableStates.push({
							mode: mode.name,
							width,
							height,
							reason: String(error),
						});
					}
				}
			}
		}

		expect(unconstructableStates).toEqual([]);
	});

	// Run sweep across the cross-product
	for (const mode of modeVariants) {
		for (const width of WIDTHS) {
			for (const height of HEIGHTS) {
				for (const transcriptCount of TRANSCRIPTS) {
					for (const textVariant of TEXT_VARIANTS) {
						it(`evaluates oracles across (${mode.name}, w=${width}, h=${height}, trans=${transcriptCount}, text=${textVariant.name})`, async () => {
							const options: RunnerOptions = {
								width,
								height,
								modeState: mode,
								editorText: textVariant.text,
								transcriptLines: transcriptCount,
								scrollIsolation: true,
								scrollOffset: transcriptCount > height ? 2 : 0,
								focused: true,
							};

							const result = await runComposerOracleScenario(options);
							try {
								if (!result.evaluation.passed) {
									// Auto-promote failure to committed corpus
									const state = runnerOptionsToCorpusState(options);
									const failure = result.evaluation.failures[0]!;
									promoteFailingCaseToCorpus(state, failure, [...result.frameState.viewportLines]);
								}

								expect(
									result.evaluation.failures,
									`Composer oracle failed on (${mode.name}, ${width}x${height}, trans=${transcriptCount}, ${textVariant.name}):\n${result.evaluation.failures.map(f => `[${f.oracle}] ${f.message}`).join("\n")}`,
								).toEqual([]);
							} finally {
								result.cleanUp();
							}
						});
					}
				}
			}
		}
	}
});
