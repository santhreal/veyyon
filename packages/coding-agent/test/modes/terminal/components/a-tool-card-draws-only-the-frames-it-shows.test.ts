/**
 * A tool card draws its display at render, once, in the state that render shows.
 *
 * WHAT THIS CLOSES. The card drew its display on every change. A rebuilt transcript constructs a
 * card from the call, expands it, hands it the result and seals it, and each of those drew the card
 * again before any frame showed it. The construction drew the call view, which for a `write` is the
 * whole file highlighted, and the result view replaced it a moment later: on a 4,712-block session
 * rebuilding and drawing the transcript took 999 ms that way and takes 603 ms drawn at render. A
 * streaming call drew once per argument delta, not once per frame.
 *
 * THE CLASS. Any mutator of the card that draws eagerly. The sweep reads the card's public methods
 * off its prototype at run time and fails on a method nobody has classified, so a new mutator is
 * red until it is driven here. Every mutator is called with no render after it, and nothing may
 * draw; the frame after each visible change must show that change, which catches a mutator that
 * forgot to mark the display stale.
 *
 * WHAT IT DOES NOT CATCH. Components other than `ToolExecutionComponent` (the read group, assistant
 * messages, custom message renderers) are not swept. `setArgsComplete`, `seal`, `setShowImages` and
 * `invalidate` change nothing a `write` card shows, so for those only the no-draw half is asserted,
 * and `setArgsComplete` and `invalidate` leave the card's display inputs unchanged, so an eager draw
 * in either one stays green here.
 */
import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@veyyon/coding-agent/modes/terminal/components/transcript/chat-transcript-builder";
import { ToolExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";
import * as drawToolViewModule from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import * as highlightModule from "@veyyon/coding-agent/theme/highlight";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { SessionMessageEntry } from "@veyyon/kernel/session/session-entries";
import type { TUI } from "@veyyon/tui";
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
		apply: card => card.updateResult({ content: [{ type: "text", text: "written" }] }, false, CALL_ID),
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
};

/** Public methods that read the card or end its life, and never change what it draws. */
const NOT_MUTATIONS = [
	"canBeDisplacedBy",
	"constructor",
	"dispose",
	"getNativeScrollbackLiveRegionStart",
	"getTranscriptBlockVersion",
	"highlightRequests",
	"isDisplaceableBlock",
	"isTranscriptBlockFinalized",
	"render",
	"stopAnimation",
	"whenPreviewSettled",
];

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

/**
 * A settled `write` turn as a session records it. Its text is its own: the code section keeps the
 * last source it drew, and a text another case already drew would never reach the highlighter.
 */
function settledWriteTurn(): SessionMessageEntry[] {
	const args = { path: "notes/rebuilt.md", content: fileText(FILE_LINES, "rebuilt") };
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
			content: [{ type: "toolCall", id: CALL_ID, name: "write", arguments: args }],
			stopReason: "toolUse",
			timestamp: 2,
		}),
		entry({
			role: "toolResult",
			toolCallId: CALL_ID,
			toolName: "write",
			content: [{ type: "text", text: "wrote notes/rebuilt.md" }],
			isError: false,
			timestamp: 3,
		}),
	];
}

describe("a tool card draws only the frames it shows", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("classifies every public method of the card", () => {
		const methods = Object.getOwnPropertyNames(ToolExecutionComponent.prototype).sort();
		expect(methods).toEqual([...Object.keys(MUTATIONS), ...NOT_MUTATIONS].sort());
	});

	for (const [name, mutation] of Object.entries(MUTATIONS)) {
		it(`${name} draws nothing until the next render, which shows it`, () => {
			const card = writeCard();
			plain(card);
			const draws = spyOn(drawToolViewModule, "drawToolView");
			mutation.apply(card);
			mutation.apply(card);
			expect(draws).not.toHaveBeenCalled();
			const frame = plain(card);
			if (mutation.shows) expect(mutation.shows(frame)).toBe(true);
		});
	}

	it("draws nothing for a render that follows no change", () => {
		const card = writeCard();
		card.updateResult({ content: [{ type: "text", text: "written" }] }, false, CALL_ID);
		const first = plain(card);
		const draws = spyOn(drawToolViewModule, "drawToolView");
		expect(plain(card)).toBe(first);
		expect(draws).not.toHaveBeenCalled();
	});

	it("draws a card built and settled before its first frame once, in its settled state", () => {
		const draws = spyOn(drawToolViewModule, "drawToolView");
		const card = writeCard();
		card.setExpanded(false);
		card.updateResult({ content: [{ type: "text", text: "written" }] }, false, CALL_ID);
		card.seal();
		expect(draws).not.toHaveBeenCalled();
		const frame = plain(card);
		expect(draws).toHaveBeenCalledTimes(1);
		expect(frame).toMatch(/draft line 1$/m);
		expect(frame).not.toContain(`draft line ${FILE_LINES}`);
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
			builder.rebuild(settledWriteTurn());
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
