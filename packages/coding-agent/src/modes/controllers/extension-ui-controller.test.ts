import { describe, expect, it, vi } from "bun:test";
import { Container } from "@veyyon/tui";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import { CustomEditor } from "../components/custom-editor";
import { getEditorTheme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { ExtensionUiController } from "./extension-ui-controller";

function makeHarness() {
	const editor = new CustomEditor(getEditorTheme());
	const requestRender = vi.fn();
	const addAutocompleteProvider = vi.fn();
	let uiContext: ExtensionUIContext | undefined;
	const hookWidgetContainerAbove = new Container();
	const ctx = {
		editor,
		ui: {
			requestRender,
		},
		session: {
			extensionRunner: undefined,
		},
		hookWidgetContainerAbove,
		hookWidgetContainerBelow: new Container(),
		setToolUIContext(context: ExtensionUIContext, hasUI: boolean): void {
			expect(hasUI).toBe(true);
			uiContext = context;
		},
		addAutocompleteProvider,
	} as unknown as InteractiveModeContext;

	return {
		editor,
		requestRender,
		addAutocompleteProvider,
		hookWidgetContainerAbove,
		async init(): Promise<ExtensionUIContext> {
			await new ExtensionUiController(ctx).initHooksAndCustomTools();
			expect(uiContext).toBeDefined();
			return uiContext!;
		},
	};
}

describe("ExtensionUiController editor UI", () => {
	it("requests a render after extension pasteToEditor mutates the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.pasteToEditor("hello");
		ui.pasteToEditor(" world");

		expect(harness.editor.getText()).toBe("hello world");
		expect(harness.requestRender).toHaveBeenCalledTimes(2);
	});

	it("requests a render after extension setEditorText replaces the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.setEditorText("hello");

		expect(harness.editor.getText()).toBe("hello");
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
	});

	it("bridges addAutocompleteProvider factories to the interactive mode context (#4919)", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		expect(typeof ui.addAutocompleteProvider).toBe("function");

		const factory = (current: unknown) => current as never;
		ui.addAutocompleteProvider(factory);

		expect(harness.addAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(harness.addAutocompleteProvider).toHaveBeenCalledWith(factory);
	});
});

/**
 * WHY THIS SUITE EXISTS. An extension hands `ui.setWidget` a `string[]`, and a blank entry in
 * that array is the only way it can separate two groups of rows. `#createHookWidget` used to wrap
 * every entry in its own `Text`, and `Text.render` returns zero rows for whitespace-only content
 * (padding and NBSP are both stripped by its `trim` check), so the blank was silently dropped:
 * the widget rendered one row short and two unrelated groups ran together. The blank still counted
 * against `MAX_WIDGET_LINES`, so the extension was charged for a row it never got.
 *
 * This is third-party content, so veyyon cannot fix it upstream by authoring the string
 * differently. The separator has to survive the container.
 */
describe("ExtensionUiController hook widgets", () => {
	it("keeps a blank separator row an extension put between two widget groups", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.setWidget("build", ["Build: passing", "", "Coverage: 91%"]);

		// The leading "" is the container's own spacer above the editor; the second "" is the
		// extension's separator, which must still be there between the two labels. Rows are
		// compared without their trailing pad to width.
		expect(harness.hookWidgetContainerAbove.render(40).map(row => row.trimEnd())).toEqual([
			"",
			" Build: passing",
			"",
			" Coverage: 91%",
		]);
	});

	it("renders a widget with no blank entries unchanged", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.setWidget("build", ["Build: passing", "Coverage: 91%"]);

		expect(harness.hookWidgetContainerAbove.render(40).map(row => row.trimEnd())).toEqual([
			"",
			" Build: passing",
			" Coverage: 91%",
		]);
	});
});
