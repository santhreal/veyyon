/**
 * Small helpers over {@link InteractiveModeContext} shared between
 * {@link UiHelpers} and the input/event controllers, so the live chat surfaces
 * construct components and reset editor state identically.
 */
import type { AssistantMessageView } from "@veyyon/wire/presentation";
import { AssistantMessageComponent } from "../components/transcript/assistant-message";
import type { InteractiveModeContext } from "../types";

/**
 * The slice the assistant-message factory reads: four members of the 215
 * `InteractiveModeContext` requires. See `CollabHostContext` for why naming the
 * slice matters.
 */
export type AssistantMessageComponentContext = Pick<
	InteractiveModeContext,
	"effectiveHideThinkingBlock" | "proseOnlyThinking" | "ui" | "viewSession"
>;

/**
 * Construct an {@link AssistantMessageComponent} wired to the live context's
 * thinking/image settings. `message` is omitted for the streaming placeholder
 * component and supplied when rendering a persisted turn.
 */
export function createAssistantMessageComponent(
	ctx: AssistantMessageComponentContext,
	message?: AssistantMessageView,
): AssistantMessageComponent {
	return new AssistantMessageComponent(
		message,
		ctx.effectiveHideThinkingBlock,
		() => ctx.ui.requestRender(),
		ctx.viewSession.extensionRunner?.getAssistantThinkingRenderers(),
		ctx.ui.imageBudget,
		ctx.proseOnlyThinking,
		// Scoped repaint for the streaming shimmer ticker: this placeholder is the
		// live-streaming component, so keep its 30fps flow off the full-tree path (#4377).
		ctx.ui,
	);
}

/** The slice {@link focusEditorSlot} reads. */
export type EditorSlotContext = Pick<InteractiveModeContext, "editor" | "editorContainer" | "ui">;

/**
 * Restore keyboard focus to whatever currently owns the editor slot. The
 * slot can hold the editor itself or a hook selector/input/editor pushed
 * in by `ExtensionUiController` — e.g. an approval prompt that fired while
 * a fullscreen overlay was up. `overlayHandle.hide()` restores focus to
 * the component focused when the overlay opened, which is stale in that
 * case (the editor was swapped out): keys land on a hidden editor and the
 * visible prompt receives nothing (issue #3349). Call this after the
 * overlay hides to re-target focus at the visible slot owner.
 */
export function focusEditorSlot(ctx: EditorSlotContext): void {
	ctx.ui.setFocus(ctx.editorContainer.children[0] ?? ctx.editor);
}
