/**
 * The defect oracles for the inline markdown renderer every dialog and selector row paints a label
 * through.
 *
 * WHY THIS REGISTRY EXISTS:
 * `renderInlineMarkdown` styles one line of markdown and returns it as a single string. Twelve call
 * sites paint that string into a row they have already sized and positioned: an ask-dialog question,
 * an ask-dialog option label and description, a hook-selector label and description, and the option
 * rows of the ask tool. None of them wraps the result, measures it, or sanitizes it afterwards. The
 * containing component has already decided where the row starts and how tall it is.
 *
 * That makes the function's obligation stricter than the block renderer's, not weaker. The markdown
 * component owns whole rows and terminates each one itself; this function hands a fragment to a caller
 * who will concatenate it with a border, a caret and a padding run. A fragment carrying a line break
 * moves the cursor into the row below the one the caller reserved. A fragment carrying a raw tab jumps
 * to the next tab stop, past the caller's border. A fragment carrying an escape byte the content
 * supplied paints in a colour the theme did not choose, and one carrying an unterminated sequence
 * leaves every cell after it in that state.
 *
 * The text is not trusted input. An ask-dialog option label and description come from a tool call the
 * model wrote; a hook-selector label comes from a hook definition in user configuration. Both reach
 * this function as-is.
 *
 * WHAT A STATE IS:
 * One source string and its render, plus the renders it has to agree with: the same source rendered
 * again, and the same source rendered with no base colour. A guarantee that needs a comparison reads
 * it from the state rather than rendering again, so an oracle never drives the function it judges.
 *
 * WHAT IS NOT JUDGED HERE:
 * Which markdown constructs the function styles, and how. That a link paints its label and drops its
 * href, that an entity is decoded, that a heading loses its hashes, and which theme token a code span
 * gets are decisions with their own tests. These oracles read what the returned fragment has to
 * satisfy whatever the markdown said, because the caller cannot repair it.
 */

import { type DefectEvaluation, evaluateOracleRegistry, type OracleProbe } from "./defect-oracle-registry";

export const INLINE_MARKDOWN_ORACLE_GUARANTEES = [
	"theRenderedFragmentIsASingleLine",
	"theRenderedFragmentForwardsNoRawTab",
	"theRenderedFragmentCarriesNoC0Control",
	"everyEscapeInTheFragmentIsComplete",
	"noContentSuppliedEscapeSurvivesIntoTheFragment",
	"theFragmentClosesEveryStyleItOpens",
	"everyPaintedCellSitsInsideAStyle",
	"noWordOfTheSourceIsDroppedFromTheFragment",
	"aSecondRenderReturnsTheSameFragment",
	"strippingTheStylesLeavesWhatAnUnstyledRenderPaints",
] as const;

export type InlineMarkdownOracleGuarantee = (typeof INLINE_MARKDOWN_ORACLE_GUARANTEES)[number];

/** One inline render, and the renders it has to agree with. */
export interface InlineMarkdownOracleFrameState {
	/** The name of the source fixture, for a failure that names the case. */
	fixture: string;
	/** The markdown the caller handed over. */
	source: string;
	/** Whether the caller supplied a base colour, which every plain segment has to carry. */
	hasBaseColour: boolean;
	/** The rendered fragment. */
	fragment: string;
	/** The same source rendered a second time. */
	fragmentFromASecondRender: string;
	/** The same source rendered with no base colour, which is the shape three call sites use. */
	fragmentWithNoBaseColour: string;
	/**
	 * The same source rendered after every escape byte was removed from it, which is the control for
	 * the content-escape guarantee.
	 *
	 * Counting escapes in the fragment cannot separate a sequence the theme emitted from one the source
	 * supplied, because both are the same bytes. Rendering the source twice, once as written and once
	 * with its escape bytes gone, makes the difference between the two fragments exactly the sequences
	 * the renderer let through.
	 */
	fragmentFromSourceWithNoEscapes: string;
	/** The product's own width function, so an oracle measures a fragment the way the product does. */
	widthOf: (text: string) => number;
}

export interface InlineMarkdownOracleFailure {
	oracle: InlineMarkdownOracleGuarantee;
	message: string;
}

export type InlineMarkdownEvaluationResult = DefectEvaluation<
	InlineMarkdownOracleGuarantee,
	InlineMarkdownOracleFailure
>;

const CSI = /^\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/;
const OSC = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
const SHORT_ESCAPE = /^\x1b(?![[\]])[ -/]*[0-~]/;

/**
 * The SGR parameters that turn an attribute off.
 *
 * A fragment is concatenated into a row the caller is still building, so the terminal state it leaves
 * behind is the state the rest of that row paints in. `0` resets everything; the rest close one
 * attribute each, and each is the documented off switch for the family whose on switches sit ten or
 * twenty below it.
 */
const SGR_CLOSERS = new Set(["0", "", "21", "22", "23", "24", "25", "27", "28", "29", "39", "49", "59"]);

/** Strip every complete escape sequence, leaving the cells a fragment paints. */
export function plainFragment(fragment: string): string {
	let out = "";
	for (let index = 0; index < fragment.length; ) {
		if (fragment[index] === "\x1b") {
			const rest = fragment.slice(index);
			const match = CSI.exec(rest) ?? OSC.exec(rest) ?? SHORT_ESCAPE.exec(rest);
			if (match) {
				index += match[0].length;
				continue;
			}
		}
		out += fragment[index];
		index += 1;
	}
	return out;
}

/** The index of the first ESC that does not begin a complete sequence, or -1. */
function severedEscapeAt(fragment: string): number {
	for (let index = 0; index < fragment.length; index++) {
		if (fragment[index] !== "\x1b") continue;
		const rest = fragment.slice(index);
		if (CSI.test(rest) || OSC.test(rest) || SHORT_ESCAPE.test(rest)) continue;
		return index;
	}
	return -1;
}

/**
 * How many SGR attributes the fragment leaves open at its end.
 *
 * Counted rather than matched by family: a fragment nests styles, and the terminal keeps a single
 * attribute set rather than a stack, so what matters to the caller is whether the count returns to
 * zero. `0` closes everything at once and takes the count with it.
 */
function openStylesAtEnd(fragment: string): number {
	let open = 0;
	for (let index = 0; index < fragment.length; ) {
		if (fragment[index] !== "\x1b") {
			index += 1;
			continue;
		}
		const rest = fragment.slice(index);
		const match = CSI.exec(rest) ?? OSC.exec(rest) ?? SHORT_ESCAPE.exec(rest);
		if (!match) {
			index += 1;
			continue;
		}
		open = openAfter(open, match[0]);
		index += match[0].length;
	}
	return open;
}

/** The open-attribute count after one sequence, which is the one reading of SGR both walks share. */
function openAfter(open: number, sequence: string): number {
	if (!sequence.startsWith("\x1b[") || !sequence.endsWith("m")) return open;
	let next = open;
	for (const parameter of sequence.slice(2, -1).split(";")) {
		if (parameter === "0" || parameter === "") {
			next = 0;
			continue;
		}
		if (SGR_CLOSERS.has(parameter)) {
			next = Math.max(0, next - 1);
			continue;
		}
		// An extended colour writes its channels as further parameters of the same sequence. They are
		// not attributes of their own, so a 38;5;250 or 38;2;r;g;b opens one, not three or five.
		if (parameter === "38" || parameter === "48" || parameter === "58") {
			next += 1;
			break;
		}
		next += 1;
	}
	return next;
}

/**
 * Every complete escape sequence of a fragment, in order.
 *
 * The comparison is a multiset difference rather than a set one: a source supplying the same sequence
 * the theme also emits would otherwise hide inside the theme's own copy.
 */
function escapeSequences(fragment: string): readonly string[] {
	const found: string[] = [];
	for (let index = 0; index < fragment.length; ) {
		if (fragment[index] !== "\x1b") {
			index += 1;
			continue;
		}
		const rest = fragment.slice(index);
		const match = CSI.exec(rest) ?? OSC.exec(rest) ?? SHORT_ESCAPE.exec(rest);
		if (!match) {
			found.push("\x1b");
			index += 1;
			continue;
		}
		found.push(match[0]);
		index += match[0].length;
	}
	return found;
}

/** The sequences the fragment carries that a render of the same source without escape bytes does not. */
function escapeSurplus(fragment: string, control: string): readonly string[] {
	const remaining = new Map<string, number>();
	for (const sequence of escapeSequences(control)) {
		remaining.set(sequence, (remaining.get(sequence) ?? 0) + 1);
	}
	const surplus: string[] = [];
	for (const sequence of escapeSequences(fragment)) {
		const left = remaining.get(sequence) ?? 0;
		if (left > 0) {
			remaining.set(sequence, left - 1);
			continue;
		}
		surplus.push(sequence);
	}
	return surplus;
}

/**
 * The index of the first printable cell the fragment paints with no SGR attribute open, or -1.
 *
 * Whitespace is excluded: a separator run between two styled segments paints nothing, so its colour
 * cannot be observed, and every construct that joins two segments emits one.
 */
function firstUnstyledCell(fragment: string): number {
	let open = 0;
	for (let index = 0; index < fragment.length; ) {
		if (fragment[index] === "\x1b") {
			const rest = fragment.slice(index);
			const match = CSI.exec(rest) ?? OSC.exec(rest) ?? SHORT_ESCAPE.exec(rest);
			if (match) {
				open = openAfter(open, match[0]);
				index += match[0].length;
				continue;
			}
		}
		const char = fragment[index] ?? "";
		if (open === 0 && char.trim().length > 0) return index;
		index += 1;
	}
	return -1;
}

/**
 * The C0 bytes another guarantee owns.
 *
 * A tab, a line feed and a carriage return each have a guarantee that names the row damage they do, so
 * a control check that also reported them would fail two oracles on one byte and make a crafted defect
 * impossible to attribute.
 */
const OWNED_ELSEWHERE = new Set([0x09, 0x0a, 0x0d]);

/** The alphanumeric runs of a source that a render has to still paint somewhere. */
const WORD = /[A-Za-z0-9]{3,}/g;

/**
 * The runs a markdown render is allowed to drop, because dropping them is what the construct means.
 *
 * A link paints its label and drops its href; an entity reference paints the character it names and
 * drops the name. Both are the renderer doing its job, so a word survival check that did not know
 * about them would report the design as a defect on every fixture that used one.
 */
function droppedByDesign(source: string): ReadonlySet<string> {
	const allowed = new Set<string>();
	for (const match of source.matchAll(/\]\(([^)]*)\)/g)) {
		for (const word of match[1].match(WORD) ?? []) allowed.add(word);
	}
	for (const match of source.matchAll(/<([^>\s]*)/g)) {
		for (const word of match[1].match(WORD) ?? []) allowed.add(word);
	}
	for (const match of source.matchAll(/&([A-Za-z]+);/g)) allowed.add(match[1]);
	for (const match of source.matchAll(/```([A-Za-z0-9]*)/g)) if (match[1]) allowed.add(match[1]);
	return allowed;
}

function label(state: InlineMarkdownOracleFrameState): string {
	return `${state.fixture}@${state.hasBaseColour ? "based" : "bare"}`;
}

interface InlineMarkdownOracle {
	guarantee: string;
	appliesTo: (state: InlineMarkdownOracleFrameState) => boolean;
	subject: string;
	subjectSize: (state: InlineMarkdownOracleFrameState) => number;
	check: (state: InlineMarkdownOracleFrameState) => InlineMarkdownOracleFailure | null;
}

const always = (): boolean => true;
const fragmentLength = (state: InlineMarkdownOracleFrameState): number => state.fragment.length;

export const INLINE_MARKDOWN_ORACLES: Readonly<Record<InlineMarkdownOracleGuarantee, InlineMarkdownOracle>> = {
	theRenderedFragmentIsASingleLine: {
		guarantee:
			"The fragment goes into a row the caller has already sized. A line break inside it moves the cursor into the row below, so the caller paints its border over the second line and every row after shifts.",
		appliesTo: always,
		subject: "the rendered fragment",
		subjectSize: fragmentLength,
		check: state => {
			const at = state.fragment.search(/[\n\r]/);
			if (at < 0) return null;
			return {
				oracle: "theRenderedFragmentIsASingleLine",
				message: `${label(state)}: the fragment carries a line break at ${at}: ${JSON.stringify(state.fragment.slice(0, 60))}`,
			};
		},
	},
	theRenderedFragmentForwardsNoRawTab: {
		guarantee:
			"A tab jumps to the next stop rather than advancing one cell, so a fragment carrying one lands past the border the caller drew and measures as a different width than it paints.",
		appliesTo: always,
		subject: "the rendered fragment",
		subjectSize: fragmentLength,
		check: state => {
			const at = state.fragment.indexOf("\t");
			if (at < 0) return null;
			return {
				oracle: "theRenderedFragmentForwardsNoRawTab",
				message: `${label(state)}: the fragment forwards a raw tab at ${at}: ${JSON.stringify(state.fragment.slice(0, 60))}`,
			};
		},
	},
	theRenderedFragmentCarriesNoC0Control: {
		guarantee:
			"A C0 byte other than ESC is an instruction to the terminal, not a cell. A BEL rings, a backspace moves left over a cell already painted, and a vertical tab scrolls. The line and tab bytes have their own guarantees, so this one owns the rest.",
		appliesTo: always,
		subject: "the rendered fragment",
		subjectSize: fragmentLength,
		check: state => {
			// A BEL terminates an OSC, so a fragment carrying one is judged by the sever guarantee rather
			// than here: the two report the same defect otherwise, and a severed OSC is what makes the
			// BEL live in the first place.
			const carriesAnOsc = state.fragment.includes("\x1b]");
			for (let index = 0; index < state.fragment.length; index++) {
				const code = state.fragment.charCodeAt(index);
				if (code >= 0x20 || code === 0x1b) continue;
				if (OWNED_ELSEWHERE.has(code)) continue;
				if (code === 0x07 && carriesAnOsc) continue;
				return {
					oracle: "theRenderedFragmentCarriesNoC0Control",
					message: `${label(state)}: the fragment carries control byte 0x${code.toString(16).padStart(2, "0")} at ${index}: ${JSON.stringify(state.fragment.slice(0, 60))}`,
				};
			}
			return null;
		},
	},
	everyEscapeInTheFragmentIsComplete: {
		guarantee:
			"An ESC that begins no complete sequence leaves the terminal consuming the caller's border, caret and padding as sequence parameters.",
		appliesTo: state => state.fragment.includes("\x1b"),
		subject: "the escape sequences in the fragment",
		subjectSize: state => (state.fragment.match(/\x1b/g) ?? []).length,
		check: state => {
			const at = severedEscapeAt(state.fragment);
			if (at < 0) return null;
			return {
				oracle: "everyEscapeInTheFragmentIsComplete",
				message: `${label(state)}: the fragment severs an escape sequence at ${at}: ${JSON.stringify(state.fragment.slice(at, at + 30))}`,
			};
		},
	},
	noContentSuppliedEscapeSurvivesIntoTheFragment: {
		guarantee:
			"An option label comes from a model tool call and a hook label comes from user configuration. An escape byte in either has to be a cell or be gone, because a surviving one paints in a colour the theme did not pick and can move the cursor.",
		appliesTo: state => state.source.includes("\x1b"),
		subject: "the escape bytes the source supplied",
		subjectSize: state => (state.source.match(/\x1b/g) ?? []).length,
		check: state => {
			const surplus = escapeSurplus(state.fragment, state.fragmentFromSourceWithNoEscapes);
			if (surplus.length === 0) return null;
			return {
				oracle: "noContentSuppliedEscapeSurvivesIntoTheFragment",
				message: `${label(state)}: the fragment carries ${surplus.length} escape sequences an escape-free source does not produce, starting with ${JSON.stringify(surplus[0])}`,
			};
		},
	},
	theFragmentClosesEveryStyleItOpens: {
		guarantee:
			"The caller concatenates the fragment with the rest of its row, so an attribute left open paints every cell after it. A row is not a reset boundary here: the fragment sits in the middle of one.",
		appliesTo: state => state.fragment.includes("\x1b"),
		subject: "the SGR sequences in the fragment",
		subjectSize: state => (state.fragment.match(/\x1b\[[0-9;:]*m/g) ?? []).length,
		check: state => {
			const open = openStylesAtEnd(state.fragment);
			if (open === 0) return null;
			return {
				oracle: "theFragmentClosesEveryStyleItOpens",
				message: `${label(state)}: the fragment leaves ${open} style attributes open: ${JSON.stringify(state.fragment.slice(-60))}`,
			};
		},
	},
	everyPaintedCellSitsInsideAStyle: {
		guarantee:
			"A caller passes a base colour so the row reads in the colour it chose for that row's state. A cell painted with no attribute open reads in whatever the terminal was left in by the row above, which is why a selected row can show one word in the previous row's colour.",
		appliesTo: state => state.hasBaseColour && plainFragment(state.fragment).trim().length > 0,
		subject: "the painted cells of the fragment",
		subjectSize: state => plainFragment(state.fragment).length,
		check: state => {
			const at = firstUnstyledCell(state.fragment);
			if (at < 0) return null;
			return {
				oracle: "everyPaintedCellSitsInsideAStyle",
				message: `${label(state)}: the cell at ${at} paints with no style open: ${JSON.stringify(state.fragment.slice(Math.max(0, at - 10), at + 20))}`,
			};
		},
	},
	noWordOfTheSourceIsDroppedFromTheFragment: {
		guarantee:
			"A label that loses a word is a label that says something else. Markup the construct consumes is not a word: a link's href, a tag's name, an entity's name and a fence's language are dropped because that is what the construct means.",
		appliesTo: state => (plainFragment(state.source).match(WORD) ?? []).length > 0,
		subject: "the alphanumeric runs of the source",
		subjectSize: state => (plainFragment(state.source).match(WORD) ?? []).length,
		check: state => {
			// The source is read with its own escape sequences stripped. A sequence's parameters are not
			// words the label says: an escape byte the source carried is the content-escape guarantee's
			// subject, and counting `31m` as a dropped word would report the stripping as a loss.
			const sourceCells = plainFragment(state.source);
			const allowed = droppedByDesign(sourceCells);
			const painted = plainFragment(state.fragment);
			const missing = (sourceCells.match(WORD) ?? []).filter(word => !allowed.has(word) && !painted.includes(word));
			if (missing.length === 0) return null;
			return {
				oracle: "noWordOfTheSourceIsDroppedFromTheFragment",
				message: `${label(state)}: the fragment drops ${JSON.stringify(missing.slice(0, 6))} from ${JSON.stringify(state.source.slice(0, 60))}`,
			};
		},
	},
	aSecondRenderReturnsTheSameFragment: {
		guarantee:
			"The lexer caches across calls, and a dialog re-renders its rows on every keystroke. A second render that differs means the row changes under a caret that did not move.",
		appliesTo: always,
		subject: "the fragment against a second render of the same source",
		subjectSize: fragmentLength,
		check: state => {
			if (state.fragment === state.fragmentFromASecondRender) return null;
			const at = [...state.fragment].findIndex((char, index) => char !== state.fragmentFromASecondRender[index]);
			return {
				oracle: "aSecondRenderReturnsTheSameFragment",
				message: `${label(state)}: a second render differs from ${at < 0 ? state.fragment.length : at}: ${JSON.stringify(state.fragment.slice(Math.max(0, at), at + 30))} against ${JSON.stringify(state.fragmentFromASecondRender.slice(Math.max(0, at), at + 30))}`,
			};
		},
	},
	strippingTheStylesLeavesWhatAnUnstyledRenderPaints: {
		guarantee:
			"A base colour is a wrapper around the same cells. Nine of the twelve call sites pass one and three do not, so a base colour that changes which characters are painted makes the two paths different renderers.",
		appliesTo: state => state.hasBaseColour,
		subject: "the painted cells against an unstyled render of the same source",
		subjectSize: fragmentLength,
		check: state => {
			const withBase = plainFragment(state.fragment);
			const without = plainFragment(state.fragmentWithNoBaseColour);
			if (withBase === without) return null;
			const at = [...withBase].findIndex((char, index) => char !== without[index]);
			return {
				oracle: "strippingTheStylesLeavesWhatAnUnstyledRenderPaints",
				message: `${label(state)}: the base colour changes the painted cells from ${at < 0 ? withBase.length : at}: ${JSON.stringify(withBase.slice(Math.max(0, at), at + 30))} against ${JSON.stringify(without.slice(Math.max(0, at), at + 30))}`,
			};
		},
	},
};

const PROBE: OracleProbe<InlineMarkdownOracleGuarantee, InlineMarkdownOracleFrameState, InlineMarkdownOracleFailure> = {
	appliesTo: (id, state) => INLINE_MARKDOWN_ORACLES[id].appliesTo(state),
	subjectSize: (id, state) => INLINE_MARKDOWN_ORACLES[id].subjectSize(state),
	check: (id, state) => INLINE_MARKDOWN_ORACLES[id].check(state),
};

/** Judge one inline markdown render against every guarantee in the registry. */
export function evaluateAllInlineMarkdownOracles(
	state: InlineMarkdownOracleFrameState,
): InlineMarkdownEvaluationResult {
	return evaluateOracleRegistry(INLINE_MARKDOWN_ORACLE_GUARANTEES, state, PROBE);
}
