/**
 * WHY THIS SUITE EXISTS:
 * The inline-markdown registry judges the fragment a label renders to. This one judges the screen. The
 * component that paints that fragment has already drawn a card border, reserved a body width and placed
 * a caret, and what matters to somebody looking at the terminal is whether the card survived the label.
 *
 * The two halves are not the same test. A caller could sanitize what it was handed, in which case a
 * fragment defect never reaches a row; or a caller could take a clean fragment and break the row itself
 * by mismeasuring it. This suite mounts the real components and reads the rows they paint.
 *
 * Both surfaces take untrusted labels. The ask dialog is driven by a tool call the model wrote; the hook
 * selector is driven by a hook definition in user configuration.
 *
 * THE CLASS THIS CLOSES:
 * A label that damages the card around it. The sweep drives every label set on both surfaces at five
 * widths, and each of the ten guarantees is a property of every render rather than of one construct, so
 * a label set added to the runner is judged by all ten without being named here.
 *
 * WHAT IT DOES NOT CATCH:
 * Which rows the component chose to paint. A dialog that scrolled its option list to the wrong offset,
 * marked the wrong option as recommended, or dropped a footer chip satisfies every guarantee here. It
 * also cannot see a defect that needs a keystroke or a pointer report: every case is a mount and a
 * render, with no input driven into the component.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import {
	DIALOG_RENDER_ORACLE_GUARANTEES,
	type DialogRenderOracleFrameState,
	type DialogRenderOracleGuarantee,
} from "../src/modes/components/defect-oracles";
import { initTheme } from "../src/modes/theme/theme";
import {
	DIALOG_FIXTURE_NAMES,
	DIALOG_SURFACES,
	DIALOG_WIDTHS,
	type DialogRenderCase,
	dialogMountRejection,
	dialogRenderCases,
	dialogStateFor,
	evaluateDialogRenderCase,
	promoteDialogRenderFailureToCorpus,
} from "./helpers/defect-oracles";

interface Judged {
	spec: DialogRenderCase;
	state: DialogRenderOracleFrameState;
	failures: readonly DialogRenderOracleGuarantee[];
	blind: readonly DialogRenderOracleGuarantee[];
	skipped: readonly DialogRenderOracleGuarantee[];
	inspected: readonly DialogRenderOracleGuarantee[];
}

function key(spec: DialogRenderCase): string {
	return `${spec.surface}/${spec.fixture}@${spec.width}`;
}

/** Every case whose label set the surface accepts, and the ones it refuses with the reason. */
function partition(): { mounted: readonly DialogRenderCase[]; rejected: readonly string[] } {
	const mounted: DialogRenderCase[] = [];
	const rejected: string[] = [];
	for (const spec of dialogRenderCases()) {
		if (dialogMountRejection(spec) === null) {
			mounted.push(spec);
			continue;
		}
		rejected.push(key(spec));
	}
	return { mounted, rejected };
}

/**
 * The rows every ledger is pinned to.
 *
 * A ledger row is a decision to ship a known defect, not a tolerance. Each names the surface, the label
 * set and the width that produce it, so a fix removes rows rather than turning a suite green by
 * accident, and a defect spreading to another surface or width adds one.
 */
const LEDGERS: Readonly<Record<DialogRenderOracleGuarantee, readonly string[]>> = {
	everyPaintedRowFitsTheWidthItWasRenderedFor: [],
	// A label carrying a line break paints two lines into a row the card sized for one.
	noPaintedRowCarriesALineBreak: DIALOG_WIDTHS.map(width => `askDialog/lineBreaks@${width}`),
	// The ask dialog runs its labels through the tab replacer and the hook selector does not.
	noPaintedRowForwardsARawTab: DIALOG_WIDTHS.map(width => `hookSelector/tabs@${width}`),
	noPaintedRowSeversAnEscapeSequence: [],
	// Every escape sequence a label supplies reaches a painted row on both surfaces: a colour the theme
	// did not pick, a cursor move, a screen erase, and a window-title change.
	noLabelSuppliedEscapeSurvivesIntoARow: DIALOG_SURFACES.flatMap(surface =>
		["contentSgr", "contentSgrUnterminated", "contentCsiCursor", "contentOsc"].flatMap(fixture =>
			DIALOG_WIDTHS.map(width => `${surface}/${fixture}@${width}`),
		),
	),
	everyRowOfTheCardIsTheSameWidth: [],
	theCardBorderIsClosedOnEveryBodyRow: [],
	aSecondRenderPaintsTheSameRows: [],
	aResizedComponentReturnsToItsFirstRows: [],
	// A path under the home directory is painted in full on both surfaces, in the label and in the
	// description, rather than through the product's own path shortener.
	noRowPaintsTheHomeDirectoryPath: DIALOG_SURFACES.flatMap(surface =>
		DIALOG_WIDTHS.map(width => `${surface}/homePath@${width}`),
	),
};

/**
 * Why a guarantee reads nothing on a state, as a predicate over the state rather than a fixture list.
 *
 * A guarantee absent from this table is asserted never blind. A blind verdict that no predicate
 * explains is a guarantee that has quietly stopped judging anything.
 */
const BLIND_REASONS: Readonly<
	Partial<Record<DialogRenderOracleGuarantee, (state: DialogRenderOracleFrameState) => boolean>>
> = {};

let judged: readonly Judged[] = [];
let rejected: readonly string[] = [];

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme(false);
	const split = partition();
	rejected = split.rejected;
	judged = split.mounted.map(spec => {
		const state = dialogStateFor(spec);
		const evaluation = evaluateDialogRenderCase(spec);
		return {
			spec,
			state,
			failures: evaluation.failures.map(failure => failure.oracle),
			blind: evaluation.blind,
			skipped: evaluation.skipped,
			inspected: evaluation.inspected,
		};
	});
	// One case per guarantee rather than one per offending render, and only under
	// VEYYON_ORACLE_CORPUS=record. Recording runs inside the sweep because a recorded row carries theme
	// colour bytes: a render taken in a terminal of another colour depth replays as different bytes.
	const promoted = new Set<DialogRenderOracleGuarantee>();
	for (const spec of split.mounted) {
		for (const failure of evaluateDialogRenderCase(spec).failures) {
			if (promoted.has(failure.oracle)) continue;
			promoted.add(failure.oracle);
			promoteDialogRenderFailureToCorpus(spec, failure, dialogStateFor(spec).rows, {
				template: "dialog-render-sweep",
			});
		}
	}
}, 900_000);

describe("the dialog render sweep", () => {
	it("mounts every label set on every surface at every width", () => {
		expect(judged.length + rejected.length).toBe(
			DIALOG_SURFACES.length * DIALOG_FIXTURE_NAMES.length * DIALOG_WIDTHS.length,
		);
		expect(new Set(judged.map(entry => entry.spec.surface))).toEqual(new Set(DIALOG_SURFACES));
		expect(new Set(judged.map(entry => entry.spec.width))).toEqual(new Set(DIALOG_WIDTHS));
	});

	it("pins the label sets a surface refuses to mount", () => {
		// The ask dialog rejects an empty question outright, which is a contract rather than a hole. The
		// set is pinned by exact equality, so a surface that stops validating gains cases and turns red.
		expect([...rejected].sort()).toEqual(DIALOG_WIDTHS.map(width => `askDialog/empty@${width}`).sort());
		expect(judged.some(entry => entry.spec.surface === "hookSelector" && entry.spec.fixture === "empty")).toBe(true);
	});

	it("reads the card on every render, so a guarantee cannot pass by ceasing to apply", () => {
		// A mutation gate found this: making the row stripper return its argument left both card
		// guarantees unable to recognise a body row, so they moved from inspected to skipped and the
		// ledgers stayed empty. A skipped guarantee is not a satisfied one. Both surfaces draw a card on
		// every label set, so both guarantees have to be in scope on every render.
		const cardGuarantees: readonly DialogRenderOracleGuarantee[] = [
			"everyRowOfTheCardIsTheSameWidth",
			"theCardBorderIsClosedOnEveryBodyRow",
		];
		for (const id of cardGuarantees) {
			const notReading = judged.filter(entry => !entry.inspected.includes(id)).map(entry => key(entry.spec));
			expect(notReading, `${id} does not read the card on every render`).toEqual([]);
		}
	});

	it("reports one verdict per render, never one per sweep", () => {
		for (const entry of judged) {
			const seen = [...entry.inspected, ...entry.blind, ...entry.skipped].sort();
			expect(seen).toEqual([...DIALOG_RENDER_ORACLE_GUARANTEES].sort());
			expect(new Set(seen).size).toBe(DIALOG_RENDER_ORACLE_GUARANTEES.length);
			for (const failure of entry.failures) expect(entry.inspected).toContain(failure);
		}
	});
});

describe.each(DIALOG_RENDER_ORACLE_GUARANTEES.map(id => [id] as const))("%s", id => {
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

	it("judges at least one render", () => {
		expect(judged.some(entry => entry.inspected.includes(id))).toBe(true);
	});
});

describe("the defects the ledgers record", () => {
	it("keeps a label set that carries no hostile byte clean on every guarantee", () => {
		// The control for the ledgers above: the label sets a dialog actually shows satisfy all ten on
		// both surfaces at every width, so a ledger row is a property of its input.
		for (const fixture of ["plain", "markdown", "wideGlyphs", "zwjFamily", "longWord", "manyOptions"]) {
			for (const surface of DIALOG_SURFACES) {
				for (const width of DIALOG_WIDTHS) {
					const entry = judged.find(
						candidate =>
							candidate.spec.surface === surface &&
							candidate.spec.fixture === fixture &&
							candidate.spec.width === width,
					);
					expect(entry, `${surface}/${fixture}@${width} was not swept`).toBeDefined();
					expect(entry?.failures, `${surface}/${fixture}@${width} fails a guarantee`).toEqual([]);
				}
			}
		}
	});

	it("keeps every card rectangular and closed on every render", () => {
		// Three guarantees with empty ledgers that have to stay empty rather than being pinned: a card
		// whose body rows differ in width, a body row missing its right edge, and a row wider than the
		// terminal are the defects a wide glyph or a 200-character word would produce if the components
		// measured them wrong.
		const structural: readonly DialogRenderOracleGuarantee[] = [
			"everyPaintedRowFitsTheWidthItWasRenderedFor",
			"everyRowOfTheCardIsTheSameWidth",
			"theCardBorderIsClosedOnEveryBodyRow",
		];
		for (const id of structural) {
			expect(judged.filter(entry => entry.failures.includes(id)).map(entry => key(entry.spec))).toEqual([]);
		}
	});

	it("keeps every render stable across a repaint and a resize", () => {
		// A dialog re-renders on every keystroke and on every pointer report, and a terminal resize is a
		// width change in both directions.
		for (const id of ["aSecondRenderPaintsTheSameRows", "aResizedComponentReturnsToItsFirstRows"] as const) {
			expect(judged.filter(entry => entry.failures.includes(id)).map(entry => key(entry.spec))).toEqual([]);
		}
	});
});
