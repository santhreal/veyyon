import { describe, expect, it, vi } from "bun:test";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";

/**
 * `showModalSelector` must close the overlay exactly once when a component's
 * selection or cancel callback (`done`) fires, and must still close when a
 * component calls `done` synchronously during construction (before the overlay
 * handle exists). These pin the re-entrant guard, not that a list rendered.
 */
function makeController() {
	const hide = vi.fn();
	const overlayHandle = { hide };
	const setFocus = vi.fn();
	const requestRender = vi.fn();
	const showOverlay = vi.fn(() => overlayHandle);
	const ctx = {
		ui: { showOverlay, setFocus, requestRender },
		editorContainer: { children: [{}], clear: vi.fn(), addChild: vi.fn() },
		editor: {},
	};
	const controller = new SelectorController(ctx as unknown as InteractiveModeContext);
	return { controller, hide, setFocus, showOverlay };
}

const dummyPanel = () => ({ component: {} as never, focus: {} as never });

describe("showModalSelector overlay close", () => {
	it("hides the overlay once when the selection callback fires", () => {
		const { controller, hide, setFocus } = makeController();
		let done: () => void = () => {};

		controller.showModalSelector(d => {
			done = d;
			return dummyPanel();
		});
		setFocus.mockClear();

		done();

		expect(hide).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalledTimes(1);
	});

	it("hides exactly once even when done is called twice (select then cancel race)", () => {
		const { controller, hide } = makeController();
		let done: () => void = () => {};

		controller.showModalSelector(d => {
			done = d;
			return dummyPanel();
		});

		done();
		done();

		expect(hide).toHaveBeenCalledTimes(1);
	});

	it("still hides when a component calls done synchronously during create", () => {
		const { controller, hide } = makeController();

		controller.showModalSelector(done => {
			// Fire before showOverlay has returned a handle. The old code
			// no-op'd the hide here and stranded the overlay open.
			done();
			return dummyPanel();
		});

		expect(hide).toHaveBeenCalledTimes(1);
	});
});
