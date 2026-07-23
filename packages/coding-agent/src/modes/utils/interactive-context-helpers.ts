/**
 * Small helpers over {@link InteractiveModeContext} shared between
 * {@link UiHelpers} and the input/event controllers, so the live chat surfaces
 * construct components and reset editor state identically.
 */
import type { AssistantMessage } from "@veyyon/ai";
import { AssistantMessageComponent } from "../components/assistant-message";
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
	message?: AssistantMessage,
): AssistantMessageComponent {
	const component: AssistantMessageComponent = new AssistantMessageComponent(
		message,
		ctx.effectiveHideThinkingBlock,
		() => ctx.ui.requestRender(),
		ctx.viewSession.extensionRunner?.getAssistantThinkingRenderers(),
		ctx.ui.imageBudget,
		ctx.proseOnlyThinking,
		// Scoped repaint for the streaming shimmer ticker: this placeholder is the
		// live-streaming component, so keep its 30fps flow off the full-tree path (#4377).
		() => ctx.ui.requestComponentRender(component),
	);
	return component;
}
