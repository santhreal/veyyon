/**
 * The driver for the dialog-render oracle registry.
 *
 * WHY THIS EXISTS:
 * The two surfaces here are the ones that ask a question: the ask dialog, which a tool call the model
 * wrote drives, and the hook selector, which a hook definition in user configuration drives. Both take
 * their labels as plain data and both paint a card, so a label is the input and the card is what the
 * oracles read.
 *
 * Each is mounted for real. Nothing is faked: the component runs its own measurement, its own card
 * geometry and its own truncation, which is the half of the defect field the inline-markdown registry
 * cannot see.
 *
 * WHAT A CASE IS:
 * One surface, one label set, one width. The comparison renders an oracle needs are further renders of
 * the same mounted component, taken here rather than by the oracle.
 */

import type { ExtensionAskDialogQuestion } from "../../../src/extensibility/extensions";
import { visibleWidth } from "@veyyon/tui";
import { AskDialogComponent } from "../../../src/modes/components/ask-dialog";
import type {
	DialogRenderEvaluationResult,
	DialogRenderOracleFrameState,
} from "../../../src/modes/components/defect-oracles";
import { evaluateAllDialogRenderOracles } from "../../../src/modes/components/defect-oracles";
import { HookSelectorComponent } from "../../../src/modes/components/hook-selector";

/** One label set, in the shape both surfaces can be driven with. */
export interface DialogLabels {
	/** The question or card title. */
	title: string;
	/** The option labels, in order. */
	options: readonly string[];
	/** The option descriptions, indexed alongside `options`; an absent entry means no description. */
	descriptions?: readonly (string | undefined)[];
}

/**
 * The stand-in for the home directory, substituted at mount time.
 *
 * A fixture cannot hold the real home: the path differs per machine and per sandbox, and a fixture
 * carrying a literal `/home/someone` would make the home-path guarantee pass on every run without ever
 * searching for anything. Substituting the real value is what makes the guarantee a test.
 */
export const HOME_TOKEN = "__HOME__";

/**
 * The label sets.
 *
 * Each is a shape a label reaching one of these surfaces actually carries, or a byte that has broken a
 * card somewhere: a tab, a line break, an escape sequence, a wide glyph, a grapheme cluster, a word
 * longer than any card, and a home-directory path.
 */
export const DIALOG_FIXTURES: Readonly<Record<string, DialogLabels>> = {
	plain: {
		title: "Which authentication method should this API use?",
		options: ["JWT", "OAuth2", "Session cookies"],
		descriptions: ["Bearer tokens for stateless clients.", "Delegated authorization.", "Browser-first auth."],
	},
	markdown: {
		title: "Pick **one** of these `values`",
		options: ["alpha `code`", "_beta_", "**gamma**"],
		descriptions: ["a `code` description", undefined, "**bold** description"],
	},
	tabs: {
		title: "Title\twith\ttabs",
		options: ["one\ttab", "two\t\ttabs"],
		descriptions: ["a\tdescription", undefined],
	},
	lineBreaks: {
		title: "Title\nsecond line",
		options: ["one\nline", "two"],
		descriptions: ["first\nsecond", undefined],
	},
	contentSgr: {
		title: "Title \x1b[31mred\x1b[0m",
		options: ["option \x1b[32mgreen\x1b[0m", "plain"],
		descriptions: ["desc \x1b[33myellow\x1b[0m", undefined],
	},
	contentSgrUnterminated: {
		title: "Title \x1b[31m",
		options: ["option \x1b[32m", "plain"],
	},
	contentCsiCursor: {
		title: "Title \x1b[2A up",
		options: ["option \x1b[2K erase", "plain"],
	},
	contentOsc: {
		title: "Title \x1b]8;;http://example.com\x07link\x1b]8;;\x07",
		options: ["option \x1b]0;retitled\x07", "plain"],
	},
	wideGlyphs: {
		title: "毎日の設定を選んでください",
		options: ["漢字のオプション", "ひらがなのおぷしょん"],
		descriptions: ["説明の行", undefined],
	},
	zwjFamily: {
		title: "Pick a 👨‍👩‍👧‍👦 family",
		options: ["👨‍👩‍👧‍👦 one", "🇯🇵 two"],
	},
	longWord: {
		title: `title${"x".repeat(200)}`,
		options: [`option${"y".repeat(200)}`, "short"],
		descriptions: [`desc${"z".repeat(200)}`, undefined],
	},
	homePath: {
		title: "Which file?",
		options: [`${HOME_TOKEN}/projects/thing/src/main.ts`, "relative/path.ts"],
		descriptions: [`under ${HOME_TOKEN}`, undefined],
	},
	nul: {
		title: "Title\u0000here",
		options: ["option\u0000here", "plain"],
	},
	bell: {
		title: "Title\u0007here",
		options: ["option\u0007here", "plain"],
	},
	empty: {
		title: "",
		options: ["", "plain"],
	},
	manyOptions: {
		title: "Pick one of many",
		options: Array.from({ length: 24 }, (_, index) => `option ${index}`),
	},
};

export const DIALOG_FIXTURE_NAMES: readonly string[] = Object.keys(DIALOG_FIXTURES);

/** The surfaces. Both are mounted for real and both draw a card. */
export const DIALOG_SURFACES = ["askDialog", "hookSelector"] as const;

export type DialogSurface = (typeof DIALOG_SURFACES)[number];

/** The widths. 40 is the narrowest a card is designed for; 200 is a wide terminal. */
export const DIALOG_WIDTHS: readonly number[] = [40, 60, 80, 120, 200];

export interface DialogRenderCase {
	surface: DialogSurface;
	fixture: string;
	width: number;
}

/** The width a resize goes to before coming back, chosen so it is never the case's own width. */
function resizeWidthFor(width: number): number {
	return width === 80 ? 100 : 80;
}

/**
 * Every escape sequence the labels of a fixture supply.
 *
 * Derived from the fixture at run time rather than listed beside it, so a fixture that stops carrying
 * an escape makes the content guarantee stand down instead of passing on an empty search.
 */
function labelSuppliedEscapes(labels: DialogLabels): readonly string[] {
	const sequences = new Set<string>();
	const texts = [labels.title, ...labels.options, ...(labels.descriptions ?? []).filter(text => text !== undefined)];
	for (const text of texts) {
		for (const match of text.matchAll(/\x1b(?:\[[0-9;:<=>?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g)) {
			sequences.add(match[0]);
		}
	}
	return [...sequences];
}

/** The home directory as the process sees it, or an empty string when there is none. */
function homeDirectory(): string {
	return process.env.HOME ?? "";
}

/** Substitute the home token, so a fixture's path is the real home rather than a literal. */
function resolved(labels: DialogLabels): DialogLabels {
	const home = homeDirectory();
	const substitute = (text: string): string => text.replaceAll(HOME_TOKEN, home);
	return {
		title: substitute(labels.title),
		options: labels.options.map(substitute),
		descriptions: labels.descriptions?.map(text => (text === undefined ? undefined : substitute(text))),
	};
}

function askQuestionFor(labels: DialogLabels): ExtensionAskDialogQuestion {
	return {
		id: "oracle",
		question: labels.title,
		options: labels.options.map((option, index) => {
			const description = labels.descriptions?.[index];
			return description === undefined ? { label: option } : { label: option, description };
		}),
		recommended: 0,
	} as ExtensionAskDialogQuestion;
}

function mountAskDialog(labels: DialogLabels): { render: (width: number) => readonly string[] } {
	const component = new AskDialogComponent([askQuestionFor(labels)], {
		onSubmit: () => {},
		onCancel: () => {},
		onPrompt: () => Promise.resolve(undefined),
	});
	return { render: width => component.render(width) };
}

function mountHookSelector(labels: DialogLabels): { render: (width: number) => readonly string[] } {
	const component = new HookSelectorComponent(
		labels.title,
		labels.options.map((option, index) => {
			const description = labels.descriptions?.[index];
			return description === undefined ? { label: option } : { label: option, description };
		}),
		() => {},
		() => {},
	);
	return { render: width => component.render(width) };
}

const MOUNTS: Readonly<
	Record<DialogSurface, (labels: DialogLabels) => { render: (width: number) => readonly string[] }>
> = {
	askDialog: mountAskDialog,
	hookSelector: mountHookSelector,
};

/** Build the state for one case, taking every comparison render off the same mounted component. */
export function dialogStateFor(spec: DialogRenderCase): DialogRenderOracleFrameState {
	const labels = DIALOG_FIXTURES[spec.fixture];
	if (labels === undefined) {
		throw new Error(
			`unknown dialog fixture ${JSON.stringify(spec.fixture)}; the known ones are ${DIALOG_FIXTURE_NAMES.join(", ")}`,
		);
	}
	if (!DIALOG_WIDTHS.includes(spec.width)) {
		throw new Error(`width ${spec.width} is not one the sweep drives; the widths are ${DIALOG_WIDTHS.join(", ")}`);
	}
	const mount = MOUNTS[spec.surface];
	const component = mount(resolved(labels));
	const rows = component.render(spec.width);
	const rowsFromASecondRender = component.render(spec.width);
	component.render(resizeWidthFor(spec.width));
	const rowsAfterAResize = component.render(spec.width);
	return {
		surface: spec.surface,
		fixture: spec.fixture,
		width: spec.width,
		labelSuppliedEscapes: labelSuppliedEscapes(labels),
		homeDirectory: homeDirectory(),
		rows,
		rowsFromASecondRender,
		rowsAfterAResize,
		carded: true,
		widthOf: visibleWidth,
	};
}

/** Judge one case. */
export function evaluateDialogRenderCase(spec: DialogRenderCase): DialogRenderEvaluationResult {
	return evaluateAllDialogRenderOracles(dialogStateFor(spec));
}

/**
 * The reason a surface refuses to mount a label set, or null when it mounts.
 *
 * A surface that validates its input is not a hole: the ask dialog rejects an empty question outright,
 * and that rejection is a contract worth pinning. The sweep partitions on this rather than swallowing
 * the throw, so a surface that stops validating turns a suite red instead of quietly gaining cases.
 */
export function dialogMountRejection(spec: DialogRenderCase): string | null {
	const labels = DIALOG_FIXTURES[spec.fixture];
	if (labels === undefined) return `unknown fixture ${spec.fixture}`;
	try {
		MOUNTS[spec.surface](resolved(labels)).render(spec.width);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** Every case the sweep drives: each fixture on each surface at each width. */
export function dialogRenderCases(): readonly DialogRenderCase[] {
	const cases: DialogRenderCase[] = [];
	for (const surface of DIALOG_SURFACES) {
		for (const fixture of DIALOG_FIXTURE_NAMES) {
			for (const width of DIALOG_WIDTHS) cases.push({ surface, fixture, width });
		}
	}
	return cases;
}
