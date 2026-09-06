/**
 * WHY: a slash command mounts the `Working…` loader on submit and keeps it until
 * its handler returns. A handler that opens a hook UI and waits on the user —
 * the autoswarm setup console, a selector, an input — therefore sat under
 * `Working… · 0:19 ⟦esc⟧` for as long as the user read the dialog, with the
 * clock counting and an `esc` hint that reads as "interrupt the agent".
 *
 * The class closed here: presenting any hook UI on an idle session rests the
 * working loader, and presenting one mid-turn leaves it alone, because a tool
 * asking a question is still a turn in flight. The surfaces are enumerated from
 * the controller's prototype at run time and pinned by exact equality, so a new
 * `showHook*` presenter turns this red until it is added to the sweep.
 *
 * Not caught here: what the loader shows once the dialog closes and the handler
 * goes on to start a turn (the event controller remounts it on the first
 * streaming event, which its own suites own), and the collab-aware wrappers,
 * which delegate to the presenters swept here.
 */

import { describe, expect, it } from "bun:test";
import { ExtensionUiController } from "@veyyon/coding-agent/modes/terminal/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { useTruecolorTheme } from "./helpers/theme-assertions";

useTruecolorTheme("dark");

interface Host {
	ctx: InteractiveModeContext;
	/** Whether the `Working…` loader is still mounted; the presenter under test rests it or not. */
	loader: { mounted: boolean };
}

function host(isStreaming: boolean): Host {
	const loader = { mounted: true };
	const clearWorkingLoader = (): boolean => {
		const wasMounted = loader.mounted;
		loader.mounted = false;
		return wasMounted;
	};
	const editor = { id: "core-editor", getText: () => "", setText: () => {} };
	const overlays: unknown[] = [];
	const ui = {
		requestRender: () => {},
		setFocus: () => {},
		showOverlay: (component: unknown) => {
			overlays.push(component);
			return {
				hide: () => {
					const at = overlays.indexOf(component);
					if (at >= 0) overlays.splice(at, 1);
				},
				setHidden: () => {},
			};
		},
		terminal: { columns: 120, rows: 40 },
	};
	const ctx = {
		editor,
		editorContainer: { children: [] as unknown[], clear() {}, addChild() {} },
		ui,
		hookEditor: undefined,
		hookInput: undefined,
		hookSelector: undefined,
		session: { isStreaming },
		clearWorkingLoader,
		focusActiveEditorArea: () => {},
	} as unknown as InteractiveModeContext;
	return { ctx, loader };
}

/** How each blocking presenter is opened, then closed without an answer. */
const PRESENTERS: Record<string, (controller: ExtensionUiController, signal: AbortSignal) => Promise<unknown>> = {
	showHookSelector: (controller, signal) => controller.showHookSelector("Pick", ["a", "b"], { signal }),
	showHookInput: (controller, signal) => controller.showHookInput("Type", undefined, { signal }),
	showHookEditor: (controller, signal) => controller.showHookEditor("Edit", undefined, { signal }),
	showAskDialog: (controller, signal) =>
		controller.showAskDialog([{ id: "q", question: "Which?", options: [{ label: "a" }] }], { signal }),
	showHookCustom: (controller, signal) =>
		controller.showHookCustom<undefined>((_tui, _theme, _keys, done) => {
			signal.addEventListener("abort", () => done(undefined), { once: true });
			return { render: () => ["console"], handleInput: () => {} };
		}),
};

/** The presenters that block on the user, derived from the controller itself. */
function blockingPresenters(): string[] {
	return Object.getOwnPropertyNames(ExtensionUiController.prototype)
		.filter(name => /^show(Hook|Ask)/.test(name))
		.filter(name => {
			// `notify` returns at once; `confirm` is a selector with two options.
			return name !== "showHookNotify" && name !== "showHookConfirm";
		})
		.sort();
}

describe("a hook UI waiting on the user is not the agent working", () => {
	it("sweeps every blocking presenter the controller has", () => {
		expect(blockingPresenters()).toEqual(Object.keys(PRESENTERS).sort());
	});

	for (const name of Object.keys(PRESENTERS).sort()) {
		it(`${name} rests the working loader on an idle session`, async () => {
			const { ctx, loader } = host(false);
			const controller = new ExtensionUiController(ctx);
			const abort = new AbortController();

			const pending = PRESENTERS[name](controller, abort.signal);
			expect(loader.mounted).toBe(false);

			abort.abort();
			await pending;
		});

		it(`${name} leaves the loader alone mid-turn`, async () => {
			const { ctx, loader } = host(true);
			const controller = new ExtensionUiController(ctx);
			const abort = new AbortController();

			const pending = PRESENTERS[name](controller, abort.signal);
			expect(loader.mounted).toBe(true);

			abort.abort();
			await pending;
		});
	}
});
