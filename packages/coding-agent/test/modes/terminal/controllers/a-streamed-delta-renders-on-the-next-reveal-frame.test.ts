/**
 * WHY. With smooth streaming the revealed prefix of an assistant block moves only on a reveal frame,
 * yet every provider delta counted the block's graphemes, sliced it and re-rendered the component.
 * Each of those reads the whole block, so a long reply spent work proportional to its length on
 * every delta and showed nothing new until the next frame anyway.
 *
 * THE CLASS. Every way a streamed target can change between two frames: its text grows, its visible
 * thinking grows, its hidden thinking grows, its text shrinks, and each field the transcript
 * projection puts on the view changes. For each, any number of changes between two frames renders
 * nothing until the frame, the frame renders the newest target once, a frame requests a paint only
 * when it revealed more, and the frame timer stops once the reveal has caught up. A projected field
 * the fixture does not change fails the suite. A tool call and unsmoothed streaming still render at
 * once. The grapheme counter's slice reuses the prefix check its count made; every count-then-slice
 * sequence over a set of texts with merging clusters answers as a fresh segmentation would.
 *
 * WHAT THIS SUITE DOES NOT CATCH. It does not measure CPU. It drives the reveal controller, through
 * which every message_update reaches the streaming block, and not the event controller's own work
 * per delta. A slice that re-checks a prefix the count already proved is slower, not wrong, so it
 * passes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/assistant-message";
import {
	BlockUnitCounter,
	STREAMING_REVEAL_FRAME_MS,
	StreamingRevealController,
} from "@veyyon/coding-agent/modes/terminal/controllers/streaming-reveal";
import { toAssistantMessageView } from "@veyyon/coding-agent/presentation/transcript-builder";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { getSegmenter } from "@veyyon/utils/width";
import type { AssistantMessageView, AssistantSegment } from "@veyyon/wire/presentation";

/** Enough frames to reveal any target in this file. */
const CATCH_UP_FRAMES = 60;

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

function view(segments: AssistantSegment[], base: Omit<AssistantMessageView, "segments"> = {}): AssistantMessageView {
	return { ...base, segments };
}

function text(value: string): AssistantSegment {
	return { kind: "text", text: value };
}

function thinking(value: string): AssistantSegment {
	return { kind: "thinking", text: value, redacted: false };
}

function harness(options: { smooth?: boolean; hideThinking?: boolean } = {}) {
	const component = new AssistantMessageComponent();
	const updates = vi.spyOn(component, "updateContent");
	const requestRender = vi.fn();
	const controller = new StreamingRevealController({
		getSmoothStreaming: () => options.smooth ?? true,
		getHideThinkingBlock: () => options.hideThinking ?? false,
		getProseOnlyThinking: () => true,
		requestRender,
	});
	component.setHideThinkingBlock(options.hideThinking ?? false);
	const rendered = (): AssistantMessageView => {
		const last = updates.mock.calls.at(-1);
		if (!last) throw new Error("the component was never rendered");
		return last[0];
	};
	const frames = (count: number): void => {
		for (let i = 0; i < count; i++) vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
	};
	return { component, controller, updates, requestRender, rendered, frames };
}

function segmentText(message: AssistantMessageView, index: number): string {
	const segment = message.segments[index];
	if (segment === undefined || !("text" in segment)) throw new Error(`segment ${index} has no text`);
	return segment.text;
}

function assistantMessage(fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Hello" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
		},
		timestamp: 1,
		...fields,
	};
}

/** The transcript projection of one streamed message, and of the same message with every field changed. */
const BEFORE = toAssistantMessageView(assistantMessage({ responseId: "resp_1" }));
const AFTER = toAssistantMessageView(
	assistantMessage({
		provider: "openai",
		model: "gpt-5",
		stopReason: "error",
		errorMessage: "Provider failed",
		responseId: "resp_2",
		timestamp: 2,
		usage: {
			input: 11,
			output: 21,
			cacheRead: 1,
			cacheWrite: 1,
			totalTokens: 34,
			reasoningTokens: 7,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.7 },
		},
	}),
);
const PROJECTED_FIELDS = (Object.keys({ ...BEFORE, ...AFTER }) as (keyof AssistantMessageView)[]).filter(
	key => key !== "segments",
);

interface Change {
	name: string;
	hideThinking?: boolean;
	first: AssistantMessageView;
	/** Targets set between two frames; the last one is the newest. */
	between: AssistantMessageView[];
	reveals: boolean;
	/** What the frame after `between` renders. */
	expectFrame(rendered: AssistantMessageView, newest: AssistantMessageView): void;
}

const CHANGES: Change[] = [
	{
		name: "the text grows",
		first: view([text("Hello")]),
		between: [view([text("Hello wo")]), view([text("Hello world, and more")])],
		reveals: true,
		expectFrame(rendered, newest) {
			const shown = segmentText(rendered, 0);
			expect(shown.length).toBeGreaterThan("Hello".length);
			expect(segmentText(newest, 0).startsWith(shown)).toBe(true);
		},
	},
	{
		name: "visible thinking grows",
		first: view([thinking("Plan the change")]),
		between: [view([thinking("Plan the change and")]), view([thinking("Plan the change and test it")])],
		reveals: true,
		expectFrame(rendered, newest) {
			const shown = segmentText(rendered, 0);
			expect(shown.length).toBeGreaterThan("Plan the change".length);
			expect(segmentText(newest, 0).startsWith(shown)).toBe(true);
		},
	},
	{
		name: "hidden thinking grows",
		hideThinking: true,
		first: view([thinking("Plan"), text("Answer")]),
		between: [view([thinking("Plan more"), text("Answer")]), view([thinking("Plan more still"), text("Answer")])],
		reveals: false,
		expectFrame(rendered, newest) {
			expect(segmentText(rendered, 0)).toBe(segmentText(newest, 0));
			expect(segmentText(rendered, 1)).toBe("Answer");
		},
	},
	{
		name: "the text shrinks",
		first: view([text("Hello world")]),
		between: [view([text("Hello wor")]), view([text("Hello")])],
		reveals: false,
		expectFrame(rendered) {
			expect(segmentText(rendered, 0)).toBe("Hello");
		},
	},
	...PROJECTED_FIELDS.map(
		(field): Change => ({
			name: `the projected ${field} changes`,
			first: { ...BEFORE, segments: [text("Hello")] },
			between: [{ ...BEFORE, [field]: AFTER[field], segments: [text("Hello")] }],
			reveals: false,
			expectFrame(rendered) {
				expect(rendered[field]).toEqual(AFTER[field]);
			},
		}),
	),
];

describe("a streamed delta renders on the next reveal frame", () => {
	it("changes every field the transcript projection sets", () => {
		const unchanged = PROJECTED_FIELDS.filter(field => Bun.deepEquals(BEFORE[field], AFTER[field]));
		expect(unchanged).toEqual([]);
		expect(PROJECTED_FIELDS.length).toBeGreaterThan(0);
	});

	for (const change of CHANGES) {
		it(`renders nothing between frames and the newest target on the frame when ${change.name}`, () => {
			const { component, controller, updates, requestRender, rendered, frames } = harness({
				hideThinking: change.hideThinking,
			});
			controller.begin(component, view([text("")]));
			controller.setTarget(change.first);
			frames(CATCH_UP_FRAMES);
			const settledUpdates = updates.mock.calls.length;
			requestRender.mockClear();

			for (const target of change.between) controller.setTarget(target);
			expect(updates.mock.calls.length).toBe(settledUpdates);

			frames(1);
			expect(updates.mock.calls.length).toBe(settledUpdates + 1);
			const newest = change.between.at(-1)!;
			change.expectFrame(rendered(), newest);
			expect(requestRender.mock.calls.length).toBe(change.reveals ? 1 : 0);

			// The reveal catches up to the newest target and then the frame timer stops.
			frames(CATCH_UP_FRAMES);
			for (let i = 0; i < newest.segments.length; i++) {
				const shown = rendered().segments[i];
				const target = newest.segments[i];
				expect(shown !== undefined && "text" in shown ? shown.text : undefined).toBe(
					target !== undefined && "text" in target ? target.text : undefined,
				);
			}
			const caughtUp = updates.mock.calls.length;
			frames(CATCH_UP_FRAMES);
			expect(updates.mock.calls.length).toBe(caughtUp);
			expect(vi.getTimerCount()).toBe(0);
		});
	}

	it("resumes the reveal from the end of a target that shrank", () => {
		const { component, controller, rendered, frames } = harness();
		controller.begin(component, view([text("")]));
		controller.setTarget(view([text("Hello world")]));
		frames(CATCH_UP_FRAMES);
		controller.setTarget(view([text("Hello")]));
		frames(1);
		// As long as the text it shrank from: a reveal that kept its old position would show all of it.
		controller.setTarget(view([text("Hello there")]));
		frames(1);
		const shown = segmentText(rendered(), 0);
		expect(shown.startsWith("Hello")).toBe(true);
		expect(shown.length).toBeGreaterThan("Hello".length);
		expect(shown.length).toBeLessThan("Hello there".length);
	});

	it("renders a tool call's leading text in full at once", () => {
		const { component, controller, updates, rendered } = harness();
		controller.begin(component, view([text("")]));
		const before = updates.mock.calls.length;
		controller.setTarget(
			view([
				text("Reading the file now"),
				{ kind: "tool-call", toolCallId: "call-1", toolName: "read", input: "{}" },
			]),
		);
		expect(updates.mock.calls.length).toBe(before + 1);
		expect(segmentText(rendered(), 0)).toBe("Reading the file now");
	});

	it("renders every target at once when smoothing is off", () => {
		const { component, controller, updates, rendered } = harness({ smooth: false });
		controller.begin(component, view([text("")]));
		const before = updates.mock.calls.length;
		controller.setTarget(view([text("Hello")]));
		controller.setTarget(view([text("Hello world")]));
		expect(updates.mock.calls.length).toBe(before + 2);
		expect(segmentText(rendered(), 0)).toBe("Hello world");
	});
});

/** Grapheme count and prefix of `value` by a fresh segmentation, independent of the counter. */
function reference(value: string, units: number): { count: number; slice: string } {
	let count = 0;
	let slice = units <= 0 ? "" : value;
	for (const { index, segment } of getSegmenter().segment(value)) {
		count += 1;
		if (count === units) slice = value.slice(0, index + segment.length);
	}
	return { count, slice };
}

describe("a slice after a count answers as a fresh segmentation would", () => {
	// Extensions of one another, appends that merge into the previous final cluster, and unrelated texts.
	const TEXTS = [
		"",
		"abc",
		"abcd",
		"Zbcd",
		"ab👨",
		"ab👨\u200D👩x",
		"a",
		"a\u0301b",
		"👨\u200D👩xyz",
		"café 👨‍👩‍👧‍👦 naïve",
	];

	it("for every text counted, sliced, then another counted and a third sliced", () => {
		const mismatches: string[] = [];
		for (const first of TEXTS) {
			const firstCount = reference(first, 0).count;
			for (const counted of TEXTS) {
				for (const sliced of TEXTS) {
					const slicedCount = reference(sliced, 0).count;
					for (let firstUnits = 0; firstUnits <= firstCount; firstUnits++) {
						for (let units = 0; units <= slicedCount + 1; units++) {
							const counter = new BlockUnitCounter();
							counter.count(0, first);
							counter.slice(0, first, firstUnits);
							const total = counter.count(0, counted);
							const slice = counter.slice(0, sliced, units);
							const expected = reference(sliced, units).slice;
							if (total !== reference(counted, 0).count || slice !== expected) {
								mismatches.push(
									JSON.stringify({ first, firstUnits, counted, sliced, units, total, slice, expected }),
								);
							}
						}
					}
				}
			}
		}
		expect(mismatches).toEqual([]);
	});
});
