/**
 * WHY: a composer mode is a state field that is supposed to become pixels. Fifteen accent states are
 * swept for defects, and the sweep proves none of them breaks the frame; none of it proves a mode
 * reaches the frame at all. A mode that stops painting is invisible to every oracle here, because a
 * frame that shows the default prompt is a perfectly well-formed frame.
 *
 * The class this closes: an accent state that changes no cell, and a pair of accent states that
 * render identically. Both are dead settings, and both survive a defect sweep untouched. The pinned
 * table below is read from the cell grid, so it fails on a colour change as well as a glyph change,
 * and `Record<AccentVariantName, ...>` fails to compile when a flag or a thinking level is added.
 *
 * What it does not catch: accent that reaches chrome other than the prompt row. The harness mounts
 * test components for the status, capability and shortcut lines, so a mode expressed only there shows
 * up here as indistinguishable, which is why the indistinguishable set is a recorded expectation
 * rather than a failure. It also says nothing about the transcript, which the mock paints as plain
 * text.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "../src/modes/theme/theme";
import { runComposerOracleScenario } from "./helpers/composer-oracle-runner";
import { ACCENT_VARIANTS, type AccentVariantName } from "./helpers/renderer-differential";

/**
 * Every channel the prompt cell can carry an accent on.
 *
 * All six are read, because the accent code reaches for more than colour: a focused subagent faints
 * the gutter rather than recolouring it, and a signature blind to the faint bit would file that mode
 * as painting nothing.
 */
interface PromptSignature {
	/** The glyph the composer paints in the prompt column. */
	glyph: string;
	/** Packed `0xRRGGBB` of that cell, or `null` when it carries the terminal's default foreground. */
	foreground: number | null;
	faint: boolean;
	background: boolean;
	underline: boolean;
	italic: boolean;
}

const TEXT = "hello";
const WIDTH = 80;
const HEIGHT = 24;

/**
 * The prompt cell every accent state paints, as the cell grid spells it.
 *
 * A row here is a measurement, not a preference: the four mode flags paint their glyph in the
 * terminal's default foreground, while the default prompt and a session accent carry a colour. The
 * table exists so that changing any of that is a decision someone records.
 */
const PROMPT_SIGNATURES: Record<AccentVariantName, PromptSignature> = {
	default: { glyph: "›", foreground: 0xbcbcbc, faint: false, background: false, underline: false, italic: false },
	bypass: { glyph: "!", foreground: null, faint: false, background: false, underline: false, italic: false },
	bashMode: { glyph: "$", foreground: null, faint: false, background: false, underline: false, italic: false },
	pythonMode: { glyph: "›", foreground: null, faint: false, background: false, underline: false, italic: false },
	planMode: { glyph: "◈", foreground: null, faint: false, background: false, underline: false, italic: false },
	focusedSubagent: {
		glyph: "›",
		foreground: 0xbcbcbc,
		faint: true,
		background: false,
		underline: false,
		italic: false,
	},
	"session-accent": {
		glyph: "›",
		foreground: 0xff6432,
		faint: false,
		background: false,
		underline: false,
		italic: false,
	},
	"thinking-inherit": {
		glyph: "›",
		foreground: 0xbcbcbc,
		faint: false,
		background: false,
		underline: false,
		italic: false,
	},
	"thinking-off": {
		glyph: "›",
		foreground: 0xbcbcbc,
		faint: false,
		background: false,
		underline: false,
		italic: false,
	},
	"thinking-minimal": {
		glyph: "›",
		foreground: 0xbcbcbc,
		faint: false,
		background: false,
		underline: false,
		italic: false,
	},
	"thinking-low": {
		glyph: "›",
		foreground: 0xbcbcbc,
		faint: false,
		background: false,
		underline: false,
		italic: false,
	},
	"thinking-medium": {
		glyph: "›",
		foreground: 0xbcbcbc,
		faint: false,
		background: false,
		underline: false,
		italic: false,
	},
	"thinking-high": {
		glyph: "›",
		foreground: 0xbcbcbc,
		faint: false,
		background: false,
		underline: false,
		italic: false,
	},
	"thinking-xhigh": {
		glyph: "›",
		foreground: 0xbcbcbc,
		faint: false,
		background: false,
		underline: false,
		italic: false,
	},
	"thinking-max": {
		glyph: "›",
		foreground: 0xbcbcbc,
		faint: false,
		background: false,
		underline: false,
		italic: false,
	},
};

/**
 * The accent states the composer frame cannot tell apart from the default.
 *
 * Each entry is a knob that reaches product state and not the prompt cell. A thinking level tints the
 * composer's hidden border and is reported by the status line, which the harness replaces with a test
 * component, so nine levels share one prompt cell. Pinned by exact equality so that a mode joining or
 * leaving this set turns the suite red.
 */
const INDISTINGUISHABLE_FROM_DEFAULT: readonly AccentVariantName[] = [
	"thinking-high",
	"thinking-inherit",
	"thinking-low",
	"thinking-max",
	"thinking-medium",
	"thinking-minimal",
	"thinking-off",
	"thinking-xhigh",
];

interface Observation {
	name: AccentVariantName;
	signature: PromptSignature;
	/** Screen row the prompt landed on. */
	row: number;
	/** Screen column the glyph landed in. */
	column: number;
	/** Composer's first screen row, from the frame's own footer bounds. */
	footerTop: number;
}

const observations: Observation[] = [];

function signatureKey(signature: PromptSignature): string {
	const colour = signature.foreground === null ? "default" : signature.foreground.toString(16);
	const attributes = [
		signature.faint ? "faint" : "",
		signature.background ? "bg" : "",
		signature.underline ? "underline" : "",
		signature.italic ? "italic" : "",
	]
		.filter(part => part.length > 0)
		.join("+");
	return `${signature.glyph}@${colour}${attributes.length > 0 ? `+${attributes}` : ""}`;
}

beforeAll(async () => {
	await initTheme(false);
	for (const variant of ACCENT_VARIANTS) {
		const run = await runComposerOracleScenario({
			width: WIDTH,
			height: HEIGHT,
			modeState: variant.state,
			transcriptLines: 6,
			editorText: TEXT,
		});
		try {
			const rows = run.frameState.rawViewportLines;
			const row = rows.findIndex(line => line.includes(TEXT));
			if (row < 0) throw new Error(`variant ${variant.name} painted no editor row carrying ${TEXT}`);
			const line = rows[row] ?? "";
			const column = line.search(/\S/);
			const foreground = run.terminal.getViewportRowForegroundRgb(row)[column] ?? null;
			observations.push({
				name: variant.name,
				signature: {
					glyph: line.slice(column, column + 1),
					foreground,
					faint: run.terminal.getViewportRowFaintColumns(row).includes(column),
					background: run.terminal.getViewportRowBackgroundColumns(row).includes(column),
					underline: run.terminal.getViewportRowUnderlineColumns(row).includes(column),
					italic: run.terminal.getCellItalic(row, column),
				},
				row,
				column,
				footerTop: run.frameState.screenBounds.footerTop,
			});
		} finally {
			run.cleanUp();
		}
	}
});

describe("every accent mode paints the prompt cell it declares", () => {
	it("mounted every variant the mode axis declares", () => {
		expect(observations.map(o => o.name)).toEqual(ACCENT_VARIANTS.map(v => v.name));
	});

	it("paints the pinned glyph and colour for each mode", () => {
		const observed: Partial<Record<AccentVariantName, PromptSignature>> = {};
		for (const observation of observations) observed[observation.name] = observation.signature;
		expect(observed).toEqual(PROMPT_SIGNATURES);
	});

	it("keeps the prompt in the composer, in one column, whatever the mode", () => {
		for (const observation of observations) {
			expect(observation.row, `${observation.name} painted its prompt above the composer`).toBeGreaterThanOrEqual(
				observation.footerTop,
			);
		}
		const columns = new Set(observations.map(o => o.column));
		expect([...columns]).toEqual([observations[0]?.column]);
	});
});

describe("a mode the frame cannot show is a recorded decision, not a silence", () => {
	it("records exactly the modes that render as the default", () => {
		const base = observations.find(o => o.name === "default");
		if (!base) throw new Error("the default variant was not mounted");
		const same = observations
			.filter(o => o.name !== "default" && signatureKey(o.signature) === signatureKey(base.signature))
			.map(o => o.name)
			.sort();
		expect(same).toEqual([...INDISTINGUISHABLE_FROM_DEFAULT].sort());
	});

	it("gives every distinguishable mode a prompt cell no other mode paints", () => {
		const distinguishable = observations.filter(o => !INDISTINGUISHABLE_FROM_DEFAULT.includes(o.name));
		const byKey = new Map<string, AccentVariantName[]>();
		for (const observation of distinguishable) {
			const key = signatureKey(observation.signature);
			byKey.set(key, [...(byKey.get(key) ?? []), observation.name]);
		}
		const collisions = [...byKey.values()].filter(names => names.length > 1);
		expect(collisions).toEqual([]);
	});
});
