import { toolResultNeverRan } from "@veyyon/agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import { getStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import { type Component, Loader, type LoaderMessageColorFn, Spacer, TERMINAL, Text } from "@veyyon/tui";
import { clampLow, escapeTerminalText, logger, prompt } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import { extractTextContent } from "../../commit/utils";
import { settings } from "../../config/settings-instance";
import { getFileSnapshotStore } from "../../edit/file-snapshot-store";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { detectCacheInvalidation, usesExplicitPromptCache } from "../../modes/components/cache-invalidation-marker";
import { compactionActionLabel, willCompactRemotely } from "../../modes/components/compaction-summary-message";
import {
	ReadToolGroupComponent,
	readArgsHaveTarget,
	readArgsTargetInternalUrl,
} from "../../modes/components/read-tool-group";
import { TodoReminderComponent } from "../../modes/components/todo-reminder";
import { ToolExecutionComponent } from "../../modes/components/tool-execution";
import { TtsrNotificationComponent } from "../../modes/components/ttsr-notification";
import { createUsageRowBlock } from "../../modes/components/usage-row";
import { UserMessageComponent } from "../../modes/components/user-message";
import { setShimmerActivity, shimmerText } from "../../modes/theme/shimmer";
import { getSymbolTheme, theme } from "../../modes/theme/theme";
import type { InteractiveModeContext, TodoPhase } from "../../modes/types";
import type { PlanApprovalDetails } from "../../plan-mode/approved-plan";
import { sideChannelPrompts } from "../../prompts/side-channel/rows";
import { SECRET_SPEND_NOTICE_SOURCE } from "../../secrets/notices";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { isSilentAbort, readQueueChipText, resolveAbortLabel } from "../../session/messages";
import { previewLine, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import type { ResolveToolDetails } from "../../tools/resolve";
import { nextActionableTask } from "../../tools/todo";
import { SpeechEnhancer } from "../../tts/speech-enhancer";
import { vocalizer } from "../../tts/vocalizer";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { formatRetryLine, formatRetrySummary, type RetryTrace, retryReason } from "../retry-display";
import { interruptHint } from "../shared";
import { asyncToolState, isLiveBackgroundTask } from "../utils/async-tool-state";
import { createAssistantMessageComponent } from "../utils/interactive-context-helpers";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	splitAssistantMessageToolTimeline,
} from "../utils/transcript-render-helpers";
import { StreamingRevealController } from "./streaming-reveal";
import { streamingStringKeysForTool, ToolArgsRevealController } from "./tool-args-reveal";

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

type AgentSessionEventKind = AgentSessionEvent["type"];

const IRC_MESSAGE_VISIBLE_TTL_MS = 10_000;
const MAX_LIVE_IRC_CARDS = 4;
const IDLE_RECAP_MIN_SECONDS = 1;
const IDLE_RECAP_MAX_SECONDS = 3600;

const RAW_PARTIAL_JSON_RENDERERS: Record<string, true> = { bash: true, edit: true, apply_patch: true };

function exposesRawPartialJson(toolName: string, rawInput: boolean, tool: unknown): boolean {
	if (rawInput) return true;
	if (RAW_PARTIAL_JSON_RENDERERS[toolName]) return true;
	if (tool === null || typeof tool !== "object" || !("renderCall" in tool)) return false;
	return typeof tool.renderCall === "function";
}

type AgentSessionEventHandlers = {
	[E in AgentSessionEventKind]: (event: Extract<AgentSessionEvent, { type: E }>) => Promise<void>;
};

export class EventController {
	#lastReadGroup: ReadToolGroupComponent | undefined = undefined;
	#lastVisibleBlockCount = 0;
	#renderedCustomMessages = new Set<string>();
	#lastIntent: string | undefined = undefined;
	#backgroundTaskCallIds = new Set<string>();
	#readToolCallArgs = new Map<string, Record<string, unknown>>();
	#readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
	#toolTimelineComponents = new Map<string, Component>();
	#postToolAssistantComponents = new Map<string, AssistantMessageComponent>();
	#lastAssistantComponent: AssistantMessageComponent | undefined = undefined;
	#pinnedErrorComponent: AssistantMessageComponent | undefined = undefined;
	#retrySupersededAssistantComponents = new Map<string, AssistantMessageComponent>();
	#retrySupersededAssistantQueue: AssistantMessageComponent[] = [];
	#retryTrace: RetryTrace | undefined = undefined;
	#idleCompactionTimer?: NodeJS.Timeout;
	#idleRecapTimer?: NodeJS.Timeout;
	#idleRecapAbort?: AbortController;
	#ircExpiryTimers = new Map<string, NodeJS.Timeout>();
	#liveIrcCards = new Map<string, Component[]>();
	#displaceablePollComponent: ToolExecutionComponent | undefined = undefined;
	#displaceableTodoComponent: ToolExecutionComponent | undefined = undefined;
	#lastTtsrNotification: TtsrNotificationComponent | undefined = undefined;
	#streamingReveal: StreamingRevealController;
	#toolArgsReveal: ToolArgsRevealController;
	#prevHideThinking = false;
	#handlers: AgentSessionEventHandlers;
	#terminalProgressActive = false;
	#namedCacheInvalidations = 0;

	constructor(private ctx: EventControllerContext) {
		const session = ctx.session;
		vocalizer.setEnhancer(
			session?.modelRegistry && session.agent && session.settings
				? new SpeechEnhancer({
						settings: session.settings,
						registry: session.modelRegistry,
						sessionId: session.sessionId,
						metadataResolver: provider => session.agent.metadataForProvider(provider),
						obfuscateProviderText: text => session.obfuscateProviderText(text),
					})
				: null,
		);
		this.#streamingReveal = new StreamingRevealController({
			getSmoothStreaming: () => this.ctx.settings.get("display.smoothStreaming"),
			getHideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			getProseOnlyThinking: () => this.ctx.proseOnlyThinking,
			requestRender: component => this.ctx.ui.requestComponentRender(component),
		});
		this.#toolArgsReveal = new ToolArgsRevealController({
			getSmoothStreaming: () => this.ctx.settings.get("display.smoothStreaming"),
			requestRender: component => this.ctx.ui.requestComponentRender(component),
		});
		this.#handlers = {
			agent_start: e => this.#handleAgentStart(e),
			agent_end: e => this.#handleAgentEnd(e),
			turn_start: async () => this.#handleTurnStart(),
			turn_end: async e => this.#handleTurnEnd(e),
			message_start: e => this.#handleMessageStart(e),
			message_update: e => this.#handleMessageUpdate(e),
			message_end: e => this.#handleMessageEnd(e),
			tool_execution_start: e => this.#handleToolExecutionStart(e),
			tool_execution_update: e => this.#handleToolExecutionUpdate(e),
			tool_execution_end: e => this.#handleToolExecutionEnd(e),
			auto_compaction_start: e => this.#handleAutoCompactionStart(e),
			auto_compaction_end: e => this.#handleAutoCompactionEnd(e),
			auto_retry_start: e => this.#handleAutoRetryStart(e),
			auto_retry_end: e => this.#handleAutoRetryEnd(e),
			retry_fallback_applied: e => this.#handleRetryFallbackApplied(e),
			retry_fallback_succeeded: e => this.#handleRetryFallbackSucceeded(e),
			ttsr_triggered: e => this.#handleTtsrTriggered(e),
			todo_reminder: e => this.#handleTodoReminder(e),
			todo_auto_clear: e => this.#handleTodoAutoClear(e),
			irc_message: e => this.#handleIrcMessage(e),
			notice: e => this.#handleNotice(e),
			thinking_level_changed: async () => {
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				const hideThinking = this.ctx.effectiveHideThinkingBlock;
				if (hideThinking === this.#prevHideThinking) {
					this.ctx.ui.requestRender();
					return;
				}
				this.#prevHideThinking = hideThinking;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setHideThinkingBlock(hideThinking);
					}
				}
				if (this.ctx.streamingComponent && this.ctx.streamingMessage) {
					this.ctx.streamingComponent.setHideThinkingBlock(hideThinking);
					this.#streamingReveal.resyncVisibility();
				}
				this.ctx.ui.resetDisplay();
			},
			goal_updated: async () => {},
			cwd_changed: async event => {
				await this.ctx.applyCwdChange(event.cwd);
			},
		} satisfies AgentSessionEventHandlers;
	}

	dispose(): void {
		this.#streamingReveal.stop();
		this.#toolArgsReveal.stop();
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		this.#setTerminalProgress(false);
		for (const timer of this.#ircExpiryTimers.values()) {
			clearTimeout(timer);
		}
		this.#ircExpiryTimers.clear();
		this.#liveIrcCards.clear();
	}

	#resetReadGroup(): void {
		this.#lastReadGroup?.finalize();
		this.#lastReadGroup = undefined;
	}

	#getReadGroup(): ReadToolGroupComponent {
		if (!this.#lastReadGroup) {
			const group = new ReadToolGroupComponent({
				showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
			});
			group.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.chatContainer.addChild(group);
			this.#lastReadGroup = group;
		}
		return this.#lastReadGroup;
	}

	#trackReadToolCall(toolCallId: string, args: unknown): void {
		if (!toolCallId) return;
		const normalizedArgs =
			args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
		this.#readToolCallArgs.set(toolCallId, normalizedArgs);
		const assistantComponent = this.ctx.streamingComponent ?? this.#lastAssistantComponent;
		if (assistantComponent) {
			this.#readToolCallAssistantComponents.set(toolCallId, assistantComponent);
		}
	}

	#clearReadToolCall(toolCallId: string): void {
		this.#readToolCallArgs.delete(toolCallId);
		this.#readToolCallAssistantComponents.delete(toolCallId);
	}

	#inlineReadToolImages(
		toolCallId: string,
		result: { content: Array<{ type: string; data?: string; mimeType?: string }> },
	): boolean {
		if (!settings.get("terminal.showImages")) return false;
		const assistantComponent = this.#readToolCallAssistantComponents.get(toolCallId);
		if (!assistantComponent) return false;
		const images: ImageContent[] = [];
		for (let i = 0; i < result.content.length; i++) {
			const content = result.content[i]!;
			if (content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string") {
				images.push({ type: "image", data: content.data, mimeType: content.mimeType });
			}
		}
		if (images.length === 0) return false;
		assistantComponent.setToolResultImages(toolCallId, images);
		return true;
	}

	#insertAfterTranscriptComponent(anchor: Component | undefined, component: Component): boolean {
		const children = this.ctx.chatContainer.children;
		const anchorIndex = anchor ? children.indexOf(anchor) : -1;
		if (anchorIndex < 0) return false;
		for (let ci = anchorIndex + 1; ci < children.length; ci++) {
			if (!this.ctx.chatContainer.isBlockUncommitted(children[ci]!)) return false;
		}
		this.ctx.chatContainer.addChild(component);
		children.splice(children.length - 1, 1);
		children.splice(anchorIndex + 1, 0, component);
		return true;
	}

	#upsertPostToolAssistantSegment(
		toolCallId: string,
		segment: AssistantMessage | undefined,
	): AssistantMessageComponent | undefined {
		if (!segment || !assistantHasVisibleContent(segment)) return undefined;
		const existing = this.#postToolAssistantComponents.get(toolCallId);
		if (existing) {
			existing.updateContent(segment);
			return existing;
		}
		const component = createAssistantMessageComponent(this.ctx);
		component.updateContent(segment);
		this.#postToolAssistantComponents.set(toolCallId, component);
		if (!this.#insertAfterTranscriptComponent(this.#toolTimelineComponents.get(toolCallId), component)) {
			this.ctx.chatContainer.addChild(component);
		}
		return component;
	}

	#repaintMessageUpdateComponents(components: Iterable<Component>): void {
		let scheduled = false;
		for (const component of components) {
			scheduled = true;
			if (typeof this.ctx.ui.requestComponentRender === "function") {
				this.ctx.ui.requestComponentRender(component);
			}
		}
		if (scheduled && typeof this.ctx.ui.requestComponentRender !== "function") {
			this.ctx.ui.requestRender();
		}
	}

	#updateWorkingMessageFromIntent(intent: unknown): void {
		if (this.ctx.session.isAborting) return;
		if (typeof intent !== "string") return;
		const trimmed = intent.trim();
		if (!trimmed || trimmed === this.#lastIntent) return;
		this.#lastIntent = trimmed;
		this.ctx.setWorkingMessage(`${trimmed}${interruptHint()}`);
	}

	subscribeToAgent(): void {
		this.attachTo(this.ctx.session);
	}

	attachTo(target: AgentSession): void {
		let assistantStreamSynced = false;
		this.ctx.unsubscribe = target.subscribe(async (event: AgentSessionEvent) => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				assistantStreamSynced = true;
			} else if (event.type === "message_update" && event.message.role === "assistant" && !assistantStreamSynced) {
				assistantStreamSynced = true;
				await this.handleEvent({ type: "message_start", message: event.message });
			}
			await this.handleEvent(event);
		});
	}

	resetTranscriptAnchors(): void {
		this.#resetReadGroup();
		this.#lastVisibleBlockCount = 0;
		this.#renderedCustomMessages.clear();
		this.#lastIntent = undefined;
		this.#toolTimelineComponents.clear();
		this.#postToolAssistantComponents.clear();
		this.#backgroundTaskCallIds.clear();
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#lastAssistantComponent = undefined;
		this.#pinnedErrorComponent = undefined;
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		for (const timer of this.#ircExpiryTimers.values()) {
			clearTimeout(timer);
		}
		this.#ircExpiryTimers.clear();
		this.#liveIrcCards.clear();
		this.#displaceablePollComponent = undefined;
		this.#displaceableTodoComponent = undefined;
		this.#lastTtsrNotification = undefined;
		this.#streamingReveal.stop();
		this.#toolArgsReveal.stop();
	}

	async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.ctx.isInitialized) {
			await this.ctx.init();
		}

		const run = this.#handlers[event.type] as (e: AgentSessionEvent) => Promise<void>;
		await run(event);
	}

	#setTerminalProgress(active: boolean): void {
		if (active) {
			if (this.#terminalProgressActive || this.ctx.settings?.get("terminal.showProgress") !== true) return;
			this.ctx.ui.terminal.setProgress(true);
			this.#terminalProgressActive = true;
			return;
		}
		if (!this.#terminalProgressActive) return;
		this.ctx.ui.terminal.setProgress(false);
		this.#terminalProgressActive = false;
	}

	#trackRetrySupersededAssistantComponent(component: AssistantMessageComponent | undefined): void {
		if (!component) return;
		const persistenceKey = component.messagePersistenceKey();
		if (persistenceKey) this.#retrySupersededAssistantComponents.set(persistenceKey, component);
		if (!this.#retrySupersededAssistantQueue.includes(component)) {
			this.#retrySupersededAssistantQueue.push(component);
		}
	}

	#takeRetrySupersededAssistantComponent(persistenceKey: string | undefined): AssistantMessageComponent | undefined {
		if (persistenceKey) {
			const component = this.#retrySupersededAssistantComponents.get(persistenceKey);
			if (component) {
				this.#retrySupersededAssistantComponents.delete(persistenceKey);
				this.#retrySupersededAssistantQueue = this.#retrySupersededAssistantQueue.filter(
					item => item !== component,
				);
				return component;
			}
		}
		while (this.#retrySupersededAssistantQueue.length > 0) {
			const component = this.#retrySupersededAssistantQueue.shift();
			if (!component) continue;
			const key = component.messagePersistenceKey();
			if (key && this.#retrySupersededAssistantComponents.get(key) !== component) continue;
			if (key) this.#retrySupersededAssistantComponents.delete(key);
			return component;
		}
		return undefined;
	}

	#clearRetrySupersededAssistantComponents(): void {
		this.#retrySupersededAssistantComponents.clear();
		this.#retrySupersededAssistantQueue = [];
	}

	#takeCacheInvalidationCause(): string | undefined {
		const recorded = this.ctx.session?.systemPromptInvalidations?.() ?? [];
		if (recorded.length <= this.#namedCacheInvalidations) {
			this.#namedCacheInvalidations = recorded.length;
			return undefined;
		}
		const fresh = recorded.slice(this.#namedCacheInvalidations);
		this.#namedCacheInvalidations = recorded.length;
		return fresh.at(-1);
	}

	#workingUserMessage: UserMessageComponent | undefined;

	#armWorkingUserMessage(): void {
		this.#workingUserMessage?.setWorking(false);
		this.#workingUserMessage = undefined;
		const children = this.ctx.chatContainer?.children ?? [];
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			if (child instanceof UserMessageComponent) {
				child.setWorking(true);
				this.#workingUserMessage = child;
				return;
			}
		}
	}

	async #handleAgentStart(_event: Extract<AgentSessionEvent, { type: "agent_start" }>): Promise<void> {
		this.#armWorkingUserMessage();
		this.#toolTimelineComponents.clear();
		this.#postToolAssistantComponents.clear();
		this.#lastIntent = undefined;
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#resetReadGroup();
		this.#resolveDisplaceableTodo();
		this.#lastAssistantComponent = undefined;
		this.#pinnedErrorComponent?.setErrorPinned(false);
		this.#pinnedErrorComponent = undefined;
		this.ctx.clearPinnedError();
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		this.ctx.statusLine.markActivityStart();
		this.#setTerminalProgress(true);
		setShimmerActivity("thinking");
		this.ctx.ensureLoadingAnimation();
		this.ctx.refreshComposerShortcuts();
		this.ctx.ui.requestRender();
	}

	async #handleMessageStart(event: Extract<AgentSessionEvent, { type: "message_start" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		if (event.message.role === "hookMessage" || event.message.role === "custom") {
			const signature = `${event.message.role}:${event.message.customType}:${event.message.timestamp}`;
			if (this.#renderedCustomMessages.has(signature)) {
				return;
			}
			this.#renderedCustomMessages.add(signature);
			this.#resetReadGroup();
			this.ctx.addMessageToChat(event.message);
			if (event.message.role === "custom" && readQueueChipText(event.message.details)) {
				this.ctx.updatePendingMessagesDisplay();
			}
			this.ctx.ui.requestRender();
		} else if (event.message.role === "user") {
			const textContent = this.ctx.getUserMessageText(event.message);
			let imageCount = 0;
			if (typeof event.message.content !== "string") {
				const blocks = event.message.content;
				for (let bi = 0; bi < blocks.length; bi++) {
					const block = blocks[bi]!;
					if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
						imageCount++;
					}
				}
			}
			const signature = `${textContent}\u0000${imageCount}`;

			this.#resetReadGroup();
			this.#resolveDisplaceablePoll();
			this.#resolveDisplaceableTodo();
			const wasOptimistic = this.ctx.optimisticUserMessageSignature === signature;
			const matchedLocalSubmission = this.ctx.locallySubmittedUserSignatures.delete(signature);
			const replacesOptimistic =
				this.ctx.optimisticUserMessageSignature !== undefined && !wasOptimistic && !matchedLocalSubmission;
			const wasLocallySubmitted = matchedLocalSubmission || wasOptimistic || replacesOptimistic;
			if (wasOptimistic) {
				this.ctx.clearOptimisticUserMessage();
			} else if (replacesOptimistic) {
				this.ctx.replaceOptimisticUserMessage(event.message);
			} else {
				this.ctx.addMessageToChat(event.message);
			}

			if (!event.message.synthetic) {
				if (!wasLocallySubmitted) {
					this.ctx.editor.setText("");
				}
				this.ctx.updatePendingMessagesDisplay();
			}
			if (!event.message.synthetic && this.ctx.session?.isStreaming) {
				this.#armWorkingUserMessage();
			}
			this.ctx.ui.requestRender();
		} else if (event.message.role === "fileMention") {
			this.#resetReadGroup();
			this.ctx.addMessageToChat(event.message);
			this.ctx.ui.requestRender();
		} else if (event.message.role === "assistant") {
			this.#lastVisibleBlockCount = 0;
			this.ctx.streamingComponent = createAssistantMessageComponent(this.ctx);
			this.ctx.streamingMessage = event.message;
			this.ctx.chatContainer.addChild(this.ctx.streamingComponent);
			this.#streamingReveal.begin(
				this.ctx.streamingComponent,
				splitAssistantMessageToolTimeline(this.ctx.streamingMessage).beforeTools,
			);
			this.ctx.ui.requestRender();
		}
	}

	async #handleIrcMessage(event: Extract<AgentSessionEvent, { type: "irc_message" }>): Promise<void> {
		const signature = `${event.message.role}:${event.message.customType}:${event.message.timestamp}`;
		if (this.#renderedCustomMessages.has(signature)) {
			return;
		}
		this.#renderedCustomMessages.add(signature);
		this.#resetReadGroup();
		const components = this.ctx.addMessageToChat(event.message);
		this.#scheduleIrcExpiry(signature, components);
		this.#enforceIrcCardCap(signature);
		this.ctx.ui.requestRender();
	}

	#scheduleIrcExpiry(signature: string, components: Component[]): void {
		if (components.length === 0 || this.#ircExpiryTimers.has(signature)) return;
		const timer = setTimeout(() => {
			this.#ircExpiryTimers.delete(signature);
			this.#retireIrcCard(signature);
		}, IRC_MESSAGE_VISIBLE_TTL_MS);
		timer.unref?.();
		this.#ircExpiryTimers.set(signature, timer);
		this.#liveIrcCards.set(signature, components);
	}

	#retireIrcCard(signature: string): void {
		const components = this.#liveIrcCards.get(signature);
		this.#liveIrcCards.delete(signature);
		if (!components) return;
		let removed = false;
		for (const component of components) {
			if (!this.ctx.chatContainer.isBlockUncommitted(component)) continue;
			this.ctx.chatContainer.removeChild(component);
			removed = true;
		}
		if (removed) this.ctx.ui.requestRender();
	}

	#enforceIrcCardCap(latestSignature: string): void {
		while (this.#liveIrcCards.size > MAX_LIVE_IRC_CARDS) {
			const oldest = this.#liveIrcCards.keys().next().value;
			if (oldest === undefined || oldest === latestSignature) return;
			const timer = this.#ircExpiryTimers.get(oldest);
			if (timer) {
				clearTimeout(timer);
				this.#ircExpiryTimers.delete(oldest);
			}
			this.#retireIrcCard(oldest);
		}
	}

	#resolveDisplaceablePoll(nextToolName?: string): void {
		const previous = this.#displaceablePollComponent;
		if (!previous) return;
		this.#displaceablePollComponent = undefined;
		if (
			nextToolName === "job" &&
			previous.isDisplaceableBlock() &&
			this.ctx.chatContainer.isBlockUncommitted(previous)
		) {
			this.ctx.chatContainer.removeChild(previous);
		}
		previous.seal();
		this.ctx.ui.requestRender();
	}

	#resolveDisplaceableTodo(nextToolName?: string): void {
		const previous = this.#displaceableTodoComponent;
		if (!previous) return;
		if (!previous.isDisplaceableBlock()) {
			this.#displaceableTodoComponent = undefined;
			return;
		}
		if (previous.canBeDisplacedBy(nextToolName)) {
			this.#displaceableTodoComponent = undefined;
			if (this.ctx.chatContainer.isBlockUncommitted(previous)) {
				this.ctx.chatContainer.removeChild(previous);
			}
			previous.seal();
			this.ctx.ui.requestRender();
			return;
		}
		if (nextToolName !== undefined) return;
		this.#displaceableTodoComponent = undefined;
		previous.seal();
		this.ctx.ui.requestRender();
	}

	inheritDisplaceableTodo(component: ToolExecutionComponent | null | undefined): void {
		this.#displaceableTodoComponent = component?.canBeDisplacedBy("todo") ? component : undefined;
	}

	async #handleNotice(event: Extract<AgentSessionEvent, { type: "notice" }>): Promise<void> {
		if (event.source === SECRET_SPEND_NOTICE_SOURCE) {
			this.ctx.present([new Spacer(1), new Text(theme.fg("dim", escapeTerminalText(event.message)), 1, 0)]);
			this.ctx.ui.requestRender();
			return;
		}
		const message = event.source ? `${event.source}: ${event.message}` : event.message;
		if (event.level === "error") {
			this.ctx.showError(message);
		} else if (event.level === "warning") {
			this.ctx.showWarning(message);
		} else {
			this.ctx.showStatus(message);
		}
	}

	#handleTurnStart(): void {
		vocalizer.clear();
	}

	#vocalizeDelta(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
		if (!settings.get("speech.enabled")) return;
		const mode = settings.get("speech.mode");
		const delta = event.assistantMessageEvent;
		if (delta.type === "text_delta" && (mode === "assistant" || mode === "all")) {
			vocalizer.pushDelta(delta.delta);
		} else if (delta.type === "thinking_delta" && mode === "all") {
			vocalizer.pushDelta(delta.delta);
		}
	}

	#handleTurnEnd(event: Extract<AgentSessionEvent, { type: "turn_end" }>): void {
		if (!settings.get("speech.enabled")) return;
		if (settings.get("speech.mode") !== "yield") {
			vocalizer.flush();
			return;
		}
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason === "aborted") return; // interrupted: never speak the aborted partial
		const text = extractTextContent(event.message);
		if (text) vocalizer.speak(text);
	}

	async #handleMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		const streamDelta = event.assistantMessageEvent;
		if (streamDelta?.type === "text_delta") setShimmerActivity("streaming");
		else if (streamDelta?.type === "thinking_delta") setShimmerActivity("thinking");
		this.#vocalizeDelta(event);
		if (this.ctx.streamingComponent && event.message.role === "assistant") {
			const smoothStreaming = this.ctx.settings.get("display.smoothStreaming");
			const repaintTargets = new Set<Component>();
			const streamingComponent = this.ctx.streamingComponent;
			const unlockedThinkingVisibility = this.ctx.noteDisplayableThinkingContent(event.message);
			if (unlockedThinkingVisibility) {
				streamingComponent.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
				this.#streamingReveal.resyncVisibility();
				repaintTargets.add(streamingComponent);
			}
			this.ctx.streamingMessage = event.message;
			const timeline = splitAssistantMessageToolTimeline(this.ctx.streamingMessage);
			this.#streamingReveal.setTarget(timeline.beforeTools);

			let visibleBlockCount = 0;
			const streamingContent = this.ctx.streamingMessage.content;
			for (let ci = 0; ci < streamingContent.length; ci++) {
				const content = streamingContent[ci]!;
				if (
					(content.type === "text" && canonicalizeMessage(content.text)) ||
					(content.type === "thinking" && canonicalizeMessage(content.thinking))
				)
					visibleBlockCount++;
			}
			if (visibleBlockCount > this.#lastVisibleBlockCount) {
				if (!smoothStreaming || this.#lastVisibleBlockCount >= 1) {
					repaintTargets.add(streamingComponent);
				}
				this.#resetReadGroup();
				this.#lastVisibleBlockCount = visibleBlockCount;
			}

			if (timeline.hasToolCalls) {
				streamingComponent.markTranscriptBlockFinalized();
				repaintTargets.add(streamingComponent);
			}
			for (let ci = 0; ci < streamingContent.length; ci++) {
				const content = streamingContent[ci]!;
				if (content.type !== "toolCall") continue;
				if (content.name === "read") {
					if (!readArgsHaveTarget(content.arguments)) {
						continue;
					}
					if (!readArgsTargetInternalUrl(content.arguments)) {
						if (this.ctx.settledToolCalls.has(content.id)) continue;
						if (!this.ctx.pendingTools.has(content.id)) this.#resolveDisplaceablePoll(content.name);
						this.#trackReadToolCall(content.id, content.arguments);
						const component = this.ctx.pendingTools.get(content.id);
						if (component) {
							component.updateArgs(content.arguments, content.id);
							repaintTargets.add(component);
						} else {
							const group = this.#getReadGroup();
							group.updateArgs(content.arguments, content.id);
							this.ctx.pendingTools.set(content.id, group);
							this.#toolTimelineComponents.set(content.id, group);
							repaintTargets.add(group);
						}
						continue;
					}
				}

				let renderArgs: Record<string, unknown>;
				const partialJson = getStreamingPartialJson(content);
				const rawInput = content.customWireName !== undefined;
				const tool = this.ctx.viewSession.getToolByName(content.name);
				if (partialJson) {
					renderArgs = this.#toolArgsReveal.setTarget(content.id, partialJson, {
						rawInput,
						exposeRawPartialJson: exposesRawPartialJson(content.name, rawInput, tool),
						streamingStringKeys: streamingStringKeysForTool(content.name, rawInput),
						argot: this.ctx.viewSession.getArgotSession?.(),
					});
				} else {
					this.#toolArgsReveal.finish(content.id);
					renderArgs = content.arguments;
				}
				if (this.ctx.settledToolCalls.has(content.id)) continue;
				if (!this.ctx.pendingTools.has(content.id)) {
					this.#resolveDisplaceablePoll(content.name);
					this.#resetReadGroup();
					const component = new ToolExecutionComponent(
						content.name,
						renderArgs,
						{
							snapshots: getFileSnapshotStore(this.ctx.viewSession),
							showImages: settings.get("terminal.showImages"),
							editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
							editAllowFuzzy: settings.get("edit.fuzzyMatch"),
						},
						tool,
						this.ctx.ui,
						this.ctx.sessionManager.getCwd(),
						content.id,
					);
					component.setExpanded(this.ctx.toolOutputExpanded);
					this.ctx.chatContainer.addChild(component);
					this.ctx.pendingTools.set(content.id, component);
					this.#toolTimelineComponents.set(content.id, component);
					this.#toolArgsReveal.bind(content.id, component);
					repaintTargets.add(component);
				} else {
					const component = this.ctx.pendingTools.get(content.id);
					if (component) {
						component.updateArgs(renderArgs, content.id);
						this.#toolArgsReveal.bind(content.id, component);
						if (!partialJson || !smoothStreaming) {
							repaintTargets.add(component);
						}
					}
				}
			}
			for (const [toolCallId, segment] of timeline.afterToolCalls) {
				const segmentComponent = this.#upsertPostToolAssistantSegment(toolCallId, segment);
				if (segmentComponent) {
					repaintTargets.add(segmentComponent);
				}
			}

			for (let ci = 0; ci < streamingContent.length; ci++) {
				const content = streamingContent[ci]!;
				if (content.type !== "toolCall") continue;
				const args = content.arguments;
				if (!args || typeof args !== "object") continue;
				if (INTENT_FIELD in args) {
					this.#updateWorkingMessageFromIntent(args[INTENT_FIELD]);
					continue;
				}
				const tool = this.ctx.viewSession.getToolByName(content.name);
				if (typeof tool?.intent !== "function") continue;
				try {
					const derived = tool.intent(args as never)?.trim();
					if (derived) {
						this.#updateWorkingMessageFromIntent(derived);
					}
				} catch {}
			}

			if (!smoothStreaming) {
				repaintTargets.add(streamingComponent);
			}
			this.#repaintMessageUpdateComponents(repaintTargets);
		}
	}

	async #handleMessageEnd(event: Extract<AgentSessionEvent, { type: "message_end" }>): Promise<void> {
		if (event.message.role === "user") return;
		const unlockedThinkingVisibility =
			event.message.role === "assistant" && this.ctx.noteDisplayableThinkingContent(event.message);
		if (unlockedThinkingVisibility && this.ctx.streamingComponent) {
			this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
			this.#streamingReveal.resyncVisibility();
		}
		if (event.message.role === "assistant" && settings.get("speech.enabled")) {
			if (event.message.stopReason === "aborted") {
				vocalizer.clear();
			} else {
				const mode = settings.get("speech.mode");
				if (mode === "assistant" || mode === "all") vocalizer.flush();
			}
		}
		if (this.ctx.streamingComponent && event.message.role === "assistant") {
			this.ctx.streamingMessage = event.message;
			this.#streamingReveal.stop();
			this.#toolArgsReveal.flushAll();
			let errorMessage: string | undefined;
			const aborted = this.ctx.streamingMessage.stopReason === "aborted";
			const silentlyAborted = aborted && isSilentAbort(this.ctx.streamingMessage);
			const ttsrSilenced = aborted && this.ctx.viewSession.isTtsrAbortPending;
			if (aborted && !silentlyAborted && !ttsrSilenced) {
				errorMessage = resolveAbortLabel(this.ctx.streamingMessage, this.ctx.viewSession.retryAttempt);
				this.ctx.streamingMessage.errorMessage = errorMessage;
			}
			const displayMessage: AssistantMessage =
				silentlyAborted || ttsrSilenced
					? {
							...this.ctx.streamingMessage,
							stopReason: "stop",
						}
					: this.ctx.streamingMessage;
			const displayTimeline = splitAssistantMessageToolTimeline(displayMessage);
			this.ctx.streamingComponent.updateContent(displayTimeline.beforeTools);

			if (this.ctx.streamingMessage.stopReason !== "aborted" && this.ctx.streamingMessage.stopReason !== "error") {
				for (const [toolCallId, component] of this.ctx.pendingTools.entries()) {
					component.setArgsComplete(toolCallId);
				}
			} else {
				for (const [toolCallId, component] of this.ctx.pendingTools.entries()) {
					if (!this.#backgroundTaskCallIds.has(toolCallId) && component instanceof ToolExecutionComponent) {
						component.seal();
					}
				}
				this.#resolveDisplaceablePoll();
			}
			const usage = event.message.usage;
			if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
				if (settings.get("display.cacheMissMarker")) {
					const invalidation = detectCacheInvalidation(
						this.ctx.lastAssistantUsage,
						usage,
						this.#takeCacheInvalidationCause(),
						{ explicitCache: usesExplicitPromptCache(event.message.api, event.message.model) },
					);
					if (invalidation) this.ctx.streamingComponent.setCacheInvalidation(invalidation);
				}
				this.ctx.lastAssistantUsage = usage;
			}
			this.ctx.streamingComponent.markTranscriptBlockFinalized();
			let lastPostToolAssistantComponent: AssistantMessageComponent | undefined;
			for (const [toolCallId, segment] of displayTimeline.afterToolCalls) {
				const component = this.#upsertPostToolAssistantSegment(toolCallId, segment);
				component?.markTranscriptBlockFinalized();
				if (component) lastPostToolAssistantComponent = component;
			}
			const errorBearingComponent = this.ctx.streamingComponent;
			this.#lastAssistantComponent = lastPostToolAssistantComponent ?? this.ctx.streamingComponent;
			if (settings.get("display.showTokenUsage") && assistantUsageIsBilled(event.message.usage)) {
				this.ctx.chatContainer.addChild(
					createUsageRowBlock(event.message.usage, event.message.duration, event.message.ttft),
				);
			}
			this.ctx.streamingComponent = undefined;
			this.ctx.streamingMessage = undefined;
			if (event.message.stopReason === "error" && event.message.errorMessage && !isSilentAbort(event.message)) {
				errorBearingComponent?.setErrorPinned(true);
				this.#pinnedErrorComponent = errorBearingComponent;
				this.ctx.showPinnedError(event.message.errorMessage);
			}
			this.ctx.statusLine.invalidate();
			this.ctx.ui.requestRender();
		} else if (
			event.message.role === "assistant" &&
			event.message.stopReason === "error" &&
			event.message.errorMessage &&
			!isSilentAbort(event.message)
		) {
			this.ctx.showPinnedError(event.message.errorMessage);
		}
		this.ctx.ui.requestRender();
	}

	async #handleToolExecutionStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		setShimmerActivity("tool");
		this.#updateWorkingMessageFromIntent(event.intent);
		this.#resolveDisplaceablePoll(event.toolName);
		if (this.ctx.settledToolCalls.has(event.toolCallId)) return;
		if (!this.ctx.pendingTools.has(event.toolCallId)) {
			if (event.toolName === "read" && readArgsHaveTarget(event.args) && !readArgsTargetInternalUrl(event.args)) {
				this.#trackReadToolCall(event.toolCallId, event.args);
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateArgs(event.args, event.toolCallId);
				} else {
					const group = this.#getReadGroup();
					group.updateArgs(event.args, event.toolCallId);
					this.ctx.pendingTools.set(event.toolCallId, group);
					this.#toolTimelineComponents.set(event.toolCallId, group);
				}
				this.ctx.ui.requestRender();
				return;
			}

			this.#resetReadGroup();
			const tool = this.ctx.viewSession.getToolByName(event.toolName);
			const component = new ToolExecutionComponent(
				event.toolName,
				event.args,
				{
					snapshots: getFileSnapshotStore(this.ctx.viewSession),
					showImages: settings.get("terminal.showImages"),
					editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
					editAllowFuzzy: settings.get("edit.fuzzyMatch"),
					liveRegion: this.ctx.chatContainer,
				},
				tool,
				this.ctx.ui,
				this.ctx.sessionManager.getCwd(),
				event.toolCallId,
			);
			component.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.chatContainer.addChild(component);
			this.ctx.pendingTools.set(event.toolCallId, component);
			this.#toolTimelineComponents.set(event.toolCallId, component);
			this.ctx.ui.requestRender();
		} else {
			this.#toolArgsReveal.finish(event.toolCallId);
			const component = this.ctx.pendingTools.get(event.toolCallId);
			if (component && typeof component.updateArgs === "function") {
				component.updateArgs(event.args, event.toolCallId);
				if (typeof component.setArgsComplete === "function") {
					component.setArgsComplete(event.toolCallId);
				}
				this.ctx.ui.requestRender();
			}
		}
	}

	async #handleToolExecutionUpdate(
		event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>,
	): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		const component = this.ctx.pendingTools.get(event.toolCallId);
		if (component) {
			const asyncState = asyncToolState(event.partialResult.details);
			const isFinalAsyncState = asyncState === "completed" || asyncState === "failed";
			const isTerminal = isFinalAsyncState && this.#backgroundTaskCallIds.has(event.toolCallId);
			component.updateResult(
				{ ...event.partialResult, isError: asyncState === "failed" },
				!isTerminal,
				event.toolCallId,
			);
			if (isTerminal) {
				this.ctx.pendingTools.delete(event.toolCallId);
				this.#backgroundTaskCallIds.delete(event.toolCallId);
				this.ctx.settledToolCalls.add(event.toolCallId);
			}
			this.ctx.ui.requestRender();
		}
	}

	async #handleToolExecutionEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		if (this.ctx.settledToolCalls.has(event.toolCallId)) return;
		const endAsyncState = asyncToolState(event.result.details);
		if (event.toolName !== "task" || endAsyncState !== "running") {
			this.ctx.settledToolCalls.add(event.toolCallId);
		}
		if (event.toolName === "read") {
			if (this.#inlineReadToolImages(event.toolCallId, event.result)) {
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
					this.ctx.pendingTools.delete(event.toolCallId);
				}
				this.#clearReadToolCall(event.toolCallId);
				this.ctx.ui.requestRender();
			} else {
				let component = this.ctx.pendingTools.get(event.toolCallId);
				if (!component) {
					const group = this.#getReadGroup();
					const args = this.#readToolCallArgs.get(event.toolCallId);
					if (args) {
						group.updateArgs(args, event.toolCallId);
					}
					component = group;
					this.ctx.pendingTools.set(event.toolCallId, group);
				}
				component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
				this.ctx.pendingTools.delete(event.toolCallId);
				this.#clearReadToolCall(event.toolCallId);
				this.ctx.ui.requestRender();
			}
		} else {
			const component = this.ctx.pendingTools.get(event.toolCallId);
			if (component) {
				const isBackgroundTask = isLiveBackgroundTask(event.toolName, event.result.details);
				component.updateResult({ ...event.result, isError: event.isError }, isBackgroundTask, event.toolCallId);
				if (isBackgroundTask) {
					this.#backgroundTaskCallIds.add(event.toolCallId);
				} else {
					this.ctx.pendingTools.delete(event.toolCallId);
					this.#backgroundTaskCallIds.delete(event.toolCallId);
				}
				if (component instanceof ToolExecutionComponent && component.isDisplaceableBlock()) {
					if (event.toolName === "job" && component.canBeDisplacedBy("job")) {
						this.#displaceablePollComponent = component;
					} else if (event.toolName === "todo" && component.canBeDisplacedBy("todo")) {
						const previous = this.#displaceableTodoComponent;
						if (previous && previous !== component && previous.isDisplaceableBlock()) {
							this.#displaceableTodoComponent = undefined;
							if (this.ctx.chatContainer.isBlockUncommitted(previous)) {
								this.ctx.chatContainer.removeChild(previous);
							}
							previous.seal();
						}
						this.#displaceableTodoComponent = component;
					}
				}
				this.ctx.ui.requestRender();
			}
		}
		if (event.toolName === "todo" && !event.isError) {
			const details = event.result.details as { phases?: TodoPhase[] } | undefined;
			if (details?.phases) {
				this.ctx.setTodos(details.phases);
			}
		} else if (event.toolName === "todo" && event.isError && !toolResultNeverRan(event.result.details)) {
			const textContent = event.result.content.find(
				(content): content is TextContent => content.type === "text",
			)?.text;
			const headline = textContent?.split("\n", 1)[0]?.trim();
			this.ctx.showWarning(
				`Todo update failed${headline ? `: ${headline}` : ". Progress may be stale until todo succeeds."}`,
			);
		}
		if (event.toolName === "resolve" && !event.isError) {
			const details = event.result.details as ResolveToolDetails | undefined;
			if (details?.sourceToolName === "plan_approval" && details.action === "apply") {
				const planDetails = details.sourceResultDetails as PlanApprovalDetails | undefined;
				if (planDetails) {
					await this.ctx.handlePlanApproval(planDetails);
				}
			}
		}
	}
	async #handleAgentEnd(_event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
		if (this.ctx.session.isStreaming) return;

		await this.#finishAgentEnd();
	}

	async #finishAgentEnd(): Promise<void> {
		this.#workingUserMessage?.setWorking(false);
		this.#workingUserMessage = undefined;
		this.#setTerminalProgress(false);
		setShimmerActivity("idle");
		this.ctx.statusLine.markActivityEnd();
		this.#streamingReveal.stop();
		this.#toolArgsReveal.flushAll();
		if (this.ctx.clearWorkingLoader()) {
			this.ctx.statusContainer.disposeChildren();
		}
		if (this.ctx.streamingComponent) {
			this.ctx.chatContainer.removeChild(this.ctx.streamingComponent);
			this.ctx.streamingComponent = undefined;
			this.ctx.streamingMessage = undefined;
		}
		await this.ctx.flushPendingModelSwitch();
		for (const toolCallId of Array.from(this.ctx.pendingTools.keys())) {
			if (!this.#backgroundTaskCallIds.has(toolCallId)) {
				const component = this.ctx.pendingTools.get(toolCallId);
				if (component instanceof ToolExecutionComponent || component instanceof ReadToolGroupComponent) {
					component.seal();
				}
				this.ctx.pendingTools.delete(toolCallId);
				this.ctx.settledToolCalls.add(toolCallId);
			}
		}
		const filtered = new Set<string>();
		for (const toolCallId of this.#backgroundTaskCallIds) {
			if (this.ctx.pendingTools.has(toolCallId)) filtered.add(toolCallId);
		}
		this.#backgroundTaskCallIds = filtered;
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#toolTimelineComponents.clear();
		this.#postToolAssistantComponents.clear();
		this.#resetReadGroup();
		this.#resolveDisplaceablePoll();
		this.#resolveDisplaceableTodo();
		this.#lastAssistantComponent = undefined;
		this.ctx.refreshComposerShortcuts();
		this.ctx.ui.requestRender();
		this.#scheduleIdleCompaction();
		this.#scheduleIdleRecap();
		this.sendCompletionNotification();
	}

	#stopWorkingLoader(): void {
		this.ctx.clearWorkingLoader();
	}

	#ensureWorkingLoaderWhileStreaming(): void {
		if (!this.ctx.viewSession.isStreaming) return;
		if (this.ctx.autoCompactionLoader || this.ctx.retryLoader) return;
		this.ctx.ensureLoadingAnimation();
	}

	#maintenanceEscHint(): string {
		return this.ctx.focusedAgentId ? "" : " (esc to cancel)";
	}

	async #handleAutoCompactionStart(
		event: Extract<AgentSessionEvent, { type: "auto_compaction_start" }>,
	): Promise<void> {
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		this.#setTerminalProgress(true);
		this.#stopWorkingLoader();
		this.ctx.statusContainer.disposeChildren();
		const reasonText =
			event.reason === "overflow"
				? "Context overflow detected, "
				: event.reason === "incomplete"
					? "Response incomplete, "
					: event.reason === "idle"
						? "Idle "
						: "";
		const actionLabel = compactionActionLabel(true, willCompactRemotely(this.ctx.viewSession));
		this.ctx.autoCompactionLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			`${reasonText}${actionLabel}…${this.#maintenanceEscHint()}`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.autoCompactionLoader);
		this.ctx.refreshComposerShortcuts();
		this.ctx.ui.requestRender();
	}

	async #handleAutoCompactionEnd(event: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>): Promise<void> {
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		this.#setTerminalProgress(false);
		if (this.ctx.autoCompactionLoader) {
			this.ctx.autoCompactionLoader.stop();
			this.ctx.autoCompactionLoader = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
		if (event.aborted) {
			this.ctx.showStatus("Auto-compaction cancelled");
		} else if (event.result) {
			this.ctx.lastAssistantUsage = undefined;
			this.ctx.rebuildChatFromMessages();
			this.ctx.statusLine.invalidate();
			if (settings.get("display.collapseCompacted")) {
				this.ctx.ui.requestRender(true, { clearScrollback: true });
			} else {
				this.ctx.ui.requestRender();
			}
		} else if (event.errorMessage) {
			this.ctx.showWarning(event.errorMessage);
		} else if (event.skipped) {
		} else {
			this.ctx.showWarning("Auto-compaction failed; continuing without maintenance");
		}
		await this.ctx.flushCompactionQueue({ willRetry: event.willRetry });
		this.#ensureWorkingLoaderWhileStreaming();
		this.ctx.refreshComposerShortcuts();
		this.ctx.ui.requestRender();
	}

	async #handleAutoRetryStart(event: Extract<AgentSessionEvent, { type: "auto_retry_start" }>): Promise<void> {
		this.#trackRetrySupersededAssistantComponent(this.#lastAssistantComponent);
		this.#trackRetrySupersededAssistantComponent(this.#pinnedErrorComponent);
		this.#stopWorkingLoader();
		setShimmerActivity("error");
		this.ctx.statusContainer.disposeChildren();
		if (AIError.is(event.errorId, AIError.Flag.ThinkingLoop)) {
			this.#pinnedErrorComponent = undefined;
			this.ctx.clearPinnedError();
		}
		this.#retryTrace ??= { attempts: 0, totalDelayMs: 0 };
		const trace = this.#retryTrace;
		trace.attempts = event.attempt;
		trace.totalDelayMs += Math.max(0, event.delayMs);
		trace.reason = retryReason(event.errorId, event.errorMessage);
		trace.mode = event.mode;
		const living = this.ctx.settings.get("display.shimmer") === "living";
		const retryMessageColor: LoaderMessageColorFn = living
			? Object.assign((text: string) => shimmerText(text, theme), { animated: true as const })
			: (text: string) => theme.fg("muted", text);
		this.ctx.retryLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg(living ? "error" : "warning", spinner),
			retryMessageColor,
			`${formatRetryLine({
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorId: event.errorId,
				errorMessage: event.errorMessage,
				policySource: event.policySource,
				mode: event.mode,
			})}…${this.#maintenanceEscHint()}`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.retryLoader);
		this.ctx.ui.requestRender();
	}

	async #handleAutoRetryEnd(event: Extract<AgentSessionEvent, { type: "auto_retry_end" }>): Promise<void> {
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
		setShimmerActivity("thinking");
		if (event.success) {
			let appliedRecovered = false;
			for (const recovered of event.recoveredErrors ?? []) {
				const component = this.#takeRetrySupersededAssistantComponent(recovered.persistenceKey);
				if (!component) continue;
				component.applyRetryRecovery(recovered.retryRecovery);
				if (this.#pinnedErrorComponent === component) this.#pinnedErrorComponent = undefined;
				appliedRecovered = true;
			}
			if (appliedRecovered || (event.recoveredErrors?.length ?? 0) > 0) {
				this.ctx.clearPinnedError();
			}
			this.#clearRetrySupersededAssistantComponents();
			const summary = this.#retryTrace ? formatRetrySummary(this.#retryTrace) : undefined;
			if (summary) this.ctx.showStatus(summary);
		} else {
			this.#clearRetrySupersededAssistantComponents();
			const what = event.mode === "continue" ? "Continuation" : "Retry";
			const attempts = event.attempt === 1 ? "1 attempt" : `${event.attempt} attempts`;
			this.ctx.showError(`${what} failed after ${attempts}: ${event.finalError || "Unknown error"}`);
		}
		this.#retryTrace = undefined;
		this.#ensureWorkingLoaderWhileStreaming();
		this.ctx.ui.requestRender();
	}

	async #handleRetryFallbackApplied(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>,
	): Promise<void> {
		this.ctx.showWarning(`Fallback: ${event.from} -> ${event.to}`);
	}

	async #handleRetryFallbackSucceeded(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>,
	): Promise<void> {
		this.ctx.showStatus(`Fallback succeeded on ${event.model}`);
	}

	async #handleTtsrTriggered(event: Extract<AgentSessionEvent, { type: "ttsr_triggered" }>): Promise<void> {
		const previous = this.#lastTtsrNotification;
		if (
			previous &&
			this.ctx.chatContainer.children.at(-1) === previous &&
			this.ctx.chatContainer.isBlockUncommitted(previous)
		) {
			previous.addRules(event.rules);
			this.ctx.ui.requestRender();
			return;
		}
		const component = new TtsrNotificationComponent(event.rules);
		component.setExpanded(this.ctx.toolOutputExpanded);
		this.ctx.present(component);
		this.#lastTtsrNotification = component;
	}

	async #handleTodoReminder(event: Extract<AgentSessionEvent, { type: "todo_reminder" }>): Promise<void> {
		const component = new TodoReminderComponent(event.todos, event.attempt, event.maxAttempts);
		this.ctx.present(component);
	}

	async #handleTodoAutoClear(_event: Extract<AgentSessionEvent, { type: "todo_auto_clear" }>): Promise<void> {
		await this.ctx.reloadTodos();
	}

	#cancelIdleCompaction(): void {
		if (this.#idleCompactionTimer) {
			clearTimeout(this.#idleCompactionTimer);
			this.#idleCompactionTimer = undefined;
		}
	}

	#cancelIdleRecap(): void {
		if (this.#idleRecapTimer) {
			clearTimeout(this.#idleRecapTimer);
			this.#idleRecapTimer = undefined;
		}
		if (this.#idleRecapAbort) {
			this.#idleRecapAbort.abort();
			this.#idleRecapAbort = undefined;
		}
	}

	#scheduleIdleCompaction(): void {
		this.#cancelIdleCompaction();
		if (this.ctx.viewSession.isCompacting) return;

		const idleSettings = settings.getGroup("compaction");
		if (!idleSettings.idleEnabled) return;

		if (this.ctx.editor.getText().trim()) return;

		const threshold = idleSettings.idleThresholdTokens;
		if (threshold <= 0) return;
		if (this.#currentContextTokens() < threshold) return;

		const timeoutMs = clampLow(idleSettings.idleTimeoutSeconds, 60, 3600) * 1000;
		this.#idleCompactionTimer = setTimeout(() => {
			this.#idleCompactionTimer = undefined;
			if (this.ctx.viewSession.isStreaming) return;
			if (this.ctx.viewSession.isCompacting) return;
			if (this.ctx.editor.getText().trim()) return;
			if (this.#currentContextTokens() < threshold) return;
			void this.ctx.viewSession.runIdleCompaction();
		}, timeoutMs);
		this.#idleCompactionTimer.unref?.();
	}

	#scheduleIdleRecap(): void {
		this.#cancelIdleRecap();
		if (this.ctx.viewSession.isCompacting) return;

		const recapSettings = settings.getGroup("recap");
		if (!recapSettings.enabled) return;
		if (this.ctx.editor.getText().trim()) return;

		const timeoutMs = clampLow(recapSettings.idleSeconds, IDLE_RECAP_MIN_SECONDS, IDLE_RECAP_MAX_SECONDS) * 1000;
		this.#idleRecapTimer = setTimeout(() => {
			this.#idleRecapTimer = undefined;
			void this.#runIdleRecap();
		}, timeoutMs);
		this.#idleRecapTimer.unref?.();
	}

	async #runIdleRecap(): Promise<void> {
		if (!this.#idleConditionsHold()) return;
		if (!this.ctx.viewSession.model) return;
		if (this.ctx.viewSession.messages.length === 0) return;

		const promptText = prompt.render(sideChannelPrompts["side-channel/recap-user"].text, {
			goal: this.#idleRecapGoalText() ?? "",
			task: nextActionableTask(this.ctx.todoPhases)?.content ?? "",
		});

		const abort = new AbortController();
		this.#idleRecapAbort = abort;
		try {
			const { replyText } = await this.ctx.viewSession.runEphemeralTurn({ promptText, signal: abort.signal });
			if (this.#idleRecapAbort !== abort || abort.signal.aborted || !this.#idleConditionsHold()) return;
			const recap = previewLine(replyText, TRUNCATE_LENGTHS.RECAP);
			if (!recap) return;
			this.ctx.showStatus(theme.fg("dim", theme.italic(`※ recap: ${recap}`)), { dim: false });
		} catch (error) {
			if (!abort.signal.aborted) logger.debug("Idle recap turn failed", { error: String(error) });
		} finally {
			if (this.#idleRecapAbort === abort) this.#idleRecapAbort = undefined;
		}
	}

	#idleConditionsHold(): boolean {
		if (this.ctx.viewSession.isStreaming) return false;
		if (this.ctx.viewSession.isCompacting) return false;
		if (this.ctx.editor.getText().trim()) return false;
		return true;
	}

	#idleRecapGoalText(): string | undefined {
		const goal = this.ctx.viewSession.getGoalModeState?.()?.goal.objective.trim();
		if (goal) return goal;
		const title = this.ctx.sessionManager.getSessionName()?.trim();
		return title || undefined;
	}

	#currentContextTokens(): number {
		return this.ctx.viewSession.getContextUsage()?.tokens ?? 0;
	}

	sendCompletionNotification(): void {
		const notify = settings.get("completion.notify");
		if (notify === "off") return;

		const last = this.ctx.viewSession.getLastAssistantMessage?.();
		if (last?.stopReason === "aborted" || last?.stopReason === "error") return;

		const sessionName = this.ctx.sessionManager.getSessionName();
		TERMINAL.sendNotification({
			title: sessionName || "Veyyon",
			body: "Complete",
			type: "completion",
			actions: "focus",
		});
	}
}
