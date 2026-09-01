import type { InteractiveModeContext } from "../../modes/types";
import type { AgentSessionEvent } from "../../session/agent-session";

export type EventControllerContext = Pick<
	InteractiveModeContext,
	| "addMessageToChat"
	| "applyCwdChange"
	| "autoCompactionLoader"
	| "chatContainer"
	| "clearOptimisticUserMessage"
	| "clearPinnedError"
	| "clearTransientSessionUi"
	| "clearWorkingLoader"
	| "editor"
	| "effectiveHideThinkingBlock"
	| "ensureLoadingAnimation"
	| "flushCompactionQueue"
	| "flushPendingModelSwitch"
	| "focusedAgentId"
	| "getUserMessageText"
	| "handlePlanApproval"
	| "init"
	| "isInitialized"
	| "lastAssistantUsage"
	| "loadingAnimation"
	| "locallySubmittedUserSignatures"
	| "noteDisplayableThinkingContent"
	| "optimisticUserMessageSignature"
	| "pendingTools"
	| "settledToolCalls"
	| "present"
	| "proseOnlyThinking"
	| "rebuildChatFromMessages"
	| "refreshComposerShortcuts"
	| "reloadTodos"
	| "renderInitialMessages"
	| "replaceOptimisticUserMessage"
	| "retryLoader"
	| "session"
	| "sessionManager"
	| "setTodos"
	| "setWorkingMessage"
	| "settings"
	| "showError"
	| "showPinnedError"
	| "showStatus"
	| "showWarning"
	| "statusContainer"
	| "statusLine"
	| "streamingComponent"
	| "streamingMessage"
	| "todoPhases"
	| "toolOutputExpanded"
	| "ui"
	| "unsubscribe"
	| "updateEditorBorderColor"
	| "updatePendingMessagesDisplay"
	| "viewSession"
>;

export type AgentSessionEventKind = AgentSessionEvent["type"];

export const IRC_MESSAGE_VISIBLE_TTL_MS = 10_000;
export const MAX_LIVE_IRC_CARDS = 4;
export const IDLE_RECAP_MIN_SECONDS = 1;
export const IDLE_RECAP_MAX_SECONDS = 3600;

export const RAW_PARTIAL_JSON_RENDERERS: Record<string, true> = { bash: true, edit: true, apply_patch: true };

export function exposesRawPartialJson(toolName: string, rawInput: boolean, tool: unknown): boolean {
	if (rawInput) return true;
	if (RAW_PARTIAL_JSON_RENDERERS[toolName]) return true;
	if (tool === null || typeof tool !== "object" || !("renderCall" in tool)) return false;
	return typeof tool.renderCall === "function";
}

export type AgentSessionEventHandlers = {
	[E in AgentSessionEventKind]: (event: Extract<AgentSessionEvent, { type: E }>) => Promise<void>;
};
