import { type AgentTool, toolResultNeverRan } from "@veyyon/agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolCall } from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import { getStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import { type Component, Loader, type LoaderMessageColorFn, Spacer, TERMINAL, Text } from "@veyyon/tui";
import { clampLow, escapeTerminalText, logger, prompt } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import { extractTextContent } from "../../../commit/utils";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import { settings } from "../../../config/settings-instance";
import { getFileSnapshotStore } from "../../../edit/file-snapshot-store";
import type { RecoveredRetryError } from "../../../extensibility/shared-events";
import type { PlanApprovalDetails } from "../../../plan-mode/approved-plan";
import { SessionProjectionEngine } from "../../../presentation/session-projection-engine";
import { compactionActionLabel, resolveCompactionKind } from "../../../presentation/summary-builder";
import { resolveAssistantErrorPresentation, toAssistantMessageView } from "../../../presentation/transcript-builder";
import { sideChannelPrompts } from "../../../prompts/side-channel/rows";
import { SECRET_SPEND_NOTICE_SOURCE } from "../../../secrets/notices";
import type { AgentSession } from "../../../session/agent-session";
import type { AgentSessionEvent } from "../../../session/agent-session-types";
import {
	type CustomMessage,
	type HookMessage,
	isSilentAbort,
	readQueueChipText,
	resolveAbortLabel,
} from "../../../session/messages";
import { SpeechEnhancer } from "../../../speech/tts/speech-enhancer";
import { vocalizer } from "../../../speech/tts/vocalizer";
import { setShimmerActivity, shimmerText } from "../../../theme/shimmer";
import { getSymbolTheme, theme } from "../../../theme/theme";
import type { ResolveToolDetails } from "../../../tools/agent/resolve";
import { nextActionableTask } from "../../../tools/agent/todo";
import { previewLine, TRUNCATE_LENGTHS } from "../../../tools/core/render-utils";
import { canonicalizeMessage } from "../../../utils/thinking-display";
import { formatRetryLine } from "../../retry-display";
import { TodoReminderComponent } from "../components/dashboard/todo-reminder";
import { AssistantMessageComponent } from "../components/transcript/assistant-message";
import { detectCacheInvalidation, usesExplicitPromptCache } from "../components/transcript/cache-invalidation-marker";
import {
	ReadToolGroupComponent,
	readArgsHaveTarget,
	readArgsTargetInternalUrl,
} from "../components/transcript/read-tool-group";
import { ToolExecutionComponent } from "../components/transcript/tool-execution";
import { TtsrNotificationComponent } from "../components/transcript/ttsr-notification";
import { createUsageRowBlock } from "../components/transcript/usage-row";
import { UserMessageComponent } from "../components/transcript/user-message";
import { interruptHint } from "../shared";
import type { InteractiveModeContext, TodoPhase } from "../types";
import { asyncToolState, isLiveBackgroundTask } from "../utils/async-tool-state";
import { createAssistantMessageComponent } from "../utils/interactive-context-helpers";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	splitAssistantMessageToolTimeline,
} from "../utils/transcript-render-helpers";
import { StreamingRevealController } from "./streaming-reveal";
import { streamingStringKeysForTool, ToolArgsRevealController } from "./tool-args-reveal";
import { userEchoSignature } from "./transcript-composer";

/**
 * The slice of the interactive context this controller uses: 51 members of the
 * 215 `InteractiveModeContext` requires. See `CollabHostContext` for why the
 * full interface cannot be used as a parameter type: nothing but the real TUI
 * can satisfy it, so every test has to cast a stub into place unchecked.
 */
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
type StartedUserMessage = Extract<Extract<AgentSessionEvent, { type: "message_start" }>["message"], { role: "user" }>;
type ToolExecutionEndEvent = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;

const IRC_MESSAGE_VISIBLE_TTL_MS = 10_000;
/**
 * Concurrent IRC cards allowed in the transcript's live region. Cards land
 * below a still-live block (a running task), where they cannot commit to
 * native scrollback (commits are prefix-only) — every visible card inflates
 * the live region and pushes the live block's uncommitted rows above the
 * window top, where they are neither on screen nor in history. A swarm burst
 * (several agents coordinating at once) must therefore stay bounded: the
 * oldest live-region card retires as soon as a new one would exceed the cap.
 */
const MAX_LIVE_IRC_CARDS = 4;
const IDLE_RECAP_MIN_SECONDS = 1;
const IDLE_RECAP_MAX_SECONDS = 3600;

const RAW_PARTIAL_JSON_RENDERERS: Record<string, true> = { bash: true, edit: true, apply_patch: true };

function exposesRawPartialJson(toolName: string, rawInput: boolean, tool: unknown): boolean {
	if (rawInput) return true;
	if (RAW_PARTIAL_JSON_RENDERERS[toolName]) return true;
	if (tool === null || typeof tool !== "object") return false;
	if ("renderCall" in tool && typeof tool.renderCall === "function") return true;
	// Converting a tool's `renderCall` into a `view.renderCall` must not change this answer. Before
	// the conversion the branch above returned true; a tool whose call card is now described rather
	// than drawn reaches the same live preview from the same streamed arguments, so it keeps the same
	// treatment. Without this line a conversion silently narrows what the preview is given.
	const view = "view" in tool ? tool.view : undefined;
	if (view === null || typeof view !== "object") return false;
	return "renderCall" in view && typeof view.renderCall === "function";
}

type AgentSessionEventHandlers = {
	[E in AgentSessionEventKind]: (event: Extract<AgentSessionEvent, { type: E }>) => Promise<void>;
};

export class EventController {
	#lastReadGroup: ReadToolGroupComponent | undefined = undefined;
	// Count of visible assistant content blocks (rendered non-empty text/thinking)
	// already seen in the current streaming message. A newly appearing one breaks
	// the read run: the rendered reasoning/answer is a visual separator, so reads
	// after it start a fresh group. Empty/absent thinking — common when a model
	// emits one read per completion — does not break it, so a run of consecutive
	// reads collapses into one group even across completion boundaries.
	#lastVisibleBlockCount = 0;
	// Content indexes of the streaming message already counted as visible. A
	// block stays visible as it grows, so only the others are read on a delta:
	// reading a streamed block's text flattens it, which costs its whole length.
	#visibleBlocks = new Set<number>();
	#renderedCustomMessages = new Set<string>();
	#lastIntent: string | undefined = undefined;
	#backgroundTaskCallIds = new Set<string>();
	#projection: SessionProjectionEngine;
	#attachedSession: AgentSession | undefined;
	#readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
	#toolTimelineComponents = new Map<string, Component>();
	#postToolAssistantComponents = new Map<string, AssistantMessageComponent>();
	#lastAssistantComponent: AssistantMessageComponent | undefined = undefined;
	// Assistant component whose turn-ending error is currently mirrored in the
	// pinned banner. Its inline `Error: …` line is suppressed while pinned and
	// restored when the banner clears at the next `agent_start` (see
	// #handleMessageEnd / #handleAgentStart).
	#pinnedErrorComponent: AssistantMessageComponent | undefined = undefined;
	#retrySupersededAssistantComponents = new Map<string, AssistantMessageComponent>();
	#retrySupersededAssistantQueue: AssistantMessageComponent[] = [];
	/**
	 * What the current turn's retries have cost so far. Accumulated across
	 * `auto_retry_start` events and consumed once when they resolve, so the
	 * summary reports the whole sequence rather than the last attempt.
	 */
	#idleCompactionTimer?: NodeJS.Timeout;
	#idleRecapTimer?: NodeJS.Timeout;
	// In-flight ephemeral recap turn; aborted by #cancelIdleRecap when any
	// activity (new turn, compaction, editor draft) supersedes the idle recap.
	#idleRecapAbort?: AbortController;
	#ircExpiryTimers = new Map<string, NodeJS.Timeout>();
	// Insertion-ordered IRC cards not yet retired; values are the transcript
	// components each card contributed (see #retireIrcCard for the guard).
	#liveIrcCards = new Map<string, Component[]>();
	// Most recent `job` tool block whose result still had every watched job
	// running. Kept un-finalized (live) so the next `job` call displaces it —
	// one persistent poll instead of a stack of "waiting on N jobs" frames —
	// and sealed in place the moment anything else lands below it.
	#displaceablePollComponent: ToolExecutionComponent | undefined = undefined;
	// Most recent successful `todo` snapshot in the active turn. It stays live
	// across intervening tool output so a later `todo` update can replace the
	// old full list; the turn boundary seals the final snapshot as history.
	#displaceableTodoComponent: ToolExecutionComponent | undefined = undefined;
	// Most recent TTSR notification block. A new ttsr_triggered event merges its
	// rules into this block while it is still the (live-region) transcript tail.
	#lastTtsrNotification: TtsrNotificationComponent | undefined = undefined;
	#streamingReveal: StreamingRevealController;
	#toolArgsReveal: ToolArgsRevealController;
	#prevHideThinking = false;
	#handlers: AgentSessionEventHandlers;
	#terminalProgressActive = false;
	// How many of the session's recorded system-prompt invalidations have already
	// been named on a cache-miss marker. The record is cumulative, so the entries
	// past this index are the ones that happened since the last marker and are the
	// only ones that can explain the turn now finishing.
	#namedCacheInvalidations = 0;

	constructor(private ctx: EventControllerContext) {
		// Enhanced speech (`speech.enhanced`) rewrites blocks through the
		// tiny/smol role with this session's registry and credentials; the
		// vocalizer falls back to mechanical cleanup when unset. Tolerates
		// partial contexts (tests, minimal embeddings) by wiring null.
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
		this.#projection = new SessionProjectionEngine({
			getMessages: () => (this.#attachedSession ?? this.ctx.session)?.messages ?? [],
		});
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
			turn_start: async () => handleTurnStart(),
			turn_end: async e => handleTurnEnd(e),
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
				// Only do the expensive full resetDisplay when the effective
				// visibility actually changed. Auto-classification (e.g. high→medium)
				// emits thinking_level_changed without changing visibility — a full
				// terminal replay for those would be disruptive.
				if (hideThinking === this.#prevHideThinking) {
					this.ctx.ui.requestRender();
					return;
				}
				this.#prevHideThinking = hideThinking;
				// Propagate visibility to existing rendered messages.
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
				// A session-scoped cwd change (`/cwd` or the agent's `set_cwd` tool)
				// already updated SessionManager cwd + `getProjectDir()` inside
				// AgentSession.setCwd. The remaining re-root — reloading project
				// settings, plugins, capabilities, slash commands, the ssh tool, and
				// the system-prompt project framing for the new directory — lives in
				// applyCwdChange, the same path `/move` runs. Without this, tools moved
				// to the new dir but the agent's config and command surface stayed
				// pinned to the old one. applyCwdChange ends with statusLine.invalidate
				// + ui.requestRender, so those are covered here too.
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
		if (!this.#lastReadGroup || !this.ctx.chatContainer.children.includes(this.#lastReadGroup)) {
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
		this.#projection.recordToolCall(toolCallId, "read", normalizedArgs);
		const assistantComponent = this.ctx.streamingComponent ?? this.#lastAssistantComponent;
		if (assistantComponent) {
			this.#readToolCallAssistantComponents.set(toolCallId, assistantComponent);
		}
	}

	#clearReadToolCall(toolCallId: string): void {
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
		const view = toAssistantMessageView(segment);
		const existing = this.#postToolAssistantComponents.get(toolCallId);
		if (existing) {
			existing.updateContent(view);
			return existing;
		}
		const component = createAssistantMessageComponent(this.ctx, view);
		this.#postToolAssistantComponents.set(toolCallId, component);
		if (!this.#insertAfterTranscriptComponent(this.#toolTimelineComponents.get(toolCallId), component)) {
			this.ctx.chatContainer.addChild(component);
		}
		return component;
	}

	/** Component-scoped repaints for message_update: avoids a full-tree walk on
	 *  every provider delta while smooth reveal / tool-args reveal pace paints. */
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
		// Streamed JSON can deliver non-string `i` (object, number, boolean) before
		// schema validation; `?.` only guards null/undefined, so guard the type too.
		if (typeof intent !== "string") return;
		const trimmed = intent.trim();
		if (!trimmed || trimmed === this.#lastIntent) return;
		this.#lastIntent = trimmed;
		this.ctx.setWorkingMessage(`${trimmed}${interruptHint()}`);
	}

	subscribeToAgent(): void {
		this.attachTo(this.ctx.session);
	}

	/**
	 * Subscribe the transcript to `target`, tolerating an attach that lands
	 * mid-turn.
	 *
	 * Orphan-delta guard: attaching while an assistant message is already
	 * streaming means its `message_start` predates the attach. `message_update`
	 * carries the full accumulating message, so synthesize the missing start
	 * before the first orphaned update; every other handler is tolerant of
	 * unknown anchors (guarded by streamingComponent/pendingTools lookups).
	 *
	 * Both re-pointing paths come through here — viewing an agent, and `/new`
	 * or `/resume` swapping the session the UI displays — so neither grows its
	 * own copy of the guard.
	 */
	attachTo(target: AgentSession): void {
		this.#attachedSession = target;
		this.#projection.seedMessages();
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

	/**
	 * Clear every transcript-anchored/turn-scoped piece of state. Used by the
	 * session focus proxy when re-pointing the transcript at another session:
	 * components, timers, and stream-reveal state all reference the previous
	 * session's transcript and must not bleed into the new one.
	 */
	resetTranscriptAnchors(): void {
		this.#resetReadGroup();
		this.#lastVisibleBlockCount = 0;
		this.#visibleBlocks.clear();
		this.#renderedCustomMessages.clear();
		this.#lastIntent = undefined;
		this.#toolTimelineComponents.clear();
		this.#postToolAssistantComponents.clear();
		this.#backgroundTaskCallIds.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#projection.reset();
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

		// Each handler explicitly requests a render (or leaves it out, when it
		// changed nothing visible). A blanket pre-render fired on every event —
		// including the ~hundreds of `message_update` deltas per streaming turn —
		// doubled the paint rate: the pre-render's frame fires while the handler
		// is awaiting, then the handler's own final requestRender schedules a
		// second identical frame. Removing it lets the render cadence follow real
		// state changes rather than event volume (issue #4353).
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

	/**
	 * The reason for the most recent unreported system-prompt invalidation, or
	 * `undefined` when nothing new was recorded since the last marker.
	 *
	 * The session's record is cumulative and append-only, so the entries past
	 * `#namedCacheInvalidations` are exactly the ones that happened during the turn
	 * that just finished. The LAST of those is reported: when several land in one
	 * turn (a cwd change also refreshes secrets, for instance) the final rebuild is
	 * the one whose bytes the cold request actually carried. The index advances
	 * whether or not a marker renders, so a stale reason can never be attached to a
	 * later, unrelated cold turn.
	 *
	 * Optional access: controller tests build partial ctx mocks with no session.
	 */
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

	/** The prompt the running turn is working on; it carries the follow's glow
	 *  from agent_start to agent_end (see UserMessageComponent.setWorking). */
	#workingUserMessage: UserMessageComponent | undefined;

	/** Move the working glow to the newest user prompt in the transcript. */
	#armWorkingUserMessage(): void {
		this.#workingUserMessage?.setWorking(false);
		this.#workingUserMessage = undefined;
		// Optional access: controller test harnesses build partial ctx mocks
		// without a chat container; with no transcript there is nothing to glow.
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
		this.#readToolCallAssistantComponents.clear();
		this.#projection.clearTurnToolState();
		this.#projection.clearRetryTrace();
		this.#resetReadGroup();
		this.#resolveDisplaceableTodo();
		this.#lastAssistantComponent = undefined;
		// the banner, so the error stays in history once the banner is gone.
		this.#pinnedErrorComponent?.setErrorPinned(false);
		this.#pinnedErrorComponent = undefined;
		this.ctx.clearPinnedError();
		this.#stopRetryLoader();
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		this.ctx.statusLine.markActivityStart();
		this.#setTerminalProgress(true);
		// The turn opens with the model reasoning before any token streams.
		setShimmerActivity("thinking");
		this.ctx.ensureLoadingAnimation();
		this.ctx.refreshComposerShortcuts();
		this.ctx.ui.requestRender();
	}

	async #handleMessageStart(event: Extract<AgentSessionEvent, { type: "message_start" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		const { message } = event;
		if (message.role === "hookMessage" || message.role === "custom") {
			this.#startCustomMessage(message);
		} else if (message.role === "user") {
			this.#startUserMessage(message);
		} else if (message.role === "fileMention") {
			this.#resetReadGroup();
			this.ctx.addMessageToChat(message);
			this.ctx.ui.requestRender();
		} else if (message.role === "assistant") {
			this.#startAssistantMessage(message);
		}
	}

	/**
	 * Claims a custom message's transcript slot: its signature the first time the message starts, undefined once it
	 * has been shown.
	 */
	#claimCustomMessage(message: CustomMessage | HookMessage): string | undefined {
		const signature = `${message.role}:${message.customType}:${message.timestamp}`;
		if (this.#renderedCustomMessages.has(signature)) return undefined;
		this.#renderedCustomMessages.add(signature);
		return signature;
	}

	#startCustomMessage(message: CustomMessage | HookMessage): void {
		if (this.#claimCustomMessage(message) === undefined) return;
		this.#resetReadGroup();
		this.ctx.addMessageToChat(message);
		// Queued custom-message chips are derived from the agent queue; refresh the pending bar when the queued custom
		// message is consumed so the chip disappears immediately.
		if (message.role === "custom" && readQueueChipText(message.details)) this.ctx.updatePendingMessagesDisplay();
		this.ctx.ui.requestRender();
	}

	#startUserMessage(message: StartedUserMessage): void {
		const signature = userEchoSignature(this.ctx.getUserMessageText(message), countInlineImages(message.content));
		this.#resetReadGroup();
		this.#resolveDisplaceablePoll();
		this.#resolveDisplaceableTodo();
		const wasLocallySubmitted = this.#settleSubmittedEcho(message, signature);
		if (!message.synthetic) {
			// Clear the editor only when the submission did not originate from a local submission (optimistic or
			// queued-while-streaming). Both local paths already cleared the editor at submit time; clearing again here
			// would race with the next prompt being typed while the previous large redraw lands and erase the
			// in-progress draft (#783).
			if (!wasLocallySubmitted) this.ctx.editor.setText("");
			this.ctx.updatePendingMessagesDisplay();
			// A prompt landing mid-turn (queued while streaming) becomes the one being worked: move the glow so it
			// always sits on the newest prompt.
			if (this.ctx.session?.isStreaming) this.#armWorkingUserMessage();
		}
		this.ctx.ui.requestRender();
	}

	/**
	 * Settles a user message against what this client drew at submit time and returns whether the message came from
	 * a local submission. A matching optimistic echo stays, an unmatched one gives way to the message, and a message
	 * from elsewhere is appended.
	 */
	#settleSubmittedEcho(message: StartedUserMessage, signature: string): boolean {
		const optimisticSignature = this.ctx.optimisticUserMessageSignature;
		const matchedLocalSubmission = this.ctx.locallySubmittedUserSignatures.delete(signature);
		if (optimisticSignature === signature) {
			this.ctx.clearOptimisticUserMessage();
			return true;
		}
		if (optimisticSignature !== undefined && !matchedLocalSubmission) {
			this.ctx.replaceOptimisticUserMessage(message);
			return true;
		}
		// Append synchronously: #emit dispatches to this listener fire-and-forget (see AgentSession.#emit), so any
		// await between the user message_start and addMessageToChat lets later events (assistant message_start, tool
		// execution start/end) append their components first and scramble transcript order / live-region block
		// boundaries. addMessageToChat materializes clickable image links via the synchronous putBlobSync fallback, so
		// no await is needed here.
		this.ctx.addMessageToChat(message);
		return matchedLocalSubmission;
	}

	#startAssistantMessage(message: AssistantMessage): void {
		this.#lastVisibleBlockCount = 0;
		this.#visibleBlocks.clear();
		this.#projection.recordAssistantMessageToolCalls(message);
		const component = createAssistantMessageComponent(this.ctx);
		this.ctx.streamingComponent = component;
		this.ctx.streamingMessage = message;
		this.ctx.chatContainer.addChild(component);
		const timeline = splitAssistantMessageToolTimeline(message);
		this.#streamingReveal.begin(component, toAssistantMessageView(timeline.beforeTools));
		this.ctx.ui.requestRender();
	}

	async #handleIrcMessage(event: Extract<AgentSessionEvent, { type: "irc_message" }>): Promise<void> {
		const signature = this.#claimCustomMessage(event.message);
		if (signature === undefined) return;
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

	/**
	 * Remove an expired/evicted IRC card — but only while it still sits below a
	 * live block, where its rows cannot have entered native scrollback. Once
	 * everything above it has finalized, its rows may already be committed;
	 * removing them then is an interior deletion of the committed prefix, which
	 * the engine can only repair by recommitting every row below the gap —
	 * exactly the duplicated-block artifact this guard exists to prevent. Such
	 * a card simply stays: it is final history, and the window scrolls past it.
	 */
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

	/** Evict oldest live-region cards beyond {@link MAX_LIVE_IRC_CARDS}. */
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

	/**
	 * Resolve the pending displaceable poll block before the next block lands.
	 * A follow-up `job` call displaces it — the stale "waiting on N jobs" frame
	 * is removed so repeated polls read as one persistent poll — while anything
	 * else seals it in place as final history. Removal is gated on none of the
	 * block's rows having entered native scrollback: rows already on the tape
	 * are immutable visual history, so a scrolled-off poll seals instead of
	 * being retracted.
	 */
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
		// Sealing stops the waiting-poll spinner and freezes the block (for a
		// just-removed component it only clears the animation timer).
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

	/**
	 * Adopt a rebuilt-tail todo snapshot as the controller's tracked live
	 * snapshot. Used by rebuild paths (settings/extensions overlay close, focus
	 * attach, /resume) to preserve displacement continuity when a turn is still
	 * active — without this, the next same-turn `todo` update would stack
	 * another panel because the controller's tracker was reset before rebuild.
	 * Drops the candidate when it is no longer a displaceable todo.
	 */
	inheritDisplaceableTodo(component: ToolExecutionComponent | null | undefined): void {
		this.#displaceableTodoComponent = component?.canBeDisplacedBy("todo") ? component : undefined;
	}

	async #handleNotice(event: Extract<AgentSessionEvent, { type: "notice" }>): Promise<void> {
		if (event.source === SECRET_SPEND_NOTICE_SOURCE) {
			// Its own block rather than `showStatus`, which COALESCES consecutive status lines: one
			// assistant message can issue several tool calls, every block for them is already in the
			// transcript before the first one executes, so nothing is appended between two spends and
			// the second line would overwrite the first — three credentials spent, one named. A
			// credential per line is the whole point. The message already reads as a sentence, so it
			// skips the generic `source: text` prefix.
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

	async #handleMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		// Living shimmer: a text delta means the model is writing (streaming
		// comet); a thinking delta means it is reasoning (ponder breath). Not
		// every message_update carries a delta (e.g. a toolCall-finalize update),
		// so guard — those leave the activity as-is.
		const streamDelta = event.assistantMessageEvent;
		if (streamDelta?.type === "text_delta") setShimmerActivity("streaming");
		else if (streamDelta?.type === "thinking_delta") setShimmerActivity("thinking");
		vocalizeDelta(event);
		const { message } = event;
		const streamingComponent = this.ctx.streamingComponent;
		if (streamingComponent && message.role === "assistant")
			this.#updateStreamingAssistant(streamingComponent, message);
	}

	/** Projects one streamed snapshot of the assistant message: its prose, its tool-call previews and the working message. */
	#updateStreamingAssistant(streamingComponent: AssistantMessageComponent, message: AssistantMessage): void {
		this.#projection.recordAssistantMessageToolCalls(message);
		const smoothStreaming = this.ctx.settings.get("display.smoothStreaming");
		const repaintTargets = new Set<Component>();
		if (this.ctx.noteDisplayableThinkingContent(message)) {
			streamingComponent.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
			this.#streamingReveal.resyncVisibility();
			repaintTargets.add(streamingComponent);
		}
		this.ctx.streamingMessage = message;
		const timeline = splitAssistantMessageToolTimeline(message);
		this.#streamingReveal.setTarget(toAssistantMessageView(timeline.beforeTools));
		this.#noteVisibleBlocks(message, smoothStreaming, streamingComponent, repaintTargets);

		// Content blocks stream sequentially: a toolCall block can only begin
		// after every preceding thinking/text block has closed, and the
		// reveal's setTarget above force-completes the visible text for
		// toolCall messages. Finalize the assistant block now instead of at
		// message_end so the transcript's commit-safe run can extend through
		// it into the streaming tool preview below — otherwise a long args
		// stream (a big write/edit/eval) sits below a still-live block and
		// can never reach native scrollback: the head of the preview is
		// neither committed nor on screen and the transcript reads as cut.
		if (message.content.some(content => content.type === "toolCall")) {
			streamingComponent.markTranscriptBlockFinalized();
			repaintTargets.add(streamingComponent);
		}
		for (const content of message.content) {
			if (content.type === "toolCall") this.#previewStreamingToolCall(content, smoothStreaming, repaintTargets);
		}
		for (const [toolCallId, segment] of timeline.afterToolCalls) {
			const segmentComponent = this.#upsertPostToolAssistantSegment(toolCallId, segment);
			if (segmentComponent) repaintTargets.add(segmentComponent);
		}
		this.#updateWorkingMessageFromToolCalls(message.content);

		// Smooth assistant reveal paints on its own 30fps timer; repainting the
		// streaming block on every provider delta duplicated full-tree walks
		// while the revealed prefix was unchanged between ticks (issue #4377).
		if (!smoothStreaming) repaintTargets.add(streamingComponent);
		this.#repaintMessageUpdateComponents(repaintTargets);
	}

	/**
	 * Counts the streaming message's visible blocks. A newly visible block breaks the read run, and repaints the
	 * streaming block unless it is the first one: a new visible block after the first (e.g. thinking closed, next text
	 * block) changes the transcript layout, while the first block's growth is paced by the reveal timer when smooth
	 * streaming is on.
	 */
	#noteVisibleBlocks(
		message: AssistantMessage,
		smoothStreaming: boolean,
		streamingComponent: AssistantMessageComponent,
		repaintTargets: Set<Component>,
	): void {
		const visibleBlockCount = this.#countVisibleBlocks(message.content);
		if (visibleBlockCount <= this.#lastVisibleBlockCount) return;
		if (!smoothStreaming || this.#lastVisibleBlockCount >= 1) repaintTargets.add(streamingComponent);
		this.#resetReadGroup();
		this.#lastVisibleBlockCount = visibleBlockCount;
	}

	/** Mounts or updates the preview of one streamed tool call. */
	#previewStreamingToolCall(content: ToolCall, smoothStreaming: boolean, repaintTargets: Set<Component>): void {
		if (content.name === "read" && this.#previewStreamingRead(content, repaintTargets)) return;
		// Preserve the raw partial JSON only for renderers that need to surface fields before the JSON object closes.
		// Bash uses this to show inline env assignments during streaming instead of popping them in at completion.
		// While the JSON is still open, ToolArgsRevealController paces the
		// reveal (write/edit/bash previews grow smoothly when a slow provider
		// delivers large batches); once it closes, the final args render
		// as-is — mirroring how assistant text snaps at message_end.
		const partialJson = getStreamingPartialJson(content);
		const tool = this.ctx.viewSession.getToolByName(content.name);
		let renderArgs: Record<string, unknown> = content.arguments;
		if (partialJson) {
			const rawInput = content.customWireName !== undefined;
			renderArgs = this.#toolArgsReveal.setTarget(content.id, partialJson, {
				rawInput,
				exposeRawPartialJson: exposesRawPartialJson(content.name, rawInput, tool),
				streamingStringKeys: streamingStringKeysForTool(content.name, rawInput),
				// The preview renders arguments that have NOT reached the tool yet, so
				// they still carry `§handle` fragments; expansion at seam 1 happens
				// just before execution. Without the codec here a streaming write or
				// edit preview shows the handle instead of the text it stands for.
				argot: this.ctx.viewSession.getArgotSession?.(),
			});
		} else {
			this.#toolArgsReveal.finish(content.id);
		}
		if (this.ctx.settledToolCalls.has(content.id)) return;
		const pending = this.ctx.pendingTools.get(content.id);
		if (!pending) {
			repaintTargets.add(this.#mountStreamingToolCall(content, renderArgs, tool));
			return;
		}
		pending.updateArgs(renderArgs, content.id);
		this.#toolArgsReveal.bind(content.id, pending);
		// Paced args reveal schedules its own component-scoped paints.
		if (!partialJson || !smoothStreaming) repaintTargets.add(pending);
	}

	/**
	 * Routes a streamed `read` call into the read group; false when it targets an internal URL and falls through to a
	 * tool card. A call whose path has not streamed yet waits, since mounting either component now would lock the read
	 * into the wrong shape.
	 */
	#previewStreamingRead(content: ToolCall, repaintTargets: Set<Component>): boolean {
		if (!readArgsHaveTarget(content.arguments)) return true;
		if (readArgsTargetInternalUrl(content.arguments)) return false;
		if (this.ctx.settledToolCalls.has(content.id)) return true;
		if (!this.ctx.pendingTools.has(content.id)) this.#resolveDisplaceablePoll(content.name);
		this.#trackReadToolCall(content.id, content.arguments);
		const pending = this.ctx.pendingTools.get(content.id);
		if (pending) {
			pending.updateArgs(content.arguments, content.id);
			repaintTargets.add(pending);
			return true;
		}
		const group = this.#getReadGroup();
		group.updateArgs(content.arguments, content.id);
		this.ctx.pendingTools.set(content.id, group);
		this.#toolTimelineComponents.set(content.id, group);
		repaintTargets.add(group);
		return true;
	}

	/** Adds the tool card of a streamed tool call to the transcript. */
	#mountStreamingToolCall(
		content: ToolCall,
		renderArgs: Record<string, unknown>,
		tool: AgentTool | undefined,
	): ToolExecutionComponent {
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
		return component;
	}

	/**
	 * Shows the intent of the last streamed tool call that states one. A later call's intent replaces an earlier one's,
	 * so the calls before it are not read.
	 */
	#updateWorkingMessageFromToolCalls(content: AssistantMessage["content"]): void {
		for (let i = content.length - 1; i >= 0; i--) {
			const block = content[i]!;
			if (block.type !== "toolCall") continue;
			const intent = this.#streamedToolCallIntent(block);
			if (intent !== undefined) {
				this.#updateWorkingMessageFromIntent(intent);
				return;
			}
		}
	}

	/**
	 * The non-blank intent a streamed tool call states: its intent field when it has one, else what its tool derives
	 * from its arguments.
	 */
	#streamedToolCallIntent(block: ToolCall): string | undefined {
		const args = block.arguments;
		if (!args || typeof args !== "object") return undefined;
		if (INTENT_FIELD in args) {
			const intent: unknown = args[INTENT_FIELD];
			return typeof intent === "string" && intent.trim() ? intent : undefined;
		}
		const tool = this.ctx.viewSession.getToolByName(block.name);
		if (typeof tool?.intent !== "function") return undefined;
		try {
			return tool.intent(args as never)?.trim() || undefined;
		} catch {
			// intent function must never break the UI
			return undefined;
		}
	}

	/** Visible (non-placeholder) text and thinking blocks of the streaming message seen so far. */
	#countVisibleBlocks(content: AssistantMessage["content"]): number {
		for (let i = 0; i < content.length; i++) {
			if (this.#visibleBlocks.has(i)) continue;
			const block = content[i]!;
			if (
				(block.type === "text" && canonicalizeMessage(block.text)) ||
				(block.type === "thinking" && canonicalizeMessage(block.thinking))
			) {
				this.#visibleBlocks.add(i);
			}
		}
		return this.#visibleBlocks.size;
	}

	async #handleMessageEnd(event: Extract<AgentSessionEvent, { type: "message_end" }>): Promise<void> {
		const { message } = event;
		if (message.role === "user") return;
		if (message.role === "assistant") this.#endAssistantMessage(message);
		this.ctx.ui.requestRender();
	}

	#endAssistantMessage(message: AssistantMessage): void {
		if (this.ctx.noteDisplayableThinkingContent(message) && this.ctx.streamingComponent) {
			this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
			this.#streamingReveal.resyncVisibility();
		}
		vocalizeMessageEnd(message);
		const streamingComponent = this.ctx.streamingComponent;
		if (streamingComponent) {
			this.#finalizeStreamingAssistant(streamingComponent, message);
		} else if (endsInShownError(message)) {
			// The turn died before any streaming began (the provider rejected the request at setup: unsupported
			// thinking effort, bad model id, auth), so there is no streaming component to hold an inline error row.
			// Without this branch the submitted prompt vanished with no working line, no banner, and no clue. Pin the
			// error above the editor exactly like a mid-stream failure; the next turn's agent_start clears it.
			this.ctx.showPinnedError(message.errorMessage);
		}
	}

	/** Freezes the streamed assistant block at the message's final content and releases the streaming slot. */
	#finalizeStreamingAssistant(component: AssistantMessageComponent, message: AssistantMessage): void {
		this.ctx.streamingMessage = message;
		this.#streamingReveal.stop();
		this.#toolArgsReveal.flushAll();
		const timeline = splitAssistantMessageToolTimeline(this.#displayedEndOfTurn(message));
		component.updateContent(toAssistantMessageView(timeline.beforeTools));
		this.#settlePendingToolCalls(message.stopReason);
		this.#noteTurnUsage(component, message);
		component.markTranscriptBlockFinalized();
		let lastSegmentComponent: AssistantMessageComponent | undefined;
		for (const [toolCallId, segment] of timeline.afterToolCalls) {
			const segmentComponent = this.#upsertPostToolAssistantSegment(toolCallId, segment);
			if (!segmentComponent) continue;
			segmentComponent.markTranscriptBlockFinalized();
			lastSegmentComponent = segmentComponent;
		}
		this.#lastAssistantComponent = lastSegmentComponent ?? component;
		if (settings.get("display.showTokenUsage") && assistantUsageIsBilled(message.usage)) {
			this.ctx.chatContainer.addChild(createUsageRowBlock(message.usage, message.duration, message.ttft));
		}
		this.ctx.streamingComponent = undefined;
		this.ctx.streamingMessage = undefined;
		// Pin a turn-ending provider error (e.g. Anthropic content-filter block) above the editor so it survives
		// transcript scroll; the next turn's agent_start clears it. The turn's stop reason is on its HEAD segment, so
		// the streamed block, not a post-tool segment, is the one whose inline `Error: …` line the banner suppresses:
		// post-tool segments have no stop reason, and pinning one left the head's inline error under a banner already
		// showing it.
		if (endsInShownError(message)) {
			component.setErrorPinned(true);
			this.#pinnedErrorComponent = component;
			this.ctx.showPinnedError(message.errorMessage);
		}
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();
	}

	/**
	 * The ended message as the transcript draws it. A silent abort (an internal transition) or an abort a TTSR rewind
	 * replaces renders as a clean stop, for display only: the persisted stop reason stays, and the marker on
	 * `errorMessage` drives replay-side suppression. Any other abort is stamped with its operator-facing label.
	 */
	#displayedEndOfTurn(message: AssistantMessage): AssistantMessage {
		if (message.stopReason !== "aborted") return message;
		if (isSilentAbort(message) || this.ctx.viewSession.isTtsrAbortPending) return { ...message, stopReason: "stop" };
		// A user interrupt (Esc) holds USER_INTERRUPT_LABEL on errorMessage, threaded through the AbortController, and
		// keeps it verbatim; any other abort with no threaded reason falls back to the retry-aware generic label.
		// AgentSession.#handleAgentEvent already stamped SILENT_ABORT_MARKER for the plan-compact transition before
		// this controller ran, so an abort reaching this line is not a silent internal transition.
		message.errorMessage = resolveAbortLabel(message, this.ctx.viewSession.retryAttempt);
		return message;
	}

	/**
	 * Settles the tool calls still pending when a turn ends. A completed turn's calls have final arguments. An aborted
	 * or failed turn (abort, error, TTSR rewind) never runs its calls, so each is sealed to stop animating instead of
	 * pinning the live region while a retry streams fresh blocks below it, and the waiting poll freezes in place.
	 * Background task calls keep updating.
	 */
	#settlePendingToolCalls(stopReason: AssistantMessage["stopReason"]): void {
		if (stopReason !== "aborted" && stopReason !== "error") {
			for (const [toolCallId, component] of this.ctx.pendingTools.entries()) component.setArgsComplete(toolCallId);
			return;
		}
		for (const [toolCallId, component] of this.ctx.pendingTools.entries()) {
			if (!this.#backgroundTaskCallIds.has(toolCallId) && component instanceof ToolExecutionComponent) {
				component.seal();
			}
		}
		this.#resolveDisplaceablePoll();
	}

	/**
	 * Records the turn's usage and flags a prompt-cache invalidation: when the previous turn cached a meaningful prefix
	 * and this request read none of it back, the block is marked with the cause the session recorded, if any. A bare
	 * token count shows the conversation was re-read at full price without stating what caused it.
	 */
	#noteTurnUsage(component: AssistantMessageComponent, message: AssistantMessage): void {
		const { usage } = message;
		if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
			if (settings.get("display.cacheMissMarker")) {
				const invalidation = detectCacheInvalidation(
					this.ctx.lastAssistantUsage,
					usage,
					this.#takeCacheInvalidationCause(),
					{ explicitCache: usesExplicitPromptCache(message.api, message.model) },
				);
				if (invalidation) component.setCacheInvalidation(invalidation);
			}
			this.ctx.lastAssistantUsage = usage;
		}
	}

	async #handleToolExecutionStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		// Living shimmer: a tool is executing — the head scans back and forth.
		setShimmerActivity("tool");
		this.#updateWorkingMessageFromIntent(event.intent);
		this.#resolveDisplaceablePoll(event.toolName);
		this.#projection.recordToolCall(event.toolCallId, event.toolName, event.args);
		this.#projection.markToolCallRunning(event.toolCallId, true);
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
			// The tool is about to run, so its arguments are final and validated.
			// A pending component created while args streamed (message_update) may
			// still show a mid-reveal prefix — or, when the closing full-args
			// `message_update` never lands (smooth-streaming off leaving the
			// throttled `arguments` stale, an owned-dialect projector, or a
			// superseded/aborted turn that still executes the call), a stale body
			// the result render then freezes at its `…` placeholder. Reconcile the
			// authoritative args here and drop any live reveal so a late tick can't
			// re-truncate them: tool_execution_start is the one event every
			// execution path emits with the full args immediately before the result.
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
			// A final async snapshot is terminal only for a parked background
			// block (the call already returned and was kept alive for its jobs).
			// While the call is still executing — a mixed blocking+async task
			// call whose jobs settle before its blocking subset — treat it as a
			// partial frame: `tool_execution_end` still owns the terminal result.
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
				this.#projection.markToolCallRunning(event.toolCallId, false);
				this.#projection.markToolCallSettled(event.toolCallId);
			}
			this.ctx.ui.requestRender();
		}
	}

	async #handleToolExecutionEnd(event: ToolExecutionEndEvent): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		if (this.ctx.settledToolCalls.has(event.toolCallId)) return;
		this.#projection.markToolCallRunning(event.toolCallId, false);
		if (event.toolName !== "task" || asyncToolState(event.result.details) !== "running") {
			this.ctx.settledToolCalls.add(event.toolCallId);
			this.#projection.markToolCallSettled(event.toolCallId);
		}
		if (event.toolName === "read") this.#endReadToolCall(event);
		else this.#endToolCall(event);
		if (event.toolName === "todo") this.#showTodoOutcome(event);
		else if (event.toolName === "resolve" && !event.isError) {
			await this.#applyResolvedPlan(event.result.details as ResolveToolDetails | undefined);
		}
	}

	/**
	 * Settles a read call. Its images inline into the assistant block that issued it; a call that inlined nothing and
	 * mounted no card of its own lands its result in the read group.
	 */
	#endReadToolCall(event: ToolExecutionEndEvent): void {
		const { toolCallId } = event;
		const inlinedImages = this.#inlineReadToolImages(toolCallId, event.result);
		let component = this.ctx.pendingTools.get(toolCallId);
		if (!component && !inlinedImages) {
			const group = this.#getReadGroup();
			const args = this.#projection.findToolCallArgs(toolCallId) as Record<string, unknown> | undefined;
			if (args) group.updateArgs(args, toolCallId);
			component = group;
		}
		component?.updateResult({ ...event.result, isError: event.isError }, false, toolCallId);
		this.ctx.pendingTools.delete(toolCallId);
		this.#clearReadToolCall(toolCallId);
		this.ctx.ui.requestRender();
	}

	/** Settles a non-read call's card; a live background task keeps its card pending for later updates. */
	#endToolCall(event: ToolExecutionEndEvent): void {
		const { toolCallId, toolName } = event;
		const component = this.ctx.pendingTools.get(toolCallId);
		if (!component) return;
		const isBackgroundTask = isLiveBackgroundTask(toolName, event.result.details);
		component.updateResult({ ...event.result, isError: event.isError }, isBackgroundTask, toolCallId);
		if (isBackgroundTask) {
			this.#backgroundTaskCallIds.add(toolCallId);
		} else {
			this.ctx.pendingTools.delete(toolCallId);
			this.#backgroundTaskCallIds.delete(toolCallId);
		}
		if (component instanceof ToolExecutionComponent && component.isDisplaceableBlock()) {
			this.#trackDisplaceableBlock(toolName, component);
		}
		this.ctx.ui.requestRender();
	}

	/**
	 * Tracks a displaceable block so the next call of its kind replaces it: a waiting job poll for the next `job` call,
	 * a todo panel for the next successful todo update. A successful update supersedes the previous live todo panel; a
	 * failed one never gets here (canBeDisplacedBy("todo") is false for an errored result), so the last good panel
	 * stays on screen.
	 */
	#trackDisplaceableBlock(toolName: string, component: ToolExecutionComponent): void {
		if (toolName === "job" && component.canBeDisplacedBy("job")) {
			this.#displaceablePollComponent = component;
			return;
		}
		if (toolName !== "todo" || !component.canBeDisplacedBy("todo")) return;
		const previous = this.#displaceableTodoComponent;
		if (previous && previous !== component && previous.isDisplaceableBlock()) {
			this.#displaceableTodoComponent = undefined;
			if (this.ctx.chatContainer.isBlockUncommitted(previous)) this.ctx.chatContainer.removeChild(previous);
			previous.seal();
		}
		this.#displaceableTodoComponent = component;
	}

	/** Updates the todo display from a successful todo call, or warns with the first line of a failed one that ran. */
	#showTodoOutcome(event: ToolExecutionEndEvent): void {
		if (!event.isError) {
			const details = event.result.details as { phases?: TodoPhase[] } | undefined;
			if (details?.phases) this.ctx.setTodos(details.phases);
			return;
		}
		// A never-ran placeholder is not a todo failure. The turn died in transport before the call was dispatched,
		// which the error card and the batch ledger already state once; repeating it per `todo` call in the dead batch
		// adds nothing and buries the one message that states the real cause.
		if (toolResultNeverRan(event.result.details)) return;
		// A warning is a notice, not a report. The result text holds the error, the plan's standing and the open
		// work, and the card under this line draws all three; the notice takes the first line and leaves the ledger
		// to the card.
		const text = event.result.content.find((content): content is TextContent => content.type === "text")?.text;
		const headline = text?.split("\n", 1)[0]?.trim();
		this.ctx.showWarning(
			`Todo update failed${headline ? `: ${headline}` : ". Progress may be stale until todo succeeds."}`,
		);
	}

	/** Applies the plan a resolve call approved through plan_approval. */
	async #applyResolvedPlan(details: ResolveToolDetails | undefined): Promise<void> {
		if (details?.sourceToolName !== "plan_approval" || details.action !== "apply") return;
		const planDetails = details.sourceResultDetails as PlanApprovalDetails | undefined;
		if (planDetails) await this.ctx.handlePlanApproval(planDetails);
	}

	async #handleAgentEnd(_event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
		// A superseded agent_end: the agent is already streaming a fresh turn, so
		// this event belongs to a turn that has already been replaced. The session
		// dispatches to listeners fire-and-forget across an async extension-emit hop
		// (#emitSessionEvent), so an interrupted turn's agent_end can land AFTER the
		// resumed turn's agent_start (e.g. any post-turn agent.continue()). Running
		// the turn-end teardown now would stop the loader the live turn just created,
		// leaving "Working…" gone while the agent keeps running. The live turn owns
		// the loader and finalizes it at its own agent_end (isStreaming === false by
		// then). Mirrors the collab guest's !isStreaming loader reconciler.
		if (this.ctx.session.isStreaming) return;

		await this.#finishAgentEnd();
	}

	async #finishAgentEnd(): Promise<void> {
		this.#workingUserMessage?.setWorking(false);
		this.#workingUserMessage = undefined;
		this.#setTerminalProgress(false);
		// Living shimmer: the turn is over — return to the resting state so the
		// next turn opens fresh from `thinking` rather than mid-motion.
		setShimmerActivity("idle");
		this.ctx.statusLine.markActivityEnd();
		// The turn's tools may have moved the tree; the marker is otherwise up to GIT_STATUS_MAX_AGE_MS old.
		this.ctx.statusLine.refreshGitStatus();
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
				// A foreground tool still pending at turn end never delivered a result;
				// seal it so it freezes (and stops animating) rather than lingering in
				// the transcript live region as a streaming preview until the next thaw.
				const component = this.ctx.pendingTools.get(toolCallId);
				// A foreground read still pending at turn end shares a group component
				// keyed by every read's id; seal it too so a never-delivered read does
				// not keep the group live (and pinning the live region) indefinitely.
				if (component instanceof ToolExecutionComponent || component instanceof ReadToolGroupComponent) {
					component.seal();
				}
				this.ctx.pendingTools.delete(toolCallId);
				// The card is frozen history now. A late replay of this call's
				// `tool_execution_start` (collab resync, focus re-attach, an
				// aborted-turn placeholder) must not build a fresh live one beside it.
				this.ctx.settledToolCalls.add(toolCallId);
			}
		}
		const filtered = new Set<string>();
		for (const toolCallId of this.#backgroundTaskCallIds) {
			if (this.ctx.pendingTools.has(toolCallId)) filtered.add(toolCallId);
		}
		this.#backgroundTaskCallIds = filtered;
		this.#projection.clearTurnToolState();
		this.#readToolCallAssistantComponents.clear();
		this.#toolTimelineComponents.clear();
		this.#postToolAssistantComponents.clear();
		this.#resetReadGroup();
		// The turn is over: nothing else lands this turn, so the waiting poll is
		// final history — seal it instead of letting its spinner tick while idle.
		this.#resolveDisplaceablePoll();
		this.#resolveDisplaceableTodo();
		this.#lastAssistantComponent = undefined;
		this.ctx.refreshComposerShortcuts();
		this.ctx.ui.requestRender();
		this.#scheduleIdleCompaction();
		this.#scheduleIdleRecap();
		this.sendCompletionNotification();
	}

	/**
	 * Tear down the live "Working…" loader: stop its animation timer AND clear the
	 * reference. A transient overlay (auto-compaction / auto-retry) can remove the
	 * loader from the container while leaving `ctx.loadingAnimation` set, so the
	 * resumed turn's `agent_start` →
	 * `ensureLoadingAnimation()` (guarded by `if (!this.loadingAnimation)`) skipped
	 * re-adding it and the spinner vanished while the agent kept streaming. Nulling
	 * the reference here lets the next `agent_start` recreate and re-attach it.
	 */
	#stopWorkingLoader(): void {
		this.ctx.clearWorkingLoader();
	}

	/**
	 * Restore the live "Working…" loader when a streaming event lands after a
	 * transient status overlay cleared the container. Focus mode dispatches events
	 * for `viewSession`, so key the reconciler on that session, not the main one.
	 */
	#ensureWorkingLoaderWhileStreaming(): void {
		if (!this.ctx.viewSession.isStreaming) return;
		if (this.ctx.autoCompactionLoader || this.ctx.retryLoader) return;
		this.ctx.ensureLoadingAnimation();
	}

	/**
	 * Trailing Esc hint for live maintenance loaders. While an agent is
	 * focused, Esc returns to main instead of cancelling its maintenance
	 * (#2819), so the loader drops the hint entirely rather than advertise a
	 * cancel that no longer happens. Includes the leading space so the focused
	 * label carries no dangling whitespace.
	 */
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
						: event.reason === "provider_switch"
							? "Provider switch, "
							: "";
		const actionLabel = compactionActionLabel(true, resolveCompactionKind(this.ctx.viewSession));
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
			// When history collapses behind the summary divider, the frame
			// shrinks far below the committed row count; without clearing, the
			// differential renderer's "duplication, never loss" resync repaints
			// the whole collapsed transcript (welcome box included) BELOW the
			// stale pre-compaction scrollback. Compaction is an intentional
			// transcript replacement. With collapse disabled, the rebuilt transcript
			// keeps the full history, so the resync handles it and scrollback stays.
			if (settings.get("display.collapseCompacted")) {
				this.ctx.ui.requestRender(true, { clearScrollback: true });
			} else {
				this.ctx.ui.requestRender();
			}
		} else if (event.errorMessage) {
			this.ctx.showWarning(event.errorMessage);
		} else if (event.skipped) {
			// Benign skip: no model selected, no candidate models available, or nothing
			// to compact yet. Not a failure, so suppress the warning.
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
		this.#projection.recordAutoRetryStart(event);
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
		this.#stopRetryLoader();
		setShimmerActivity("thinking");
		const { summary, error } = this.#projection.recordAutoRetryEnd(event);
		if (event.success) {
			this.#applyRetryRecoveries(event.recoveredErrors ?? []);
			this.#clearRetrySupersededAssistantComponents();
			if (summary) this.ctx.showStatus(summary);
		} else {
			this.#clearRetrySupersededAssistantComponents();
			if (error) this.ctx.showError(error);
		}
		this.#ensureWorkingLoaderWhileStreaming();
		this.ctx.ui.requestRender();
	}

	/** Stops and removes the auto-retry countdown, if one is showing. */
	#stopRetryLoader(): void {
		if (!this.ctx.retryLoader) return;
		this.ctx.retryLoader.stop();
		this.ctx.retryLoader = undefined;
		this.ctx.statusContainer.disposeChildren();
	}

	/** Marks each recovered error's superseded block as recovered; any recovery clears the pinned error banner. */
	#applyRetryRecoveries(recoveredErrors: readonly RecoveredRetryError[]): void {
		for (const recovered of recoveredErrors) {
			const component = this.#takeRetrySupersededAssistantComponent(recovered.persistenceKey);
			if (!component) continue;
			component.applyRetryRecovery(resolveAssistantErrorPresentation({ retryRecovery: recovered.retryRecovery }));
			if (this.#pinnedErrorComponent === component) this.#pinnedErrorComponent = undefined;
		}
		if (recoveredErrors.length > 0) this.ctx.clearPinnedError();
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
		// Consecutive notifications (e.g. per-tool matches from one assistant
		// message) merge into the previous block instead of stacking. Mutating an
		// existing block is only safe while none of its rows have entered native
		// scrollback — committed rows are immutable visual history and a grown
		// block would shift them.
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
		// Don't schedule idle work while context maintenance is already running; the
		// maintenance flow may reset the session before this timer fires.
		if (this.ctx.viewSession.isCompacting) return;

		const idleSettings = settings.getGroup("compaction");
		if (!idleSettings.idleEnabled) return;

		// Only if input is empty
		if (this.ctx.editor.getText().trim()) return;

		const threshold = idleSettings.idleThresholdTokens;
		if (threshold <= 0) return;
		if (this.#currentContextTokens() < threshold) return;

		const timeoutMs = clampLow(idleSettings.idleTimeoutSeconds, 60, 3600) * 1000;
		this.#idleCompactionTimer = setTimeout(() => {
			this.#idleCompactionTimer = undefined;
			// Re-check conditions before firing. Pruning may have run between arming
			// the timer and now, dropping usage back below the idle threshold.
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

	/**
	 * Generate the idle recap with an ephemeral side-channel turn over the
	 * current conversation (same pipeline as `/btw`) and surface it as a status
	 * line. Live goal/title and the active todo task are passed as anchoring
	 * hints because the snapshot only carries conversation history, not the
	 * controller's todo/goal state. The request is abortable: any activity
	 * cancels it via #cancelIdleRecap, and idle conditions are re-checked after
	 * the reply lands so a stale recap never paints over fresh work.
	 */
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

	/** Idle gate shared by the recap timer fire and its post-reply re-check. */
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

		// Skip when the turn was aborted (e.g. ask cancelled with Ctrl+C) or
		// errored — those are not "Task complete" events. Mirrors the gate
		// already used by #currentContextTokens, #handleMessageEnd, and the
		// retry / TTSR / compaction skip paths across agent-session.ts.
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

/** A new turn interrupts any speech still queued/playing from the previous one. */
function handleTurnStart(): void {
	vocalizer.clear();
}

/**
 * Speak streamed assistant output as a side effect of the turn. The mode
 * decides which deltas feed the vocalizer (the vocalizer re-checks enabled):
 * assistant|all speak text; all also speaks thinking; yield speaks nothing
 * live (the final message is spoken at turn end).
 */
function vocalizeDelta(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
	if (!settings.get("speech.enabled")) return;
	const mode = settings.get("speech.mode");
	const delta = event.assistantMessageEvent;
	if (delta.type === "text_delta" && (mode === "assistant" || mode === "all")) {
		vocalizer.pushDelta(delta.delta);
	} else if (delta.type === "thinking_delta" && mode === "all") {
		vocalizer.pushDelta(delta.delta);
	}
}

/**
 * End-of-message vocalization: an abort (Esc, Ctrl+C, interrupt) stops speech now and drops the trailing partial;
 * assistant and all modes speak the last partial sentence of a completed message, while yield mode speaks the whole
 * final message at turn end.
 */
function vocalizeMessageEnd(message: AssistantMessage): void {
	if (!settings.get("speech.enabled")) return;
	if (message.stopReason === "aborted") {
		vocalizer.clear();
		return;
	}
	const mode = settings.get("speech.mode");
	if (mode === "assistant" || mode === "all") vocalizer.flush();
}

/** Whether a message ended in an error to show: an error stop with a message, not suppressed by the silent-abort marker. */
function endsInShownError(message: AssistantMessage): message is AssistantMessage & { errorMessage: string } {
	return message.stopReason === "error" && !!message.errorMessage && !isSilentAbort(message);
}

/** The image blocks with inline data in a user message, the count the local-echo signature records. */
function countInlineImages(content: StartedUserMessage["content"]): number {
	if (typeof content === "string") return 0;
	let count = 0;
	for (const block of content) {
		if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") count++;
	}
	return count;
}

/**
 * End-of-turn vocalization: yield mode speaks the final assistant message in
 * one shot here (the only mode that is post-hoc); every other mode just makes
 * sure the live buffer's trailing partial gets flushed.
 */
function handleTurnEnd(event: Extract<AgentSessionEvent, { type: "turn_end" }>): void {
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
