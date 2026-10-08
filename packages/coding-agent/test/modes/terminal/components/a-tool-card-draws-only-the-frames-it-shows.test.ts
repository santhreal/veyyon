/**
 * A tool card draws its display at render, once, in the state that render shows, and builds the
 * block the display draws from only for that render.
 *
 * WHAT THIS CLOSES. The card drew its display on every change. A rebuilt transcript constructs a
 * card from the call, expands it, hands it the result and seals it, and each of those drew the card
 * again before any frame showed it. The construction drew the call view, which for a `write` is the
 * whole file highlighted, and the result view replaced it a moment later: on a 4,712-block session
 * rebuilding and drawing the transcript took 999 ms that way and takes 603 ms drawn at render. A
 * streaming call drew once per argument delta, not once per frame. A terminal drawing Kitty images
 * converts a result's pictures to PNG, and the card found them by building its block on every result
 * it was handed: a streaming command built every view of its card once per output chunk, for a
 * frame that drew only the last.
 *
 * The block behind the display projected every view it carries, and the card built it on every
 * change and on every question about its state: whether to animate, whether it is finalized,
 * whether the next call displaces it. A rebuilt 3,959-card transcript built 13,210 blocks for the
 * 3,959 its first frame drew.
 *
 * THE CLASS. Any mutator of the card that draws or builds eagerly, under any image protocol the
 * terminal reports, and any state query that builds. Every mutator runs under each protocol of the
 * enum and under none. The sweep reads the card's public methods off its prototype at run time and
 * fails on a method nobody has classified, so a new mutator is red until it is driven here, and a
 * new method that neither changes nor draws the card is red until it is driven as a query. Every
 * mutator and query is called with no render after it, and nothing may draw or project a view; the
 * frame after each visible change must show that change, which catches a mutator that forgot to
 * mark the display stale.
 *
 * WHAT IT DOES NOT CATCH. Components other than `ToolExecutionComponent` (the read group, assistant
 * messages, custom message renderers) are not swept. `setArgsComplete`, `seal`, `setShowImages`,
 * `invalidate` and `toolExecutionChanged` change nothing a `write` card shows, so for those only the
 * no-draw half is asserted, and `setArgsComplete` and `invalidate` leave the card's display inputs
 * unchanged, so an eager draw in either one stays green here. Builds are
 * counted through the views a block projects, so work a build does outside them is counted only
 * alongside them.
 */
import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@veyyon/coding-agent/modes/terminal/components/transcript/chat-transcript-builder";
import { ToolExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";
import * as drawToolViewModule from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { ToolExecutionProducer } from "@veyyon/coding-agent/presentation/tool-execution";
import * as highlightModule from "@veyyon/coding-agent/theme/highlight";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { toolViewDefinitions } from "@veyyon/coding-agent/tools/view-registry";
import type { SessionMessageEntry } from "@veyyon/kernel/session/session-entries";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, type TUI } from "@veyyon/tui";
import type { ToolExecutionBlock } from "@veyyon/wire/presentation";
import { createToolExecution } from "../../../helpers/tool-execution";

const WIDTH = 100;
const CALL_ID = "call-write";
const FILE_LINES = 300;
const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;

function fileText(lines: number, marker: string): string {
	return Array.from({ length: lines }, (_, index) => `${marker} line ${index + 1}`).join("\n");
}

const ARGS = { path: "notes/plan.md", content: fileText(FILE_LINES, "draft") };
const RESULT = { content: [{ type: "text", text: "written" }] };

function plain(card: ToolExecutionComponent): string {
	return card
		.render(WIDTH)
		.map(row => Bun.stripANSI(row).trimEnd())
		.join("\n");
}

function writeCard(): ToolExecutionComponent {
	return createToolExecution("write", ARGS, {}, undefined, ui, process.cwd(), CALL_ID);
}

interface Mutation {
	apply(card: ToolExecutionComponent): void;
	/** What the frame after the mutation shows, or `undefined` when a `write` card shows no change. */
	shows?: (frame: string) => boolean;
}

const settledBlock: ToolExecutionBlock = {
	kind: "tool-execution",
	id: "block-write",
	toolCallId: CALL_ID,
	toolName: "write",
	status: "succeeded",
	input: JSON.stringify({ path: "notes/other.md", content: "replaced body" }),
	output: "wrote notes/other.md",
	timestamp: 0,
};

const MUTATIONS: Record<string, Mutation> = {
	set: {
		apply: card => card.set(settledBlock),
		shows: frame => frame.includes("other.md"),
	},
	updateArgs: {
		apply: card => card.updateArgs({ ...ARGS, content: `${ARGS.content}\nappended tail` }, CALL_ID),
		shows: frame => frame.includes("appended tail"),
	},
	setArgsComplete: {
		apply: card => card.setArgsComplete(CALL_ID),
	},
	updateResult: {
		apply: card => card.updateResult(RESULT, false, CALL_ID),
		// The settled card shows the head of the file, where the streaming one showed its end.
		shows: frame => /draft line 1$/m.test(frame),
	},
	seal: {
		apply: card => card.seal(),
	},
	setExpanded: {
		apply: card => card.setExpanded(true),
		shows: frame => frame.includes("draft line 150"),
	},
	setShowImages: {
		apply: card => card.setShowImages(false),
	},
	invalidate: {
		apply: card => card.invalidate(),
	},
	toolExecutionChanged: {
		apply: card => card.toolExecutionChanged(),
	},
};

/** Public methods that read the card, drop what it drew or end its life, and never change what it draws. */
const NOT_MUTATIONS = [
	"canBeDisplacedBy",
	"constructor",
	"dispose",
	"getNativeScrollbackLiveRegionStart",
	"getTranscriptBlockVersion",
	"highlightRequests",
	"isDisplaceableBlock",
	"isTranscriptBlockFinalized",
	"railState",
	"releaseRenderCache",
	"render",
	"spinnerFrame",
	"stopAnimation",
	"whenPreviewSettled",
];

/** The methods of those that answer a question about the card or end its life, which no frame reads. */
const QUERIES: Record<string, (card: ToolExecutionComponent) => unknown> = {
	canBeDisplacedBy: card => card.canBeDisplacedBy("job"),
	getNativeScrollbackLiveRegionStart: card => card.getNativeScrollbackLiveRegionStart(),
	getTranscriptBlockVersion: card => card.getTranscriptBlockVersion(),
	isDisplaceableBlock: card => card.isDisplaceableBlock(),
	isTranscriptBlockFinalized: card => card.isTranscriptBlockFinalized(),
	releaseRenderCache: card => card.releaseRenderCache(),
	railState: card => card.railState,
	spinnerFrame: card => card.spinnerFrame,
	whenPreviewSettled: card => card.whenPreviewSettled(),
	stopAnimation: card => card.stopAnimation(),
	dispose: card => card.dispose(),
};

let entryCounter = 0;
function entry(message: AgentMessage): SessionMessageEntry {
	entryCounter += 1;
	return {
		type: "message",
		id: `entry-${entryCounter}`,
		parentId: null,
		timestamp: "2026-09-26T00:00:00.000Z",
		message,
	};
}

function writeArgs(marker: string): { path: string; content: string } {
	return { path: `notes/${marker}.md`, content: fileText(FILE_LINES, marker) };
}

/**
 * A settled `write` turn as a session records it. Its text is its own: the code section keeps the
 * last source it drew, and a text another case already drew would never reach the highlighter.
 */
function settledWriteTurn(marker: string): SessionMessageEntry[] {
	const usage = {
		input: 10,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 12,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return [
		entry({ role: "user", content: "write the plan", timestamp: 1 }),
		entry({
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage,
			content: [{ type: "toolCall", id: CALL_ID, name: "write", arguments: writeArgs(marker) }],
			stopReason: "toolUse",
			timestamp: 2,
		}),
		entry({
			role: "toolResult",
			toolCallId: CALL_ID,
			toolName: "write",
			content: [{ type: "text", text: `wrote notes/${marker}.md` }],
			isError: false,
			timestamp: 3,
		}),
	];
}

/** The number of tool views drawn from here on, each drawn as before. */
function countDraws(): { count: number } {
	const drawn = { count: 0 };
	const original = drawToolViewModule.drawToolView;
	spyOn(drawToolViewModule, "drawToolView").mockImplementation((...args) => {
		drawn.count++;
		return original(...args);
	});
	return drawn;
}

/** The number of `write` views a block build projects from here on, each projected as before. */
function countProjections(): { count: number } {
	const projected = { count: 0 };
	const view = toolViewDefinitions.write?.view;
	if (!view) throw new Error("the view registry has no `write` view");
	const { renderCall, renderResult } = view;
	spyOn(view, "renderCall").mockImplementation((args, context) => {
		projected.count++;
		return renderCall.call(view, args, context);
	});
	spyOn(view, "renderResult").mockImplementation((result, context, args) => {
		projected.count++;
		return renderResult.call(view, result, context, args);
	});
	return projected;
}

/** The views one build of a settled `write` card for `args` projects. */
function projectionsOfOneBuild(args: unknown): number {
	const reference = new ToolExecutionProducer({ toolName: "write", args, toolCallId: CALL_ID });
	reference.updateResult(RESULT, false, CALL_ID);
	const projections = countProjections();
	reference.produceBlock({ expanded: false, frozen: false });
	vi.restoreAllMocks();
	return projections.count;
}

/** Every image protocol a terminal can report, and none, since the card does a protocol's own work on a result. */
const PROTOCOLS: readonly (ImageProtocol | null)[] = [null, ...Object.values(ImageProtocol)];

describe("a tool card draws only the frames it shows", () => {
	const originalProtocol = TERMINAL.imageProtocol;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		setTerminalImageProtocol(originalProtocol);
	});

	it("classifies every public method of the card", () => {
		const methods = Object.getOwnPropertyNames(ToolExecutionComponent.prototype).sort();
		expect(methods).toEqual([...Object.keys(MUTATIONS), ...NOT_MUTATIONS].sort());
	});

	it("drives every method that neither changes nor draws the card as a query", () => {
		expect(NOT_MUTATIONS.filter(name => !Object.hasOwn(QUERIES, name))).toEqual([
			"constructor",
			"highlightRequests",
			"render",
		]);
	});

	for (const protocol of PROTOCOLS) {
		for (const [name, mutation] of Object.entries(MUTATIONS)) {
			it(`${name} draws and builds nothing until the next render, which shows it, with image protocol ${protocol}`, () => {
				vi.useFakeTimers();
				setTerminalImageProtocol(protocol);
				const card = writeCard();
				plain(card);
				const draws = countDraws();
				const projections = countProjections();
				mutation.apply(card);
				mutation.apply(card);
				expect({ draws: draws.count, projections: projections.count }).toEqual({ draws: 0, projections: 0 });
				const frame = plain(card);
				if (mutation.shows) expect(mutation.shows(frame)).toBe(true);
			});
		}
	}

	it("answers every question about its state without building its block", async () => {
		vi.useFakeTimers();
		const card = writeCard();
		plain(card);
		const projections = countProjections();
		card.updateResult(RESULT, false, CALL_ID);
		for (const query of Object.values(QUERIES)) await query(card);
		expect(projections.count).toBe(0);
	});

	it("draws nothing for a render that follows no change", () => {
		const card = writeCard();
		card.updateResult(RESULT, false, CALL_ID);
		const first = plain(card);
		const draws = countDraws();
		expect(plain(card)).toBe(first);
		expect(draws.count).toBe(0);
	});

	it("draws a card built and settled before its first frame once, in its settled state", () => {
		const draws = countDraws();
		const card = writeCard();
		card.setExpanded(false);
		card.updateResult(RESULT, false, CALL_ID);
		card.seal();
		expect(draws.count).toBe(0);
		const frame = plain(card);
		expect(draws.count).toBe(1);
		expect(frame).toMatch(/draft line 1$/m);
		expect(frame).not.toContain(`draft line ${FILE_LINES}`);
	});

	it("builds a card handed its call and its result before its first frame once, for that frame", () => {
		vi.useFakeTimers();
		const oneBuild = projectionsOfOneBuild(ARGS);
		const projections = countProjections();
		const card = writeCard();
		card.updateResult(RESULT, false, CALL_ID);
		expect(projections.count).toBe(0);
		plain(card);
		plain(card);
		expect({ oneBuild, projections: projections.count }).toEqual({ oneBuild: 1, projections: 1 });
	});

	it("builds each card of a rebuilt transcript once, for its first frame", () => {
		vi.useFakeTimers();
		const oneBuild = projectionsOfOneBuild(writeArgs("rebuilt-once"));
		const projections = countProjections();
		const builder = new ChatTranscriptBuilder({ ui, cwd: process.cwd(), requestRender: () => {} });
		try {
			builder.rebuild(settledWriteTurn("rebuilt-once"));
			builder.container.render(WIDTH);
			builder.container.render(WIDTH);
			expect({ oneBuild, projections: projections.count }).toEqual({ oneBuild: 1, projections: 1 });
		} finally {
			builder.reset();
		}
	});

	it("never highlights the whole file of a rebuilt write whose result is already recorded", () => {
		const highlighted: number[] = [];
		const original = highlightModule.highlightCode;
		spyOn(highlightModule, "highlightCode").mockImplementation((code, lang, highlightTheme) => {
			highlighted.push(code.split("\n").length);
			return original(code, lang, highlightTheme);
		});
		const builder = new ChatTranscriptBuilder({ ui, cwd: process.cwd(), requestRender: () => {} });
		try {
			builder.rebuild(settledWriteTurn("rebuilt"));
			const frame = builder.container
				.render(WIDTH)
				.map(row => Bun.stripANSI(row))
				.join("\n");
			expect(frame).toMatch(/rebuilt line 1\s*$/m);
			expect(highlighted.length).toBeGreaterThan(0);
			expect(Math.max(...highlighted)).toBeLessThan(FILE_LINES);
		} finally {
			builder.reset();
		}
	});
});
