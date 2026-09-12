/**
 * No string a tool puts in a view reaches the terminal with a control sequence still in it.
 *
 * THE DEFECT. `drawToolView` is the one place every host-agnostic view becomes terminal bytes, and
 * its text normalizer replaced tabs and shortened the home directory and stripped nothing else. A
 * tool that built a span from a model-supplied reason (`resolve`), a file's contents (`read`'s code
 * section) or arbitrary arguments (the generic JSON card) handed `\x1b[2J` and an OSC 8 hyperlink
 * straight through, and the terminal obeyed them: the screen cleared, the link pointed wherever the
 * text said. `contracts/view` states that `captured` is the ONE run whose bytes are the program's
 * own and that a host "strips the rest"; the rest was not stripped.
 *
 * THE CLASS. Every free-text string field of every `ToolView` kind, on every path the terminal draws
 * it: a span drawn plain, emphasized, as a badge, as inline Markdown, live; a status row's title,
 * description and badge; a section's label and its lines as prose, as a list, as source, as a
 * change, as a document, as a tree; a hidden count's noun; a notice's headline, tag and body. The
 * kinds come from `VIEW_KINDS_DRAWN`, which is typed over the contract's union, and the field
 * inventory from fixtures typed `Required<>` over each contract interface, so a new kind or a new
 * string field fails here until it is classified as text the host strips or a vocabulary the host
 * resolves. Two producers are driven end to end as backtests: the `resolve` card with the reported
 * reason, and the JSON card with a hostile argument.
 *
 * WHAT IT DOES NOT CATCH. Vocabulary fields -- a tone, a status, an emblem key, a language name, a
 * URL -- which the host looks up or validates rather than draws; those are pinned as such and not
 * fed hostile text. And the GUI host, which draws the same views as HTML and owns its own strip.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { drawToolView, VIEW_KINDS_DRAWN } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import { resolveToolView } from "@veyyon/coding-agent/tools/agent/resolve-view";
import { jsonTreeViewLines } from "@veyyon/coding-agent/tools/core/json-tree-view";
import { toolViewDefinitions } from "@veyyon/coding-agent/tools/view-registry";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import type {
	FramedBlockView,
	HeadedBlockView,
	NoticeView,
	StatusRowView,
	TextBlockView,
	ToolView,
	ViewCodeLines,
	ViewDiffLines,
	ViewHiddenCount,
	ViewSection,
	ViewSpan,
} from "@veyyon/view";
import { INTENT_FIELD } from "@veyyon/wire";

const HOME = os.homedir();

/**
 * One string carrying every class of byte the host must not pass on: a screen clear (CSI ED), an
 * OSC 8 hyperlink closed by ST, an 8-bit C1 CSI (a complete `CSI 2 J`, so the letter after it is
 * text and not a final byte), an OSC closed by BEL, a tab and the home directory. The letters
 * between them are what a reader is owed once the bytes are gone.
 */
const HOSTILE = `A\x1b[2JB\x1b]8;;http://evil\x1b\\C\x1b]8;;\x1b\\D\x9b2JE\x1b]8;;http://x\x07F\tG ${HOME}/secret H`;

/**
 * The bytes a captured run may keep: the program's own colour, which the terminal replays. A
 * 256-colour SGR, which is in the set `styleTerminalRow` reproduces; a 16-colour code is not.
 */
const CAPTURED_COLOUR = "\x1b[38;5;196m";
const CAPTURED = `${CAPTURED_COLOUR}red\x1b[0m \x1b[2Jclear \x1b]8;;http://evil\x1b\\link`;

const WIDTH = 200;

/** The host's own OSC 8 hyperlinks, which it builds from a validated URL rather than from text. */
const HOST_HYPERLINK = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** An SGR sequence, which is the theme's own colour and the one control a drawn row may carry. */
const SGR = /\x1b\[[0-9;:]*m/g;

/**
 * Every control byte left in a row once the theme's SGR and the host's own hyperlinks are removed,
 * plus the tab and the home directory the host is owed to have replaced.
 *
 * `payload` also reports the OSC 8 target as words: a strip that dropped the opener and kept the
 * body would pass the byte check and still print a URL the tool never showed. Off for a producer
 * that spells the bytes out (`JSON.stringify` of an argument), where the words are the text.
 */
function residue(rows: readonly string[], payload = true): string[] {
	const found: string[] = [];
	for (const row of rows) {
		const bare = row.replace(HOST_HYPERLINK, "").replace(SGR, "");
		for (const match of bare.matchAll(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g)) found.push(JSON.stringify(match[0]));
		if (payload && bare.includes("http://evil")) found.push("OSC payload http://evil");
		if (bare.includes("\t")) found.push("tab");
		if (bare.includes(HOME)) found.push("home directory");
	}
	return found;
}

/** The words a reader sees, with the theme's colour and the host's links taken off. */
function plain(rows: readonly string[]): string {
	return rows.join("\n").replace(HOST_HYPERLINK, "").replace(SGR, "");
}

/** The word each hostile field is expected to leave behind once its bytes are stripped. */
const CLEAN_WORDS = "ABCDEF";

const header: StatusRowView = { kind: "statusRow", status: "done", title: "T" };
const hostileLine = (span: Partial<ViewSpan> = {}): ViewSpan[] => [{ text: HOSTILE, ...span }];

/**
 * Every field of every contract interface that carries a string. Typed `Required<>` so a field
 * added to the contract is a build error here until this inventory names it, and read at run time
 * so the classification below is checked against the fields that exist rather than a list.
 */
const FULL_SPAN: Required<ViewSpan> = {
	text: "t",
	tone: "text",
	bold: true,
	italic: true,
	strike: true,
	captured: false,
	symbol: "icon.file",
	status: "done",
	badge: true,
	link: "https://example.com",
	file: "/repo/a.ts",
	fileLine: 1,
	agentId: "agent",
	language: "ts",
	markdown: false,
	trailing: false,
	live: false,
};
const FULL_BADGE: Required<NonNullable<StatusRowView["badge"]>> = { label: "l", tone: "accent" };
const FULL_STATUS_ROW: Required<StatusRowView> = {
	kind: "statusRow",
	status: "done",
	emblem: "icon.file",
	emblemTone: "accent",
	title: "t",
	titleTone: "title",
	description: "d",
	descriptionTone: "text",
	descriptionFits: true,
	descriptionLink: "https://example.com",
	descriptionFile: "/repo/a.ts",
	descriptionFileLine: 1,
	badge: FULL_BADGE,
	meta: [],
	language: "ts",
};
const FULL_NOUN: Required<NonNullable<ViewHiddenCount["noun"]>> = { one: "row", many: "rows" };
const FULL_HIDDEN: Required<ViewHiddenCount> = { count: 1, noun: FULL_NOUN, revealable: true };
const FULL_CODE: Required<ViewCodeLines> = {
	language: "ts",
	firstLineNumber: 1,
	totalLines: 1,
	lineNumbers: [1],
	lead: "$ ",
};
const FULL_DIFF: Required<ViewDiffLines> = { sides: ["added"], lineNumbers: [1], path: "a.ts" };
const FULL_SECTION: Required<ViewSection> = {
	label: "l",
	lines: [],
	separator: true,
	hidden: FULL_HIDDEN,
	tail: {},
	list: false,
	code: FULL_CODE,
	diff: FULL_DIFF,
	tree: { depth: [], opens: [], last: [] },
	markdown: false,
	clip: false,
};
const FULL_NOTICE: Required<NoticeView> = {
	kind: "notice",
	state: "info",
	mark: "icon.file",
	headline: [],
	tag: "t",
	body: [],
};
const FULL_FRAMED: Required<FramedBlockView> = {
	kind: "framedBlock",
	header,
	state: "done",
	sections: [],
	contents: "report",
	gutter: false,
};
const FULL_HEADED: Required<HeadedBlockView> = {
	kind: "headedBlock",
	header,
	lines: [],
	hidden: FULL_HIDDEN,
	tail: {},
};
const FULL_TEXT_BLOCK: Required<TextBlockView> = { kind: "textBlock", spans: [] };

const INVENTORY: Record<string, Record<string, unknown>> = {
	ViewSpan: FULL_SPAN,
	"StatusRowView.badge": FULL_BADGE,
	StatusRowView: FULL_STATUS_ROW,
	"ViewHiddenCount.noun": FULL_NOUN,
	ViewHiddenCount: FULL_HIDDEN,
	ViewCodeLines: FULL_CODE,
	ViewDiffLines: FULL_DIFF,
	ViewSection: FULL_SECTION,
	NoticeView: FULL_NOTICE,
	FramedBlockView: FULL_FRAMED,
	HeadedBlockView: FULL_HEADED,
	TextBlockView: FULL_TEXT_BLOCK,
};

/** Every string field, as `Interface.field`, read off the inventory. */
const STRING_FIELDS = Object.entries(INVENTORY)
	.flatMap(([owner, full]) =>
		Object.entries(full).flatMap(([key, value]) => (typeof value === "string" ? [`${owner}.${key}`] : [])),
	)
	.sort();

/**
 * The string fields that are the tool's WORDS, which the host draws and so must strip.
 * Every other string field is a vocabulary the host resolves -- a tone, a status, a glyph key, a
 * language name, a discriminant -- or a target it validates before use -- a URL, a path. Both lists
 * are pinned by exact equality below, so a new string field is a decision recorded here.
 */
const TEXT_FIELDS = [
	"NoticeView.tag",
	"StatusRowView.badge.label",
	"StatusRowView.description",
	"StatusRowView.title",
	"ViewCodeLines.lead",
	"ViewHiddenCount.noun.many",
	"ViewHiddenCount.noun.one",
	"ViewSection.label",
	"ViewSpan.text",
].sort();
const VOCABULARY_FIELDS = [
	"FramedBlockView.contents",
	"FramedBlockView.kind",
	"FramedBlockView.state",
	"HeadedBlockView.kind",
	"NoticeView.kind",
	"NoticeView.mark",
	"NoticeView.state",
	"StatusRowView.badge.tone",
	"StatusRowView.descriptionFile",
	"StatusRowView.descriptionLink",
	"StatusRowView.descriptionTone",
	"StatusRowView.emblem",
	"StatusRowView.emblemTone",
	"StatusRowView.kind",
	"StatusRowView.language",
	"StatusRowView.status",
	"StatusRowView.titleTone",
	"TextBlockView.kind",
	"ViewCodeLines.language",
	"ViewDiffLines.path",
	"ViewSpan.agentId",
	"ViewSpan.file",
	"ViewSpan.language",
	"ViewSpan.link",
	"ViewSpan.status",
	"ViewSpan.symbol",
	"ViewSpan.tone",
].sort();

/** One view with the hostile string in one text field, on one of the paths the terminal draws it. */
interface Variant {
	/** The `Interface.field` the hostile string sits in. */
	field: string;
	view: ToolView;
	/** The words that must survive once the bytes are gone, when the path keeps them whole. */
	expectWords?: boolean;
}

/**
 * Every text field on every path, keyed by view kind. Typed over the contract's union, so a new
 * kind fails to build until it has a row here, and checked below against `VIEW_KINDS_DRAWN`.
 */
const VARIANTS: Record<ToolView["kind"], Record<string, Variant>> = {
	statusRow: {
		title: {
			field: "StatusRowView.title",
			view: { kind: "statusRow", status: "done", title: HOSTILE },
			expectWords: true,
		},
		description: { field: "StatusRowView.description", view: { ...header, description: HOSTILE }, expectWords: true },
		"description that must fit": {
			field: "StatusRowView.description",
			view: { ...header, description: `${HOSTILE} ${"x".repeat(WIDTH)}`, descriptionFits: true },
		},
		"badge label": {
			field: "StatusRowView.badge.label",
			view: { ...header, badge: { label: HOSTILE, tone: "success" } },
			expectWords: true,
		},
		"meta span": { field: "ViewSpan.text", view: { ...header, meta: [hostileLine()] }, expectWords: true },
	},
	textBlock: {
		"plain span": { field: "ViewSpan.text", view: { kind: "textBlock", spans: hostileLine() }, expectWords: true },
		"emphasized span": {
			field: "ViewSpan.text",
			view: { kind: "textBlock", spans: hostileLine({ bold: true, italic: true, strike: true, tone: "error" }) },
			expectWords: true,
		},
		"badge span": {
			field: "ViewSpan.text",
			view: { kind: "textBlock", spans: hostileLine({ badge: true }) },
			expectWords: true,
		},
		"markdown span": {
			field: "ViewSpan.text",
			view: { kind: "textBlock", spans: hostileLine({ markdown: true }) },
			expectWords: true,
		},
		"live output span": {
			field: "ViewSpan.text",
			view: { kind: "textBlock", spans: hostileLine({ live: true, tone: "output" }) },
		},
		"live span": { field: "ViewSpan.text", view: { kind: "textBlock", spans: hostileLine({ live: true }) } },
		"linked span": {
			field: "ViewSpan.text",
			view: { kind: "textBlock", spans: hostileLine({ link: "https://example.com" }) },
			expectWords: true,
		},
		"span with an unknown symbol": {
			field: "ViewSpan.text",
			view: { kind: "textBlock", spans: hostileLine({ symbol: "no.such.glyph" }) },
			expectWords: true,
		},
	},
	headedBlock: {
		"header title": {
			field: "StatusRowView.title",
			view: { kind: "headedBlock", header: { ...header, title: HOSTILE }, lines: [] },
			expectWords: true,
		},
		line: {
			field: "ViewSpan.text",
			view: { kind: "headedBlock", header, lines: [hostileLine()] },
			expectWords: true,
		},
		"line with a tail": {
			field: "ViewSpan.text",
			view: { kind: "headedBlock", header, lines: [[{ text: "lead" }, { text: HOSTILE, trailing: true }]] },
			expectWords: true,
		},
		"hidden noun one": {
			field: "ViewHiddenCount.noun.one",
			view: {
				kind: "headedBlock",
				header,
				lines: [],
				hidden: { count: 1, noun: { one: HOSTILE, many: "rows" }, revealable: true },
			},
			expectWords: true,
		},
		"hidden noun many": {
			field: "ViewHiddenCount.noun.many",
			view: {
				kind: "headedBlock",
				header,
				lines: [],
				hidden: { count: 2, noun: { one: "row", many: HOSTILE }, revealable: true },
			},
			expectWords: true,
		},
	},
	framedBlock: {
		"header title": {
			field: "StatusRowView.title",
			view: { kind: "framedBlock", header: { ...header, title: HOSTILE }, sections: [] },
			expectWords: true,
		},
		"section label": {
			field: "ViewSection.label",
			view: { kind: "framedBlock", header, sections: [{ label: HOSTILE, lines: [] }] },
			expectWords: true,
		},
		"prose line": {
			field: "ViewSpan.text",
			view: { kind: "framedBlock", header, sections: [{ lines: [hostileLine()] }] },
			expectWords: true,
		},
		"prose line with a tail": {
			field: "ViewSpan.text",
			view: {
				kind: "framedBlock",
				header,
				sections: [{ lines: [[{ text: "lead" }, { text: HOSTILE, trailing: true }]] }],
			},
			expectWords: true,
		},
		"clipped line": {
			field: "ViewSpan.text",
			view: { kind: "framedBlock", header, sections: [{ lines: [hostileLine()], clip: true }] },
			expectWords: true,
		},
		"windowed line": {
			field: "ViewSpan.text",
			view: { kind: "framedBlock", header, sections: [{ lines: [hostileLine()], tail: {} }] },
			expectWords: true,
		},
		"list item": {
			field: "ViewSpan.text",
			view: { kind: "framedBlock", header, sections: [{ lines: [hostileLine()], list: true }] },
			expectWords: true,
		},
		"list hidden noun": {
			field: "ViewHiddenCount.noun.one",
			view: {
				kind: "framedBlock",
				header,
				sections: [
					{
						lines: [[{ text: "one" }]],
						list: true,
						hidden: { count: 3, noun: { one: HOSTILE, many: HOSTILE }, revealable: true },
					},
				],
			},
			expectWords: true,
		},
		"section hidden noun": {
			field: "ViewHiddenCount.noun.many",
			view: {
				kind: "framedBlock",
				header,
				sections: [
					{
						lines: [[{ text: "one" }]],
						hidden: { count: 3, noun: { one: "row", many: HOSTILE }, revealable: true },
					},
				],
			},
			expectWords: true,
		},
		"code line": {
			field: "ViewSpan.text",
			view: {
				kind: "framedBlock",
				header,
				sections: [{ lines: [hostileLine()], code: { language: "bash", firstLineNumber: 1 } }],
			},
		},
		"code line, unnumbered": {
			field: "ViewSpan.text",
			view: { kind: "framedBlock", header, sections: [{ lines: [hostileLine()], code: {} }] },
		},
		"code lead": {
			field: "ViewCodeLines.lead",
			view: {
				kind: "framedBlock",
				header,
				sections: [{ lines: [[{ text: "ls" }]], code: { language: "bash", lead: HOSTILE } }],
			},
			expectWords: true,
		},
		"markdown source": {
			field: "ViewSpan.text",
			view: { kind: "framedBlock", header, sections: [{ lines: [hostileLine()], markdown: true }] },
			expectWords: true,
		},
		"diff line": {
			field: "ViewSpan.text",
			view: {
				kind: "framedBlock",
				header,
				sections: [{ lines: [hostileLine()], diff: { path: "a.ts", sides: ["added"] } }],
			},
		},
		"diff line, numbered": {
			field: "ViewSpan.text",
			view: {
				kind: "framedBlock",
				header,
				sections: [{ lines: [hostileLine()], diff: { sides: ["removed"], lineNumbers: [4] } }],
			},
		},
		"tree node": {
			field: "ViewSpan.text",
			view: {
				kind: "framedBlock",
				header,
				sections: [
					{
						lines: [[{ text: "root" }], hostileLine()],
						tree: { depth: [0, 1], opens: [true, true], last: [true, true] },
					},
				],
			},
			expectWords: true,
		},
	},
	notice: {
		headline: {
			field: "ViewSpan.text",
			view: { kind: "notice", state: "success", headline: hostileLine({ bold: true }) },
			expectWords: true,
		},
		tag: {
			field: "NoticeView.tag",
			view: { kind: "notice", state: "warning", headline: [{ text: "h" }], tag: HOSTILE },
			expectWords: true,
		},
		body: {
			field: "ViewSpan.text",
			view: { kind: "notice", state: "error", headline: [{ text: "h" }], body: [hostileLine({ italic: true })] },
			expectWords: true,
		},
	},
};

describe("a tool view never carries an escape to the terminal", () => {
	let policy: AnsiPolicy;

	beforeAll(async () => {
		await initTheme();
		policy = getAnsiPolicy();
		setAnsiPolicy("full");
	});

	afterAll(() => {
		setAnsiPolicy(policy);
	});

	it("sweeps every kind the terminal draws", () => {
		expect(Object.keys(VARIANTS).sort()).toEqual(Object.keys(VIEW_KINDS_DRAWN).sort());
	});

	it("classifies every string field of the contract as text or vocabulary", () => {
		expect([...TEXT_FIELDS, ...VOCABULARY_FIELDS].sort()).toEqual(STRING_FIELDS);
		expect(TEXT_FIELDS.filter(field => VOCABULARY_FIELDS.includes(field))).toEqual([]);
	});

	it("feeds the hostile string into every text field", () => {
		const exercised = [
			...new Set(Object.values(VARIANTS).flatMap(byPath => Object.values(byPath).map(variant => variant.field))),
		].sort();
		expect(exercised).toEqual(TEXT_FIELDS);
	});

	for (const [kind, byPath] of Object.entries(VARIANTS)) {
		describe(kind, () => {
			for (const [name, variant] of Object.entries(byPath)) {
				it(`strips ${variant.field} drawn as ${name}`, () => {
					const rows = drawToolView(variant.view, theme, 2).render(WIDTH);
					expect(residue(rows)).toEqual([]);
					if (variant.expectWords) {
						const words = plain(rows);
						expect(words).toContain(CLEAN_WORDS);
						expect(words).toContain("~/secret");
					}
				});
			}
		});
	}

	it("keeps a captured run's own colour and strips the rest of its bytes", () => {
		const views: ToolView[] = [
			{ kind: "framedBlock", header, sections: [{ lines: [[{ text: CAPTURED, captured: true }]] }] },
			{ kind: "headedBlock", header, lines: [[{ text: CAPTURED, captured: true }]] },
			{ kind: "textBlock", spans: [{ text: CAPTURED, captured: true }] },
			// A captured run that is also a badge is replayed, not plated: a badge is the theme's colour
			// around the words, and a run with its own colours inside that would be two answers.
			{ kind: "textBlock", spans: [{ text: CAPTURED, captured: true, badge: true }] },
			{ kind: "notice", state: "info", headline: [{ text: CAPTURED, captured: true }] },
		];
		for (const view of views) {
			const rows = drawToolView(view, theme, 2).render(WIDTH);
			expect(residue(rows)).toEqual([]);
			expect(plain(rows)).toContain("red");
			expect(plain(rows)).toContain("clear link");
		}
		// The colour survives on the paths that replay a program's screen: a block's line and a row.
		expect(drawToolView(views[0]!, theme, 2).render(WIDTH).join("\n")).toContain(CAPTURED_COLOUR);
		expect(drawToolView(views[1]!, theme, 2).render(WIDTH).join("\n")).toContain(CAPTURED_COLOUR);
	});

	it("strips the reason the resolve card was reported with", () => {
		// The backtest: a model-supplied reason carrying a screen clear and a link, drawn as the
		// notice's headline, tag and body.
		const view = resolveToolView.renderResult(
			{
				content: [],
				details: { action: "apply", reason: HOSTILE, label: `${HOSTILE}: ${HOSTILE}` },
				isError: false,
			},
			{ expanded: true, partial: false },
		);
		const rows = drawToolView(view, theme, 2).render(WIDTH);
		expect(residue(rows)).toEqual([]);
		expect(plain(rows)).toContain(CLEAN_WORDS);
	});

	it("strips a hostile argument drawn by the generic JSON card", () => {
		const tree = jsonTreeViewLines(
			{ reason: HOSTILE, [HOSTILE]: "value", multiline: `first\n${HOSTILE}`, nested: { deep: HOSTILE } },
			{ maxDepth: 6, maxLines: 20, maxScalarLen: 400 },
		);
		const rows = drawToolView({ kind: "headedBlock", header, lines: tree.lines }, theme, 2).render(WIDTH);
		expect(residue(rows)).toEqual([]);
		expect(plain(rows)).toContain(CLEAN_WORDS);
	});

	/**
	 * Every producer in the registry, driven with the hostile string in every argument and result
	 * field a card commonly reads, so the sweep is over the tools that exist at run time and not a
	 * list written here. A producer that puts a raw field on a view is caught at the choke point the
	 * variants above pin; this proves the choke point is the one every registered card reaches, and
	 * that the registry reaches every kind the contract declares.
	 */
	describe("every registered tool card", () => {
		const hostileArgs: Record<string, unknown> = {
			[INTENT_FIELD]: HOSTILE,
			command: HOSTILE,
			path: HOSTILE,
			file_path: HOSTILE,
			content: HOSTILE,
			query: HOSTILE,
			pattern: HOSTILE,
			input: HOSTILE,
			reason: HOSTILE,
			message: HOSTILE,
			name: HOSTILE,
			code: HOSTILE,
			url: HOSTILE,
			prompt: HOSTILE,
			description: HOSTILE,
			expression: HOSTILE,
			text: HOSTILE,
			label: HOSTILE,
			cwd: `${HOME}/${HOSTILE}`,
		};
		const hostileResults: Record<
			string,
			{ content: { type: string; text: string }[]; details?: unknown; isError: boolean }
		> = {
			"text result": { content: [{ type: "text", text: HOSTILE }], isError: false },
			"error result": { content: [{ type: "text", text: HOSTILE }], isError: true },
			"result with details": {
				content: [{ type: "text", text: HOSTILE }],
				details: { ...hostileArgs },
				isError: false,
			},
		};
		const contexts = [
			{ expanded: false, partial: false },
			{ expanded: true, partial: true, frame: 3, hasResult: true },
		];
		const kindsProduced = new Set<string>();
		/** `tool: shape` for every result shape a card rejects rather than draws. */
		const rejected: string[] = [];

		for (const [name, definition] of Object.entries(toolViewDefinitions)) {
			it(`${name} draws no escape from a hostile call or result`, () => {
				const views: ToolView[] = [];
				for (const context of contexts) {
					views.push(definition.view.renderCall(hostileArgs as never, context));
					for (const [shape, result] of Object.entries(hostileResults)) {
						try {
							views.push(definition.view.renderResult(result as never, context, hostileArgs as never));
						} catch {
							if (!rejected.includes(`${name}: ${shape}`)) rejected.push(`${name}: ${shape}`);
						}
					}
				}
				for (const view of views) {
					kindsProduced.add(view.kind);
					expect(residue(drawToolView(view, theme, 2).render(WIDTH), false)).toEqual([]);
				}
			});
		}

		it("reaches every kind the contract declares", () => {
			expect([...kindsProduced].sort()).toEqual(Object.keys(VIEW_KINDS_DRAWN).sort());
		});

		// A card whose details are a shape of its own (an array it iterates) throws on the generic
		// details and is driven by the other shapes; the set is pinned so a new card that throws is a
		// decision recorded here rather than a member the sweep skipped.
		it("rejects the generic details on exactly the cards pinned here", () => {
			expect(rejected.sort()).toEqual(["search_tool_bm25: result with details"]);
		});
	});
});
