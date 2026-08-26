/**
 * Drive the real text primitives and hand each application to the oracle registry.
 *
 * The functions come from `@veyyon/tui` and `src/tools/render-utils`, the ones the TUI sanitization
 * rules require every renderer to call. Nothing here reimplements a measurement: an oracle reads the
 * product's own `visibleWidth`, so a defect in the measurement shows up as a width claim rather than
 * being hidden by a second opinion.
 */

import { Ellipsis, replaceTabs, sliceWithWidth, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@veyyon/tui";
import {
	evaluateAllTextPrimitiveOracles,
	plainText,
	TEXT_PRIMITIVES,
	type TextPrimitive,
	type TextPrimitiveEvaluationResult,
	type TextPrimitiveOracleFrameState,
} from "../../../src/modes/components/defect-oracles";
import { shortenPath } from "../../../src/tools/render-utils";

/** The home directory a `shortenPath` application is given, so no real one reaches an assertion. */
export const TEXT_FIXTURE_HOME = "/home/oracle-operator";

/**
 * The inputs. Each is a shape that has broken a width, a wrap or a truncation somewhere: a wide
 * glyph that costs two cells per code unit, a grapheme cluster built out of joiners, a combining mark
 * that costs none, style bytes that cost none, a tab that jumps to a stop, a break that moves the
 * cursor, and a control byte that does neither.
 */
export const TEXT_FIXTURES: Readonly<Record<string, string>> = {
	empty: "",
	ascii: "the quick brown fox jumps over the lazy dog",
	oneLongWord: "supercalifragilisticexpialidocious-and-then-some-more-besides",
	wideGlyphs: "漢字漢字漢字漢字漢字漢字漢字漢字",
	mixedWidth: "ascii 漢字 ascii 漢字 ascii",
	zwjEmoji: "👩‍👩‍👧‍👦 family 👨🏽‍💻 dev",
	combining: "e\u0301e\u0301e\u0301 combining marks",
	styled: "\x1b[1;31mred bold\x1b[39m plain \x1b[4munderline\x1b[0m tail",
	styledWide: "\x1b[32m漢字漢字\x1b[39m plain 漢字",
	osc8Link: "\x1b]8;;https://example.com\x07link text\x1b]8;;\x07 after",
	tabs: "col\tcol\tcol",
	leadingTab: "\tindented body",
	lineBreaks: "first\nsecond\r\nthird\rfourth",
	controlBytes: "a\x00b\x07c\x08d",
	rtl: "\u0627\u0644\u0639\u0631\u0628\u064a\u0629 arabic text",
	thai: "\u0e01\u0e33\u0e2b\u0e19\u0e14 thai text",
	homePath: `${TEXT_FIXTURE_HOME}/projects/veyyon/packages/tui/src/utils.ts`,
	homeItself: TEXT_FIXTURE_HOME,
	homeLookalike: `${TEXT_FIXTURE_HOME}extra/not-under-home.ts`,
	spaces: "a   b    c     d",
} as const;

/** The widths the sweep asks for. Zero, one and two are where a wide glyph has nowhere to go. */
export const TEXT_WIDTHS = [0, 1, 2, 3, 5, 8, 13, 20, 40, 80] as const;

/** The ellipsis kinds a truncation can be asked for, by the label a corpus case records. */
export const ELLIPSIS_KINDS: Readonly<Record<string, Ellipsis>> = {
	unicode: Ellipsis.Unicode,
	ascii: Ellipsis.Ascii,
	omit: Ellipsis.Omit,
};

/** Everything a state is built from, and the axis a corpus case records. */
export interface TextPrimitiveCase {
	primitive: TextPrimitive;
	fixture: string;
	width: number;
	/** The ellipsis label for a truncation, `"none"` for every other primitive. */
	ellipsis: string;
	pad: boolean;
	strict: boolean;
	startColumn: number;
}

function applyPrimitive(spec: TextPrimitiveCase, input: string): readonly string[] {
	switch (spec.primitive) {
		case "truncate":
			return [truncateToWidth(input, spec.width, ELLIPSIS_KINDS[spec.ellipsis], spec.pad)];
		case "wrap":
			return wrapTextWithAnsi(input, spec.width);
		case "slice":
			return [sliceWithWidth(input, spec.startColumn, spec.width, spec.strict).text];
		case "expandTabs":
			return [replaceTabs(input)];
		case "shortenPath":
			return [shortenPath(input, TEXT_FIXTURE_HOME)];
		case "measure":
			return [input];
	}
}

/** Build the state one application produces, driving the real primitive. */
export function textPrimitiveStateFor(spec: TextPrimitiveCase): TextPrimitiveOracleFrameState {
	const input = TEXT_FIXTURES[spec.fixture];
	if (input === undefined) {
		throw new Error(`fixture ${spec.fixture} is not one the runner drives.`);
	}
	const rows = applyPrimitive(spec, input);
	const reappliedRow =
		spec.primitive === "truncate"
			? truncateToWidth(rows[0] ?? "", spec.width, ELLIPSIS_KINDS[spec.ellipsis], spec.pad)
			: (rows[0] ?? "");
	return {
		primitive: spec.primitive,
		fixture: spec.fixture,
		input,
		width: spec.width,
		pad: spec.pad,
		strict: spec.strict,
		startColumn: spec.startColumn,
		rows,
		measuredWidth: visibleWidth(input),
		measuredPlainWidth: visibleWidth(plainText(input)),
		homeDir: spec.primitive === "shortenPath" ? TEXT_FIXTURE_HOME : "",
		widthOf: visibleWidth,
		reappliedRow,
	};
}

/** Judge one application. */
export function evaluateTextPrimitiveCase(spec: TextPrimitiveCase): TextPrimitiveEvaluationResult {
	return evaluateAllTextPrimitiveOracles(textPrimitiveStateFor(spec));
}

/**
 * Every application the sweep drives.
 *
 * The option axes are per primitive rather than a flat cross product: a `pad` on a wrap and a
 * `startColumn` on a tab expansion are the same application twice, and a sweep that swept them would
 * report a count that overstates what it covered.
 */
export function textPrimitiveCases(): readonly TextPrimitiveCase[] {
	const cases: TextPrimitiveCase[] = [];
	for (const fixture of Object.keys(TEXT_FIXTURES)) {
		for (const primitive of TEXT_PRIMITIVES) {
			if (primitive === "measure" || primitive === "expandTabs" || primitive === "shortenPath") {
				cases.push({ primitive, fixture, width: -1, ellipsis: "none", pad: false, strict: false, startColumn: 0 });
				continue;
			}
			for (const width of TEXT_WIDTHS) {
				if (primitive === "truncate") {
					for (const ellipsis of Object.keys(ELLIPSIS_KINDS)) {
						for (const pad of [false, true]) {
							cases.push({ primitive, fixture, width, ellipsis, pad, strict: false, startColumn: 0 });
						}
					}
					continue;
				}
				if (primitive === "slice") {
					for (const strict of [false, true]) {
						for (const startColumn of [0, 1, 2, 5]) {
							cases.push({ primitive, fixture, width, ellipsis: "none", pad: false, strict, startColumn });
						}
					}
					continue;
				}
				cases.push({ primitive, fixture, width, ellipsis: "none", pad: false, strict: false, startColumn: 0 });
			}
		}
	}
	return cases;
}
