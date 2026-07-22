import { describe, expect, it, vi } from "bun:test";
import { InputController } from "@veyyon/coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";

describe("InputController tool output expansion", () => {
	it("expands children and forces a full display reset to bypass frozen snapshots", () => {
		const expandable = { setExpanded: vi.fn() };
		const inert = { render: vi.fn(() => []) };
		const requestRender = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			toolOutputExpanded: false,
			chatContainer: { children: [expandable, inert] },
			ui: { requestRender, resetDisplay },
			// Required members of the context. Omitting them used to be tolerated by
			// `?.()` calls in the controller, which meant production silently skipped
			// the composer refresh and the welcome dismissal whenever either was
			// missing. The calls are unconditional now, so the stub supplies them.
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(true);
		expect(expandable.setExpanded).toHaveBeenCalledWith(true);
		// resetDisplay() is the only path that retires the transcript's frozen
		// block snapshots and re-emits the whole transcript at its new heights.
		// A plain requestRender would replay the stale (collapsed) snapshots.
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(requestRender).not.toHaveBeenCalled();
	});
});
