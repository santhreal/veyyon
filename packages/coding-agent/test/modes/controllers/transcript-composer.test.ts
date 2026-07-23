/**
 * TranscriptComposer unit contract (ARCH-2 transcript-composition slice).
 * The composer owns three shipped-bug invariants, each pinned here:
 * - #3656: a mid-stream rebuild must re-attach the live streaming/tool
 *   components in order and restore the pendingTools routing map;
 * - #2372: a pre-streaming rebuild must replay the optimistic user message,
 *   and must NOT replay once the signature is retired or the submission is
 *   cancelled/custom;
 * - finish-quiesce: a returned prompt() only tears the optimistic echo down
 *   when the stream has fully quiesced, and its local-echo dispose can never
 *   double-run.
 * A source lock keeps interactive-mode delegating instead of re-inlining the
 * state this extraction removed.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	TranscriptComposer,
	type TranscriptComposerPort,
} from "@veyyon/coding-agent/modes/controllers/transcript-composer";
import type { SubmittedUserInput } from "@veyyon/coding-agent/modes/types";
import type { SessionContext } from "@veyyon/coding-agent/session/session-context";
import type { Component } from "@veyyon/tui";

const NUL = "\u0000";

type FakeToolHandle = { id: string } & Component;

function fakeComponent(name: string): Component {
	return { render: () => [name], invalidate: () => {} };
}

function harness(opts?: {
	streaming?: boolean;
	streamingComponent?: Component;
	pendingSubmission?: SubmittedUserInput;
	knownSlashCommands?: string[];
}) {
	const children: Component[] = [];
	const addMessageCalls: Array<{ message: AgentMessage; imageLinks?: readonly (string | undefined)[] }> = [];
	const renderContextCalls: SessionContext[] = [];
	const builtContext = { messages: [] } as unknown as SessionContext;
	const pendingTools = new Map<string, FakeToolHandle>();
	const state = {
		streaming: opts?.streaming ?? false,
		streamingComponent: opts?.streamingComponent,
		pendingSubmission: opts?.pendingSubmission,
	};
	const port: TranscriptComposerPort = {
		chatContainer: {
			get children() {
				return children;
			},
			clear: () => {
				children.length = 0;
			},
			addChild: (c: Component) => {
				children.push(c);
			},
			removeChild: (c: Component) => {
				const i = children.indexOf(c);
				if (i >= 0) children.splice(i, 1);
			},
		} as unknown as TranscriptComposerPort["chatContainer"],
		addMessageToChat: (message, options) => {
			addMessageCalls.push({ message, imageLinks: options?.imageLinks });
			children.push(fakeComponent(`msg:${JSON.stringify("content" in message ? message.content : message)}`));
		},
		renderSessionContext: context => {
			renderContextCalls.push(context);
			// The real renderSessionContext clears pendingTools at start AND end;
			// the composer's restore step must survive that.
			pendingTools.clear();
		},
		buildTranscriptContext: () => builtContext,
		isViewStreaming: () => state.streaming,
		streamingComponent: () => state.streamingComponent,
		pendingTools: pendingTools as unknown as TranscriptComposerPort["pendingTools"],
		isKnownSlashCommand: text => (opts?.knownSlashCommands ?? []).includes(text),
		pendingSubmission: () => state.pendingSubmission,
	};
	return {
		composer: new TranscriptComposer(port),
		children,
		addMessageCalls,
		renderContextCalls,
		builtContext,
		pendingTools,
		state,
	};
}

function submission(text: string, extra?: Partial<SubmittedUserInput>): SubmittedUserInput {
	return { text, cancelled: false, started: false, ...extra } as SubmittedUserInput;
}

describe("TranscriptComposer local echo", () => {
	it("records a NUL-separated (text, imageCount) signature and dispose removes it exactly once", () => {
		const { composer } = harness();
		const dispose = composer.recordLocalSubmission("hello", 2);
		expect(composer.localEchoSignatures.has(`hello${NUL}2`)).toBe(true);
		dispose();
		expect(composer.localEchoSignatures.size).toBe(0);
		// Double-dispose must not delete a signature re-recorded in between.
		composer.recordLocalSubmission("hello", 2);
		dispose();
		expect(composer.localEchoSignatures.has(`hello${NUL}2`)).toBe(true);
	});

	it("does not record known slash commands (they never echo back as user messages)", () => {
		const { composer } = harness({ knownSlashCommands: ["/help"] });
		composer.recordLocalSubmission("/help", 0);
		expect(composer.localEchoSignatures.size).toBe(0);
	});
});

describe("TranscriptComposer optimistic message", () => {
	it("showOptimistic renders the exact user message with imageLinks and sets the signature", () => {
		const { composer, addMessageCalls } = harness();
		composer.showOptimistic(submission("hi there", { imageLinks: ["link-a"] }));
		expect(composer.optimisticSignature).toBe(`hi there${NUL}0`);
		expect(composer.localEchoSignatures.has(`hi there${NUL}0`)).toBe(true);
		expect(addMessageCalls).toHaveLength(1);
		expect(addMessageCalls[0]?.message).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "hi there" }],
			attribution: "user",
		});
		expect(addMessageCalls[0]?.imageLinks).toEqual(["link-a"]);
	});

	it("clearOptimistic retires the signature and the local-echo entry", () => {
		const { composer } = harness();
		composer.showOptimistic(submission("draft"));
		composer.clearOptimistic();
		expect(composer.optimisticSignature).toBeUndefined();
		expect(composer.localEchoSignatures.size).toBe(0);
	});

	it("replaceOptimistic removes exactly the optimistic components before rendering the committed message", () => {
		const { composer, children, addMessageCalls } = harness();
		const preexisting = fakeComponent("earlier");
		children.push(preexisting);
		composer.showOptimistic(submission("raw /cmd text"));
		expect(children).toHaveLength(2);

		composer.replaceOptimistic({
			role: "user",
			content: [{ type: "text", text: "expanded" }],
			attribution: "user",
			timestamp: 1,
		} as AgentMessage);

		// The earlier transcript component survives; the optimistic one is gone
		// and the committed replacement is the only addition.
		expect(children[0]).toBe(preexisting);
		expect(children).toHaveLength(2);
		expect(addMessageCalls).toHaveLength(2);
		expect(composer.optimisticSignature).toBeUndefined();
	});
});

describe("TranscriptComposer onSubmissionFinished (finish-quiesce contract)", () => {
	it("owned + quiesced tears down: signature retired, local echo disposed", () => {
		const { composer } = harness();
		composer.showOptimistic(submission("done"));
		composer.onSubmissionFinished({ owned: true, quiesced: true });
		expect(composer.optimisticSignature).toBeUndefined();
		expect(composer.localEchoSignatures.size).toBe(0);
	});

	it("owned + still streaming keeps the signature (message_start retires it, not the prompt return)", () => {
		const { composer } = harness();
		composer.showOptimistic(submission("streaming on"));
		composer.onSubmissionFinished({ owned: true, quiesced: false });
		expect(composer.optimisticSignature).toBe(`streaming on${NUL}0`);
		// The dispose was detached: a later clearOptimistic cannot double-run it,
		// and the echo signature stays armed for the incoming user event.
		expect(composer.localEchoSignatures.has(`streaming on${NUL}0`)).toBe(true);
	});

	it("not-owned finishes are inert (a superseded submission cannot clobber the current echo)", () => {
		const { composer } = harness();
		composer.showOptimistic(submission("current"));
		composer.onSubmissionFinished({ owned: false, quiesced: true });
		expect(composer.optimisticSignature).toBe(`current${NUL}0`);
		expect(composer.localEchoSignatures.size).toBe(1);
	});
});

describe("TranscriptComposer rebuild", () => {
	it("clears and replays the committed transcript context", () => {
		const { composer, children, renderContextCalls, builtContext } = harness();
		children.push(fakeComponent("stale"));
		composer.rebuild();
		expect(renderContextCalls).toEqual([builtContext]);
		expect(children.some(c => c.render(80)[0] === "stale")).toBe(false);
	});

	it("mid-stream rebuild re-attaches live streaming + tool components in order and restores pendingTools (#3656)", () => {
		const streaming = fakeComponent("streaming");
		const tool = { id: "t1", ...fakeComponent("tool") } as FakeToolHandle;
		const { composer, children, pendingTools } = harness({ streaming: true, streamingComponent: streaming });
		children.push(fakeComponent("history"), streaming, tool);
		pendingTools.set("t1", tool);

		composer.rebuild();

		// renderSessionContext cleared pendingTools; the composer restored the
		// in-flight entry so streamed deltas still route into the SAME component.
		expect(pendingTools.get("t1")).toBe(tool);
		// The live components are back, after the replayed history, in their
		// original relative order.
		expect(children.indexOf(streaming)).toBeGreaterThanOrEqual(0);
		expect(children.indexOf(tool)).toBe(children.indexOf(streaming) + 1);
	});

	it("pre-streaming rebuild replays the optimistic user message (#2372)", () => {
		const { composer, addMessageCalls, state } = harness();
		const pending = submission("hello world");
		state.pendingSubmission = pending;
		composer.showOptimistic(pending);
		composer.rebuild();
		// Initial optimistic add + one replay during rebuild.
		expect(addMessageCalls).toHaveLength(2);
		expect(addMessageCalls[1]?.message).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "hello world" }],
		});
	});

	it("does not replay once the signature is retired, or for cancelled/custom submissions", () => {
		const { composer, addMessageCalls, state } = harness();
		const pending = submission("gone");
		state.pendingSubmission = pending;
		composer.showOptimistic(pending);
		composer.clearOptimistic();
		composer.rebuild();
		expect(addMessageCalls).toHaveLength(1);

		composer.showOptimistic(pending);
		pending.cancelled = true;
		composer.rebuild();
		expect(addMessageCalls).toHaveLength(2);
	});
});

describe("interactive-mode delegation source lock", () => {
	const source = readFileSync(join(import.meta.dir, "../../../src/modes/interactive-mode.ts"), "utf8");

	it("delegates transcript composition and no longer owns the extracted state", () => {
		expect(source).toContain("this.#transcriptComposer.rebuild()");
		expect(source).toContain("this.#transcriptComposer.showOptimistic(");
		expect(source).toContain("this.#transcriptComposer.onSubmissionFinished(");
		// The state this extraction removed must not be re-inlined by a
		// parallel writer; two owners of the optimistic echo is how the
		// double-render/orphaned-dispose class of bug returns.
		expect(source).not.toContain("#pendingSubmissionDispose");
		expect(source).not.toContain("#optimisticUserMessageComponents");
		expect(source).not.toContain("#captureAddedChatComponents");
		expect(source).not.toContain("#replayOptimisticUserMessage");
	});
});
