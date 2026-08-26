/**
 * Drive the real `renderDiff` and hand each render to the oracle registry.
 *
 * The renderer is the one the edit tools paint through, called the way they call it, and the theme comes
 * from `initTheme`. Nothing here reimplements a gutter or a width: the oracles measure with the
 * product's own `visibleWidth` and read the gutter out of the rows the renderer returned.
 */

import { visibleWidth } from "@veyyon/tui";
import { sanitizeText } from "@veyyon/utils";
import {
	type DiffInputRow,
	type DiffRenderEvaluationResult,
	type DiffRenderOracleFrameState,
	evaluateAllDiffRenderOracles,
} from "../../../src/modes/components/defect-oracles";
import { renderDiff } from "../../../src/modes/components/diff";

/** A run of numbered context rows, for a diff long enough to cross a gutter boundary. */
function run(count: number, firstLineNumber: number): string[] {
	return Array.from({ length: count }, (_, index) => ` ${firstLineNumber + index}|const value = ${index};`);
}

/**
 * The diffs. Each is a shape the renderer takes a different path through: a single-line replacement
 * (the intra-line word diff), a multi-line block (the plain path), a pure insertion, a gap row, rows
 * with no line number, tab indentation, escape bytes inside the content, and the two line-number
 * crossings the reserved gutter is about.
 */
export const DIFF_FIXTURES: Readonly<Record<string, string>> = {
	singleReplacement: [" 1|const a = 1;", "-2|const b = 2;", "+2|const b = 3;", " 3|const c = 4;"].join("\n"),
	pureInsertion: [" 1|a", "+2|b", "+3|c"].join("\n"),
	pureDeletion: [" 1|a", "-2|b", "-3|c"].join("\n"),
	block: [" 1|a", "-2|b", "-3|c", "+2|B", "+3|C", "+4|D", " 5|e"].join("\n"),
	twoHunks: [" 1|a", "-2|b", "+2|B", "", " 9|c", "-10|d", "+10|D"].join("\n"),
	gapRow: [" 1|a", "", " 9|b"].join("\n"),
	legacyGapMarker: [" 1|a", "...", " 9|b"].join("\n"),
	unicodeGapMarker: [" 1|a", "…", " 9|b"].join("\n"),
	tabIndent: [" 1|\tif (x) {", "-2|\t\treturn 1;", "+2|\t\treturn 2;", " 3|\t}"].join("\n"),
	tabIndentBlock: [" 1|\tif (x) {", "-2|\t\treturn 1;", "-3|\t\tdone();", "+2|\t\treturn 2;"].join("\n"),
	spaceIndent: [" 1|  if (x) {", "-2|    return 1;", "+2|    return 2;"].join("\n"),
	noLineNumbers: ["+|added with no number", "-|removed with no number", " |context with no number"].join("\n"),
	repeatedNumber: ["-7|old", "+7|new"].join("\n"),
	escapeInContent: [' 1|const s = "\\x1b[31mred";', "-2|x", "+2|y"].join("\n"),
	rawEscapeInContent: [` 1|const s = "\x1b[31mred";`, "-2|x", "+2|y"].join("\n"),
	wideGlyphs: [" 1|漢字 = 1", "-2|漢字 = 2", "+2|漢字 = 3"].join("\n"),
	zwjEmoji: [' 1|const x = "👩‍👩‍👧‍👦";', '-2|const y = "👨🏽‍💻";', '+2|const y = "🧑‍🚀";'].join("\n"),
	nulByte: [" 1|a\u0000b", "-2|c\u0000d", "+2|c\u0000e"].join("\n"),
	crlf: [" 1|a\r", "-2|b\r", "+2|c\r"].join("\n"),
	longLine: [` 1|${"x".repeat(400)}`, `-2|${"y".repeat(400)}`, `+2|${"z".repeat(400)}`].join("\n"),
	identicalReplacement: ["-4|same line", "+4|same line"].join("\n"),
	emptyContent: [" 1|", "-2|", "+2|"].join("\n"),
	crossingTen: run(14, 5).join("\n"),
	crossingHundred: run(12, 95).join("\n"),
	crossingThousand: run(14, 990).join("\n"),
	pastThousand: run(8, 9990).join("\n"),
	empty: "",
	onlyBlankRows: "\n\n\n",
} as const;

/** The file paths the sweep drives, which decide whether the syntax highlighter runs at all. */
export const DIFF_FILE_PATHS = [undefined, "src/example.ts", "notes.txt"] as const;

/** Everything a state is built from, and the axis a corpus case records. */
export interface DiffRenderCase {
	fixture: string;
	/** Index into `DIFF_FILE_PATHS`, so a case records a serialisable axis rather than `undefined`. */
	filePath: number;
}

/** How the renderer's own parser reads a diff row. Kept in step with `parseDiffLine`. */
function parseInputRow(raw: string): DiffInputRow {
	const canonical = /^([+\- ])(\d*)\|(.*)$/.exec(raw);
	if (canonical) {
		return {
			raw,
			marker: canonical[1] as "-" | "+" | " ",
			lineNumber: canonical[2],
			content: canonical[3],
		};
	}
	const legacy = /^([+\- ])(\d+) (.*)$/.exec(raw);
	if (legacy) {
		return { raw, marker: legacy[1] as "-" | "+" | " ", lineNumber: legacy[2], content: legacy[3] };
	}
	return { raw, marker: null, lineNumber: "", content: "" };
}

/** The three digits the renderer reserves, from its own `lineNumberWidth` floor. */
const RESERVED_GUTTER_DIGITS = 3;

/** Build the state one render produces, driving the real renderer. */
export function diffStateFor(spec: DiffRenderCase): DiffRenderOracleFrameState {
	const diffText = DIFF_FIXTURES[spec.fixture];
	if (diffText === undefined) {
		throw new Error(`fixture ${spec.fixture} is not one the runner drives.`);
	}
	const filePath = DIFF_FILE_PATHS[spec.filePath];
	if (spec.filePath < 0 || spec.filePath >= DIFF_FILE_PATHS.length) {
		throw new Error(`file path index ${spec.filePath} is not one the runner drives.`);
	}

	const render = (text: string): readonly string[] => renderDiff(text, { filePath }).split("\n");
	// The renderer sanitizes before it splits, so the rows it parses are the sanitized ones. A state
	// built from the raw text would report the sanitization as lost content.
	const sanitizedDiffText = sanitizeText(diffText);
	const inputLines = sanitizedDiffText.split("\n");
	const inputRows = inputLines.map(parseInputRow);

	// Every proper prefix, which is what the transcript paints while the diff is still arriving. The
	// last entry is the whole diff, so the sweep also compares a render against itself.
	const prefixRenders = inputLines.map((_, index) => render(inputLines.slice(0, index + 1).join("\n")));

	return {
		fixture: spec.fixture,
		diffText,
		sanitizedDiffText,
		inputRows,
		rows: render(diffText),
		rowsFromASecondRender: render(diffText),
		prefixRenders,
		everyLineNumberFitsTheReservedGutter: inputRows.every(
			row => row.lineNumber.trim().length <= RESERVED_GUTTER_DIGITS,
		),
		widthOf: visibleWidth,
	};
}

/** Judge one render. */
export function evaluateDiffRenderCase(spec: DiffRenderCase): DiffRenderEvaluationResult {
	return evaluateAllDiffRenderOracles(diffStateFor(spec));
}

/** Every render the sweep drives. */
export function diffRenderCases(): readonly DiffRenderCase[] {
	const cases: DiffRenderCase[] = [];
	for (const fixture of Object.keys(DIFF_FIXTURES)) {
		for (let filePath = 0; filePath < DIFF_FILE_PATHS.length; filePath++) {
			cases.push({ fixture, filePath });
		}
	}
	return cases;
}
