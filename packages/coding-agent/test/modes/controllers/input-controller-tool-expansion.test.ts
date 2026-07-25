import { describe, expect, it, vi } from "bun:test";
import { InputController } from "@veyyon/coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";

/** The controller stub, plus handles on the mocks a test wants to assert against. */
function makeContext(toolOutputExpanded = false) {
	const expandable = { setExpanded: vi.fn() };
	const inert = { render: vi.fn(() => []) };
	const requestRender = vi.fn();
	const resetDisplay = vi.fn();
	const set = vi.fn();
	const ctx = {
		toolOutputExpanded,
		chatContainer: { children: [expandable, inert] },
		ui: { requestRender, resetDisplay },
		settings: { set },
		// Required members of the context. Omitting them used to be tolerated by
		// `?.()` calls in the controller, which meant production silently skipped
		// the composer refresh and the welcome dismissal whenever either was
		// missing. The calls are unconditional now, so the stub supplies them.
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, expandable, requestRender, resetDisplay, set };
}

describe("InputController tool output expansion", () => {
	it("expands children and forces a full display reset to bypass frozen snapshots", () => {
		const { ctx, expandable, requestRender, resetDisplay } = makeContext();

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(true);
		expect(expandable.setExpanded).toHaveBeenCalledWith(true);
		// resetDisplay() is the only path that retires the transcript's frozen
		// block snapshots and re-emits the whole transcript at its new heights.
		// A plain requestRender would replay the stale (collapsed) snapshots.
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(requestRender).not.toHaveBeenCalled();
	});

	/**
	 * The toggle writes the preference, so the next session opens the way this one
	 * was left. Without it the choice lived only in memory: someone who wanted to
	 * read tool input and output in full had to press the key again every single
	 * session, and nothing on screen explained why it kept reverting.
	 */
	it("persists the new state so a later session starts the same way", () => {
		const { ctx, set } = makeContext();

		new InputController(ctx).toggleToolOutputExpansion();

		expect(set).toHaveBeenCalledWith("display.toolOutputExpanded", true);
	});

	/** Collapsing persists too, or the preference would be a one-way door. */
	it("persists a collapse as well as an expand", () => {
		const { ctx, set } = makeContext(true);

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(false);
		expect(set).toHaveBeenCalledWith("display.toolOutputExpanded", false);
	});
});
