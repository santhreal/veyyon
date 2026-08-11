/**
 * A `todo` call the provider stream killed before it ran is not a todo failure.
 *
 * WHAT THIS CLOSES. A reported turn died mid tool-batch and the operator got
 * three identical lines: `Warning: Todo update failed: Tool call was not
 * executed because the provider stream ended with an error before the tool
 * could run`. One per `todo` call in the dead batch. Nothing had failed and
 * nothing was stale: the calls never happened, which the error card and the
 * batch ledger each say once already. Three copies of a non-event buried the
 * one message that named the real cause.
 *
 * `toolResultNeverRan` in `@veyyon/agent-core` is the single rule for "nothing
 * happened", and every operator-facing failure message has to consult it. The
 * rule accepts two placeholder shapes and rejects a third on purpose, so the
 * rows cover all three: a synthetic result the loop never dispatched, a skipped
 * result an interrupt cut the batch short of, and a skipped result the
 * interrupt caught mid-flight (`entered: true`), whose side effects are real
 * and partial and which therefore still warns.
 *
 * WHAT IT DOES NOT CATCH. Whether the batch ledger and error card are
 * themselves rendered; those are their own rows. This is only about the one
 * warning line that used to repeat.
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "bun:test";
import { toolResultNeverRan } from "@veyyon/agent-core";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { EventController } from "@veyyon/coding-agent/modes/controllers/event-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";

/** The text the placeholder actually carries, and the text that reached the operator. */
const NEVER_RAN_TEXT =
	"Tool call was not executed because the provider stream ended with an error before the tool could run: stream error: NGHTTP2_INTERNAL_ERROR";

/** What the agent loop writes for a call it never dispatched. */
const SYNTHETIC_NEVER_RAN = {
	__synthetic: true,
	source: "assistant_stop_error",
	executed: false,
	upstreamError: "stream error: NGHTTP2_INTERNAL_ERROR",
	batchLedger: { calls: [] },
};
/** What an interrupt writes for a call it cut the batch short of. */
const SKIPPED_NEVER_ENTERED = { __skipped: true, entered: false };
/** The shape that is NOT "nothing happened": the tool was running when the interrupt landed. */
const SKIPPED_AFTER_ENTERING = { __skipped: true, entered: true };

function createContext() {
	const showWarning = vi.fn();
	const setTodos = vi.fn();
	const session = { getToolByName: () => undefined, isAborting: false, isStreaming: false };
	const ctx = {
		isInitialized: true,
		settings: { get: () => false },
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		pendingTools: new Map<string, unknown>(),
		settledToolCalls: new Set<string>(),
		hideThinkingBlock: false,
		setWorkingMessage: vi.fn(),
		clearPinnedError: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
		ui: { requestRender: vi.fn() },
		session,
		viewSession: session,
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
		showWarning,
		setTodos,
	} as unknown as InteractiveModeContext;
	return { ctx, showWarning, setTodos };
}

function todoEnd(
	toolCallId: string,
	options: { isError: boolean; text: string; details?: unknown },
): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "todo",
		result: {
			content: [{ type: "text", text: options.text }],
			...(options.details === undefined ? {} : { details: options.details }),
		},
		isError: options.isError,
	} as unknown as AgentSessionEvent;
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

it("stays silent for every todo call a dead batch never ran", async () => {
	// The premise, from the one rule that owns it: both fixtures ARE placeholders.
	// Without this the row could pass because the details were unrecognizable.
	expect(toolResultNeverRan(SYNTHETIC_NEVER_RAN)).toBe(true);
	expect(toolResultNeverRan(SKIPPED_NEVER_ENTERED)).toBe(true);

	const { ctx, showWarning } = createContext();
	const controller = new EventController(ctx);

	// The reported turn: three `todo` calls in one killed batch.
	await controller.handleEvent(
		todoEnd("call-1", { isError: true, text: NEVER_RAN_TEXT, details: SYNTHETIC_NEVER_RAN }),
	);
	await controller.handleEvent(
		todoEnd("call-2", { isError: true, text: NEVER_RAN_TEXT, details: SYNTHETIC_NEVER_RAN }),
	);
	await controller.handleEvent(
		todoEnd("call-3", { isError: true, text: NEVER_RAN_TEXT, details: SKIPPED_NEVER_ENTERED }),
	);

	expect(showWarning).not.toHaveBeenCalled();
});

it("still warns when a todo call actually failed", async () => {
	// The positive control. Suppressing the placeholder must not suppress the
	// message this warning exists for.
	const { ctx, showWarning } = createContext();
	const controller = new EventController(ctx);

	await controller.handleEvent(
		todoEnd("call-1", { isError: true, text: "phase not found", details: { phases: undefined } }),
	);

	expect(showWarning).toHaveBeenCalledTimes(1);
	expect(showWarning.mock.calls[0]?.[0]).toBe("Todo update failed: phase not found");
});

it("still warns when a todo failure carries no details at all", async () => {
	// A result with no details is not evidence that nothing happened, so it takes
	// the warning path and falls back to the stale-progress wording.
	const { ctx, showWarning } = createContext();
	const controller = new EventController(ctx);

	await controller.handleEvent(todoEnd("call-1", { isError: true, text: "" }));

	expect(showWarning).toHaveBeenCalledTimes(1);
	expect(showWarning.mock.calls[0]?.[0]).toBe("Todo update failed. Progress may be stale until todo succeeds.");
});

it("still warns for a todo the interrupt caught mid-flight", async () => {
	// `entered: true` is the shape the rule deliberately rejects: the tool was
	// running, so its side effects are real and partial and the operator's todo
	// list may genuinely be stale.
	expect(toolResultNeverRan(SKIPPED_AFTER_ENTERING)).toBe(false);

	const { ctx, showWarning } = createContext();
	const controller = new EventController(ctx);

	await controller.handleEvent(
		todoEnd("call-1", { isError: true, text: "interrupted", details: SKIPPED_AFTER_ENTERING }),
	);

	expect(showWarning).toHaveBeenCalledTimes(1);
	expect(showWarning.mock.calls[0]?.[0]).toBe("Todo update failed: interrupted");
});

it("keeps applying a successful todo update", async () => {
	// The success branch shares the `else if` chain with the guard, so it is
	// asserted here too: a restructure that swallowed it would otherwise be
	// invisible.
	const { ctx, showWarning, setTodos } = createContext();
	const controller = new EventController(ctx);
	const phases = [{ phase: "Implementation", items: [] }];

	await controller.handleEvent(todoEnd("call-1", { isError: false, text: "ok", details: { phases } }));

	expect(setTodos).toHaveBeenCalledTimes(1);
	expect(setTodos.mock.calls[0]?.[0]).toEqual(phases);
	expect(showWarning).not.toHaveBeenCalled();
});
