/**
 * A committed case still reproduces what it recorded.
 *
 * WHY THIS SUITE EXISTS:
 * The sweep promoted a JSON case for every state whose oracles went red, into a directory that was
 * gitignored, and no test ever read one back. Four thousand seven hundred and twenty files had
 * accumulated on one machine from defects since fixed, which is a dump: it reproduced nothing for
 * anybody else and nothing turned red when a fix regressed. A reproduction that is not replayed is
 * not a reproduction.
 *
 * The cases carry both verdicts an oracle can get wrong. A failure is the obvious one. The other is
 * an oracle that applies to a state and reads nothing, which the two defects found in this module
 * both were, and which a corpus that could only record a failure could not hold at all.
 *
 * WHAT IT ASSERTS:
 * Every file in the corpus loads through the validating reader, and every case replays into the
 * verdict its status and kind claim. A `resolved` case is the strict one: the oracle has to be in
 * `inspected` and out of `failures` and `blind`, so a "fix" that consists of the oracle quietly
 * ceasing to apply to the state does not pass for one. The status and kind pairs are a `Record` over
 * both unions, so adding a status or a kind without deciding what it means is a compile error, and
 * every case is asserted to resolve to an entry in it.
 *
 * The negative controls drive the reader against a stale schema version, a hand-edited state, an
 * unknown status, an unknown kind, an exemption with no reason and an oracle that is no longer in the
 * registry. Each has to be rejected with the corrective action, because a case silently replayed
 * under the wrong shape is worse than no case: it reports success for a scenario nobody recorded.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - A defect in a state nobody recorded. The corpus is a set of examples, and the sweep is the gate
 *   that covers the space.
 * - A case whose grid drifts for a legitimate reason. The suite cannot tell an intended visual change
 *   from a regression; it names the case and requires it to be re-recorded either way.
 * - Whether a `resolved` case would go red against the code that predates its fix. That is asserted
 *   by the mutation gate below at the time the case is recorded, not on every run.
 *
 * MUTATION GATE:
 * 1. Returning `screenRowForSegment` to the live-tail mapping (`segment.startIndex - windowTopRow`
 *    for every segment, no footer branch and no range clamp) turns the padding case red: the oracle
 *    computes a row past the end of the viewport, drops it, and appears in `blind` instead of
 *    `inspected`.
 * 2. Returning the runner's transcript markers to the hardcoded `["transcript-output-line-"]` turns
 *    the bleed case red: the wide-glyph rows match no marker, so that oracle appears in `blind`.
 * 3. Deleting the id check from `loadCorpusCase` turns the hand-edited negative control red.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	COMPOSER_ORACLE_GUARANTEES,
	type ComposerOracleGuarantee,
	type OracleEvaluationResult,
} from "../src/modes/components/composer-defect-oracle";
import { initTheme } from "../src/modes/theme/theme";
import {
	CORPUS_CASE_KINDS,
	CORPUS_CASE_STATUSES,
	CORPUS_DIR,
	CORPUS_SCHEMA_VERSION,
	type CorpusCase,
	type CorpusCaseKind,
	type CorpusCaseStatus,
	computeCaseHash,
	listCorpusFiles,
	loadCorpusCase,
	replayCorpusCase,
} from "./helpers/renderer-defect-corpus";

const files = listCorpusFiles();

/** What a status and kind pair claims a replay will find, and the assertion that claim reduces to. */
interface CaseClaim {
	claim: string;
	assert: (corpusCase: CorpusCase, evaluation: OracleEvaluationResult) => void;
}

function failuresFor(evaluation: OracleEvaluationResult, oracle: ComposerOracleGuarantee): readonly string[] {
	return evaluation.failures.filter(failure => failure.oracle === oracle).map(failure => failure.message);
}

/**
 * A `Record` over both unions rather than a switch: a new status or a new kind does not compile until
 * somebody states what a replay of a case carrying it has to show.
 */
const CLAIMS: Readonly<Record<CorpusCaseStatus, Readonly<Record<CorpusCaseKind, CaseClaim>>>> = {
	recorded: {
		failed: {
			claim: "the oracle still fails on this state",
			assert: (corpusCase, evaluation) => {
				expect(failuresFor(evaluation, corpusCase.oracle)).not.toEqual([]);
				expect(evaluation.inspected).toContain(corpusCase.oracle);
			},
		},
		blind: {
			claim: "the oracle still reads nothing on this state",
			assert: (corpusCase, evaluation) => {
				expect(evaluation.blind).toContain(corpusCase.oracle);
			},
		},
	},
	resolved: {
		failed: {
			claim: "the oracle reads this state and no longer fails on it",
			assert: (corpusCase, evaluation) => {
				expect(failuresFor(evaluation, corpusCase.oracle)).toEqual([]);
				expect(evaluation.inspected).toContain(corpusCase.oracle);
				expect(evaluation.blind).not.toContain(corpusCase.oracle);
			},
		},
		blind: {
			claim: "the oracle now reads this state instead of walking away from it",
			assert: (corpusCase, evaluation) => {
				expect(evaluation.blind).not.toContain(corpusCase.oracle);
				expect(evaluation.skipped).not.toContain(corpusCase.oracle);
				expect(evaluation.inspected).toContain(corpusCase.oracle);
				expect(failuresFor(evaluation, corpusCase.oracle)).toEqual([]);
			},
		},
	},
	// An exemption asserts the same verdict a `recorded` case does. The difference is intent: the
	// verdict is the documented boundary rather than a defect, so the case goes red when the oracle
	// starts reading the state, which is when the exemption should be removed rather than kept.
	exempted: {
		failed: {
			claim: "the oracle still reports the failure the exemption documents",
			assert: (corpusCase, evaluation) => {
				expect(corpusCase.reason?.trim()).toBeTruthy();
				expect(failuresFor(evaluation, corpusCase.oracle)).not.toEqual([]);
			},
		},
		blind: {
			claim: "the oracle still reads nothing, which is the boundary the exemption documents",
			assert: (corpusCase, evaluation) => {
				expect(corpusCase.reason?.trim()).toBeTruthy();
				expect(evaluation.blind).toContain(corpusCase.oracle);
			},
		},
	},
};

describe("the corpus directory", () => {
	it("holds at least one case, and every file in it validates", () => {
		// Fail by default if the directory is emptied: a corpus of zero cases passes every claim below
		// by having nothing to check.
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			// Throws with the corrective action; the assertion is that it does not.
			const corpusCase = loadCorpusCase(file);
			expect(path.basename(file)).toBe(`${corpusCase.id}.json`);
		}
	});

	it("states a claim for every status and kind a case can carry", () => {
		const pairs = CORPUS_CASE_STATUSES.flatMap(status => CORPUS_CASE_KINDS.map(kind => `${status}/${kind}`));
		const stated = Object.entries(CLAIMS).flatMap(([status, kinds]) =>
			Object.keys(kinds).map(kind => `${status}/${kind}`),
		);
		expect(stated.sort()).toEqual(pairs.sort());
		for (const [status, kinds] of Object.entries(CLAIMS)) {
			for (const [kind, entry] of Object.entries(kinds)) {
				expect(entry.claim, `${status}/${kind} has no claim`).not.toBe("");
			}
		}
	});

	it("records every case against an oracle the registry still declares", () => {
		const oracles = files.map(file => loadCorpusCase(file).oracle);
		for (const oracle of oracles) {
			expect(COMPOSER_ORACLE_GUARANTEES).toContain(oracle);
		}
	});
});

describe("replaying a committed case", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it.each(files.map(file => [path.basename(file), file] as const))(
		"reproduces the verdict it recorded: %s",
		async (_name, file) => {
			const corpusCase = loadCorpusCase(file);
			const claim = CLAIMS[corpusCase.status][corpusCase.kind];
			const result = await replayCorpusCase(corpusCase.state);
			try {
				claim.assert(corpusCase, result.evaluation);
				// The frame is part of the reproduction. A case that mounts the same state and paints a
				// different grid is judging something else, whether the change was intended or not.
				expect([...result.frameState.viewportLines]).toEqual(corpusCase.observedGrid);
			} finally {
				result.cleanUp();
			}
		},
		120_000,
	);
});

const INVALID_DIR = path.resolve(CORPUS_DIR, "../renderer-defect-oracle-invalid");

/** A case that validates, as the base every negative control breaks in one way. */
function validCase(): CorpusCase {
	const state = {
		width: 80,
		height: 24,
		modeState: {},
		editorText: "run the build",
		transcriptLines: 12,
		scrollIsolation: true,
		scrollOffset: 0,
		focused: true,
	};
	const oracle: ComposerOracleGuarantee = "noHorizontalOverflow";
	return {
		schemaVersion: CORPUS_SCHEMA_VERSION,
		id: computeCaseHash(state, oracle, "failed"),
		status: "recorded",
		recordedAt: "2026-01-01T00:00:00.000Z",
		template: "negative-control",
		seed: 0,
		state,
		oracle,
		kind: "failed",
		message: "a row was wider than the terminal",
		observedGrid: ["row"],
	};
}

describe("a case the reader has to reject", () => {
	beforeAll(() => {
		fs.mkdirSync(INVALID_DIR, { recursive: true });
	});

	afterAll(() => {
		fs.rmSync(INVALID_DIR, { recursive: true, force: true });
	});

	const controls: readonly (readonly [string, (base: CorpusCase) => CorpusCase, RegExp])[] = [
		["a stale schema version", base => ({ ...base, schemaVersion: (CORPUS_SCHEMA_VERSION - 1) as 2 }), /schema 1/],
		[
			"a state edited without recomputing the id",
			base => ({ ...base, state: { ...base.state, width: 120 } }),
			/does not hash its own state/,
		],
		["an unknown status", base => ({ ...base, status: "wontfix" as CorpusCaseStatus }), /status wontfix/],
		["an unknown kind", base => ({ ...base, kind: "slow" as CorpusCaseKind }), /kind slow/],
		["an exemption with no reason", base => ({ ...base, status: "exempted" }), /has to say why/],
		[
			"an oracle the registry no longer declares",
			base => ({ ...base, oracle: "theOldName" as ComposerOracleGuarantee }),
			/not a member of COMPOSER_ORACLE_GUARANTEES/,
		],
		["a message that says nothing", base => ({ ...base, message: "   " }), /message or observedGrid/],
		[
			"a state field of the wrong type",
			base => ({ ...base, state: { ...base.state, height: "24" as unknown as number } }),
			/state fields are missing or the wrong type/,
		],
	];

	it.each(controls)("rejects %s", (_name, mutate, expected) => {
		const corpusCase = mutate(validCase());
		// Written under the id the case carries, so the file name is not what the reader trips on
		// except in the control that edits the state.
		const file = path.join(INVALID_DIR, `${corpusCase.id}.json`);
		fs.writeFileSync(file, `${JSON.stringify(corpusCase, null, "\t")}\n`, "utf-8");
		expect(() => loadCorpusCase(file)).toThrow(expected);
	});

	it("accepts the base the controls are built from", () => {
		const corpusCase = validCase();
		const file = path.join(INVALID_DIR, `${corpusCase.id}.json`);
		fs.writeFileSync(file, `${JSON.stringify(corpusCase, null, "\t")}\n`, "utf-8");
		expect(loadCorpusCase(file)).toEqual(corpusCase);
	});
});
