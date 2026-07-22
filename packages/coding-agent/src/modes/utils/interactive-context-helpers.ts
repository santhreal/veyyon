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
	return new AssistantMessageComponent(
		message,
		ctx.effectiveHideThinkingBlock,
		() => ctx.ui.requestRender(),
		ctx.viewSession.extensionRunner?.getAssistantThinkingRenderers(),
		ctx.ui.imageBudget,
		ctx.proseOnlyThinking,
	);
}
