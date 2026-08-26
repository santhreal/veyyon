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
 * The corpus holds one case shape per oracle registry, not one store per registry. A composer case
 * records a mount; an overlay case records the same mount plus the modals shown over it; a tool-render
 * case records which renderer painted which hostile fixture at which width; a text-primitive case
 * records which primitive ran over which fixture with which options. The reader dispatches on
 * `family`, so a case is replayed by the runner that recorded it and judged against the registry that
 * owns its oracle. A second copy of the round trip is how the stores drift.
 *
 * WHAT IT ASSERTS:
 * Every file in the corpus loads through the validating reader, and every case replays into the
 * verdict its status and kind claim. A `resolved` case is the strict one: the oracle has to be in
 * `inspected` and out of `failures` and `blind`, so a "fix" that consists of the oracle quietly
 * ceasing to apply to the state does not pass for one. The status and kind pairs are a `Record` over
 * both unions, so adding a status or a kind without deciding what it means is a compile error, and
 * every case is asserted to resolve to an entry in it. Every family in `CORPUS_FAMILIES` carries at
 * least one committed case, so adding a registry without a reproduction for it turns this red.
 *
 * The negative controls drive the reader against a stale schema version, a hand-edited state, an
 * unknown status, an unknown kind, an exemption with no reason, an oracle that is no longer in the
 * registry, an unknown family, an overlay case naming a composer oracle, an overlay case with no
 * overlays, an overlay case recording the one option a file cannot hold, a tool-render case naming a
 * fixture the runner does not drive, one with a surface that does not exist, and one naming an overlay
 * oracle. Each has to be rejected
 * with the corrective action, because a case silently replayed under the wrong shape is worse than no
 * case: it reports success for a scenario nobody recorded.
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
 * 4. Dropping the `family` dispatch from the oracle check in `loadCorpusCase` (always reading the
 *    composer registry) turns nine of these red, the committed overlay case among them: its oracle is
 *    not a composer guarantee.
 * 5. Dropping the `family` dispatch from the state check (always parsing a composer state) turns the
 *    three overlay controls red: an overlay case with no overlays, an overlay entry with no rendered
 *    lines and an overlay recording the `visible` option are all accepted.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import type {
	ComposerOracleGuarantee,
	OverlayOracleGuarantee,
	TextPrimitiveOracleGuarantee,
	ToolRenderOracleGuarantee,
} from "../src/modes/components/defect-oracles";
import { getThemeByName, initTheme, setThemeInstance, type Theme } from "../src/modes/theme/theme";
import {
	CORPUS_CASE_KINDS,
	CORPUS_CASE_STATUSES,
	CORPUS_DIR,
	CORPUS_FAMILIES,
	CORPUS_FAMILY_GUARANTEES,
	CORPUS_SCHEMA_VERSION,
	type ComposerCorpusCase,
	type CorpusCase,
	type CorpusCaseKind,
	type CorpusCaseStatus,
	computeCaseHash,
	listCorpusFiles,
	loadCorpusCase,
	type OverlayCorpusCase,
	replayCorpusFile,
	type TextPrimitiveCorpusCase,
	type ToolRenderCorpusCase,
} from "./helpers/renderer-defect-corpus";

const files = listCorpusFiles();

/**
 * What a replay of a case reduces to, in the terms both registries report.
 *
 * The two evaluators return their own guarantee unions. A claim reads the same four buckets out of
 * either one, so the claim table is written once rather than once per family.
 */
interface ReplayVerdict {
	failures: readonly { oracle: string; message: string }[];
	skipped: readonly string[];
	inspected: readonly string[];
	blind: readonly string[];
}

/** What a status and kind pair claims a replay will find, and the assertion that claim reduces to. */
interface CaseClaim {
	claim: string;
	assert: (corpusCase: CorpusCase, verdict: ReplayVerdict) => void;
}

function failuresFor(verdict: ReplayVerdict, oracle: string): readonly string[] {
	return verdict.failures.filter(failure => failure.oracle === oracle).map(failure => failure.message);
}

/**
 * A `Record` over both unions rather than a switch: a new status or a new kind does not compile until
 * somebody states what a replay of a case carrying it has to show.
 */
const CLAIMS: Readonly<Record<CorpusCaseStatus, Readonly<Record<CorpusCaseKind, CaseClaim>>>> = {
	recorded: {
		failed: {
			claim: "the oracle still fails on this state",
			assert: (corpusCase, verdict) => {
				expect(failuresFor(verdict, corpusCase.oracle)).not.toEqual([]);
				expect(verdict.inspected).toContain(corpusCase.oracle);
			},
		},
		blind: {
			claim: "the oracle still reads nothing on this state",
			assert: (corpusCase, verdict) => {
				expect(verdict.blind).toContain(corpusCase.oracle);
			},
		},
	},
	resolved: {
		failed: {
			claim: "the oracle reads this state and no longer fails on it",
			assert: (corpusCase, verdict) => {
				expect(failuresFor(verdict, corpusCase.oracle)).toEqual([]);
				expect(verdict.inspected).toContain(corpusCase.oracle);
				expect(verdict.blind).not.toContain(corpusCase.oracle);
			},
		},
		blind: {
			claim: "the oracle now reads this state instead of walking away from it",
			assert: (corpusCase, verdict) => {
				expect(verdict.blind).not.toContain(corpusCase.oracle);
				expect(verdict.skipped).not.toContain(corpusCase.oracle);
				expect(verdict.inspected).toContain(corpusCase.oracle);
				expect(failuresFor(verdict, corpusCase.oracle)).toEqual([]);
			},
		},
	},
	// An exemption asserts the same verdict a `recorded` case does. The difference is intent: the
	// verdict is the documented boundary rather than a defect, so the case goes red when the oracle
	// starts reading the state, which is when the exemption should be removed rather than kept.
	exempted: {
		failed: {
			claim: "the oracle still reports the failure the exemption documents",
			assert: (corpusCase, verdict) => {
				expect(corpusCase.reason?.trim()).toBeTruthy();
				expect(failuresFor(verdict, corpusCase.oracle)).not.toEqual([]);
			},
		},
		blind: {
			claim: "the oracle still reads nothing, which is the boundary the exemption documents",
			assert: (corpusCase, verdict) => {
				expect(corpusCase.reason?.trim()).toBeTruthy();
				expect(verdict.blind).toContain(corpusCase.oracle);
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

	it("records every case against an oracle the registry of its own family still declares", () => {
		for (const file of files) {
			const corpusCase = loadCorpusCase(file);
			expect(CORPUS_FAMILY_GUARANTEES[corpusCase.family], `${corpusCase.id} names ${corpusCase.oracle}`).toContain(
				corpusCase.oracle,
			);
		}
	});

	it("carries at least one case for every family the corpus can hold", () => {
		const recorded = new Set(files.map(file => loadCorpusCase(file).family));
		expect([...recorded].sort()).toEqual([...CORPUS_FAMILIES].sort());
	});
});

describe("replaying a committed case", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		await initTheme(false);
		// A tool-render case replays through a renderer, which takes the theme as an argument.
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	}, 120_000);

	it.each(files.map(file => [path.basename(file), file] as const))(
		"reproduces the verdict it recorded: %s",
		async (_name, file) => {
			const { corpusCase, result } = await replayCorpusFile(file, { theme: uiTheme });
			const claim = CLAIMS[corpusCase.status][corpusCase.kind];
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

const CONTROL_STATE = {
	width: 80,
	height: 24,
	modeState: {},
	editorText: "run the build",
	transcriptLines: 12,
	scrollIsolation: true,
	scrollOffset: 0,
	focused: true,
} as const;

/** A composer case that validates, as the base a negative control breaks in one way. */
function composerValidCase(): ComposerCorpusCase {
	const state = { ...CONTROL_STATE };
	const oracle: ComposerOracleGuarantee = "noHorizontalOverflow";
	return {
		schemaVersion: CORPUS_SCHEMA_VERSION,
		id: computeCaseHash("composer", state, oracle, "failed"),
		status: "recorded",
		recordedAt: "2026-01-01T00:00:00.000Z",
		template: "negative-control",
		seed: 0,
		family: "composer",
		state,
		oracle,
		kind: "failed",
		message: "a row was wider than the terminal",
		observedGrid: ["row"],
	};
}

/** An overlay case that validates. Its state is the composer state plus the modals shown over it. */
function overlayValidCase(): OverlayCorpusCase {
	const state = { ...CONTROL_STATE, overlays: [{ name: "card", lines: ["one", "two"] }] };
	const oracle: OverlayOracleGuarantee = "everyOverlayRowReachesTheScreen";
	return {
		schemaVersion: CORPUS_SCHEMA_VERSION,
		id: computeCaseHash("overlay", state, oracle, "failed"),
		status: "recorded",
		recordedAt: "2026-01-01T00:00:00.000Z",
		template: "negative-control",
		seed: 0,
		family: "overlay",
		state,
		oracle,
		kind: "failed",
		message: "a row of the card was painted nowhere",
		observedGrid: ["row"],
	};
}

/** A tool-render case that validates: which renderer, which surface, which fixture, at which width. */
function toolRenderValidCase(): ToolRenderCorpusCase {
	const state = { tool: "glob", surface: "result", fixture: "tabs", width: 40 } as const;
	const oracle: ToolRenderOracleGuarantee = "noRawTabReachesTheScreen";
	return {
		schemaVersion: CORPUS_SCHEMA_VERSION,
		id: computeCaseHash("toolRender", state, oracle, "failed"),
		status: "recorded",
		recordedAt: "2026-01-01T00:00:00.000Z",
		template: "negative-control",
		seed: 0,
		family: "toolRender",
		state,
		oracle,
		kind: "failed",
		message: "a raw tab reached a cell",
		observedGrid: ["row"],
	};
}

/** A text-primitive case that validates: which primitive over which fixture, with which options. */
function textPrimitiveValidCase(): TextPrimitiveCorpusCase {
	const state = {
		primitive: "truncate",
		fixture: "tabs",
		width: 8,
		ellipsis: "unicode",
		pad: false,
		strict: false,
		startColumn: 0,
	} as const;
	const oracle: TextPrimitiveOracleGuarantee = "noProducedRowForwardsARawTab";
	return {
		schemaVersion: CORPUS_SCHEMA_VERSION,
		id: computeCaseHash("textPrimitive", state, oracle, "failed"),
		status: "recorded",
		recordedAt: "2026-01-01T00:00:00.000Z",
		template: "negative-control",
		seed: 0,
		family: "textPrimitive",
		state,
		oracle,
		kind: "failed",
		message: "row 0 forwards a raw tab",
		observedGrid: ["col\tc…"],
	};
}

describe("a case the reader has to reject", () => {
	beforeAll(() => {
		fs.mkdirSync(INVALID_DIR, { recursive: true });
	});

	afterAll(() => {
		fs.rmSync(INVALID_DIR, { recursive: true, force: true });
	});

	const controls: readonly (readonly [string, () => CorpusCase, RegExp])[] = [
		[
			"a stale schema version",
			() => ({ ...composerValidCase(), schemaVersion: (CORPUS_SCHEMA_VERSION - 1) as 3 }),
			/schema 2/,
		],
		[
			"a state edited without recomputing the id",
			() => {
				const base = composerValidCase();
				return { ...base, state: { ...base.state, width: 120 } };
			},
			/does not hash its own state/,
		],
		[
			"an unknown status",
			() => ({ ...composerValidCase(), status: "wontfix" as CorpusCaseStatus }),
			/status wontfix/,
		],
		["an unknown kind", () => ({ ...composerValidCase(), kind: "slow" as CorpusCaseKind }), /kind slow/],
		["an exemption with no reason", () => ({ ...composerValidCase(), status: "exempted" }), /has to say why/],
		[
			"an oracle the registry no longer declares",
			() => ({ ...composerValidCase(), oracle: "theOldName" as ComposerOracleGuarantee }),
			/not a guarantee of the composer registry/,
		],
		["a message that says nothing", () => ({ ...composerValidCase(), message: "   " }), /message or observedGrid/],
		[
			"a state field of the wrong type",
			() => {
				const base = composerValidCase();
				return { ...base, state: { ...base.state, height: "24" as unknown as number } };
			},
			/state fields are missing or the wrong type/,
		],
		[
			"a family no registry answers for",
			() => ({ ...composerValidCase(), family: "footer" }) as unknown as CorpusCase,
			/family footer is not one of/,
		],
		[
			"an overlay case naming a composer oracle",
			() => ({ ...overlayValidCase(), oracle: "noHorizontalOverflow" as unknown as OverlayOracleGuarantee }),
			/not a guarantee of the overlay registry/,
		],
		[
			"an overlay case with no overlays",
			() => {
				const base = overlayValidCase();
				return { ...base, state: { ...base.state, overlays: [] } };
			},
			/records at least one overlay/,
		],
		[
			"an overlay entry with no rendered lines",
			() => {
				const base = overlayValidCase();
				return {
					...base,
					state: { ...base.state, overlays: [{ name: "card" } as unknown as { name: string; lines: string[] }] },
				};
			},
			/needs a name and a lines array/,
		],
		[
			"a text-primitive case naming a primitive that does not exist",
			() => {
				const base = textPrimitiveValidCase();
				return {
					...base,
					state: {
						...base.state,
						primitive: "reflow" as unknown as TextPrimitiveCorpusCase["state"]["primitive"],
					},
				};
			},
			/records primitive, fixture, width, ellipsis, pad, strict and startColumn/,
		],
		[
			"a text-primitive case naming a fixture the runner does not drive",
			() => {
				const base = textPrimitiveValidCase();
				return { ...base, state: { ...base.state, fixture: "the old fixture" } };
			},
			/is not one the runner drives/,
		],
		[
			"a text-primitive case naming a composer oracle",
			() => ({
				...textPrimitiveValidCase(),
				oracle: "exactlyOneComposerPrompt" as unknown as TextPrimitiveOracleGuarantee,
			}),
			/not a guarantee of the textPrimitive registry/,
		],
		[
			"a tool-render case naming a fixture the runner does not drive",
			() => {
				const base = toolRenderValidCase();
				return { ...base, state: { ...base.state, fixture: "the old fixture" } };
			},
			/is not one the runner drives/,
		],
		[
			"a tool-render case with no surface",
			() => {
				const base = toolRenderValidCase();
				return {
					...base,
					state: { ...base.state, surface: "preview" as unknown as ToolRenderCorpusCase["state"]["surface"] },
				};
			},
			/records tool, surface, fixture and width/,
		],
		[
			"a tool-render case naming an overlay oracle",
			() => ({
				...toolRenderValidCase(),
				oracle: "topmostOverlayWinsTheOverlap" as unknown as ToolRenderOracleGuarantee,
			}),
			/not a guarantee of the toolRender registry/,
		],
		[
			"an overlay option a file cannot round-trip",
			() => {
				const base = overlayValidCase();
				return {
					...base,
					state: {
						...base.state,
						overlays: [
							{ name: "card", lines: ["one"], options: { visible: true } as unknown as Record<string, never> },
						],
					},
				};
			},
			/cannot round-trip through a file/,
		],
	];

	it.each(controls)("rejects %s", (_name, build, expected) => {
		const corpusCase = build();
		// Written under the id the case carries, so the file name is not what the reader trips on
		// except in the control that edits the state.
		const file = path.join(INVALID_DIR, `${corpusCase.id}.json`);
		fs.writeFileSync(file, `${JSON.stringify(corpusCase, null, "\t")}\n`, "utf-8");
		expect(() => loadCorpusCase(file)).toThrow(expected);
	});

	it.each([
		["a composer case", composerValidCase],
		["an overlay case", overlayValidCase],
		["a tool-render case", toolRenderValidCase],
		["a text-primitive case", textPrimitiveValidCase],
	] as const)("accepts %s the controls are built from", (_name, build) => {
		const corpusCase = build();
		const file = path.join(INVALID_DIR, `${corpusCase.id}.json`);
		fs.writeFileSync(file, `${JSON.stringify(corpusCase, null, "\t")}\n`, "utf-8");
		expect(loadCorpusCase(file)).toEqual(corpusCase);
	});
});
