/**
 * Shared transcript rendering for interactive chat and read-only viewers.
 * `rebuild` reconstructs persisted history; `append` consumes new persisted entries.
 * Live `appendMessage` excludes tool mounting, which the event controller performs.
 */
import type { AgentMessage, AgentTool } from "@veyyon/agent-core";
import type { ImageContent, Message, Usage } from "@veyyon/ai";
import { getStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import type { SnapshotStore } from "@veyyon/hashline";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import type { SessionMessageEntry } from "@veyyon/kernel/session/session-entries";
import { type Component, Text, type TUI } from "@veyyon/tui";
import { formatCount } from "@veyyon/utils";
import type { ArgotSession } from "argot/session";
import type { AdvisorMessageDetails } from "../../../../advisor";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "../../../../collab/protocol";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import type { Settings } from "../../../../config/settings";
import { settings } from "../../../../config/settings-instance";
import type { AssistantThinkingRenderer, MessageRenderer } from "../../../../extensibility/extensions/types";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	type CustomMessage,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "../../../../session/messages";
import { theme } from "../../../../theme/theme";
import { decodeStreamedToolArgs, streamingStringKeysForTool } from "../../controllers/tool-args-reveal";
import { isLiveBackgroundTask } from "../../utils/async-tool-state";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	buildAsyncResultBlock,
	buildFileMentionBlock,
	buildIrcMessageCard,
	ledgerMarkerLine,
	normalizeToolArgs,
	resolveAssistantErrorPresentation,
	splitAssistantMessageToolTimeline,
} from "../../utils/transcript-render-helpers";
import { createAdvisorMessageCard } from "./advisor-message";
import { AssistantMessageComponent } from "./assistant-message";
import { createBackgroundTanDispatchBlock } from "./background-tan-message";
import { BashExecutionComponent } from "./bash-execution";
import { detectCacheInvalidation, usesExplicitPromptCache } from "./cache-invalidation-marker";
import { CollabPromptMessageComponent } from "./collab-prompt-message";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	createHandoffSummaryMessageComponent,
} from "./compaction-summary-message";
import { CustomMessageComponent } from "./custom-message";
import { EvalExecutionComponent } from "./eval-execution";
import { type LateDiagnosticsFile, LateDiagnosticsMessageComponent } from "./late-diagnostics-message";
import { ReadToolGroupComponent, readArgsHaveTarget, readArgsTargetInternalUrl } from "./read-tool-group";
import { SkillMessageComponent } from "./skill-message";
import { ToolExecutionComponent, type ToolExecutionHandle, turnFailedToolResult } from "./tool-execution";
import { TranscriptContainer } from "./transcript-container";
import { createUsageRowBlock } from "./usage-row";
import { UserMessageComponent } from "./user-message";

export interface ChatTranscriptBuilderDeps {
	ui: TUI;
	container?: TranscriptContainer | (() => TranscriptContainer);
	pendingTools?: Map<string, ToolExecutionHandle> | (() => Map<string, ToolExecutionHandle>);
	settledToolCalls?: Set<string> | (() => Set<string>);
	getSettings?: () => Pick<Settings, "get">;
	getTool?: (name: string) => AgentTool | undefined;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	getThinkingRenderers?: () => AssistantThinkingRenderer[] | undefined;
	getSnapshots?: () => SnapshotStore | undefined;
	getArgotSession?: () => ArgotSession | undefined;
	cwd: string | (() => string);
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	requestRender: () => void;
	resolveImageLinks?: (
		message: Extract<AgentMessage, { role: "developer" | "user" }>,
	) => readonly (string | undefined)[] | undefined;
	onPopulateHistory?: (text: string) => void;
	onInheritDisplaceableTodo?: (component: ToolExecutionComponent) => void;
	isStreaming?: () => boolean;
	retryAttempt?: () => number;
	getLastAssistantUsage?: () => Usage | undefined;
	setLastAssistantUsage?: (usage: Usage | undefined) => void;
	initialExpanded?: boolean;
	indentFileMentions?: number;
}

function extractMessagesAndCacheMiss(
	input: SessionContext | readonly SessionMessageEntry[] | readonly AgentMessage[],
): { messages: readonly AgentMessage[]; cacheMissExplainedAt?: boolean[] } {
	if ("messages" in input) {
		return { messages: input.messages, cacheMissExplainedAt: input.cacheMissExplainedAt };
	}
	return { messages: input.map(item => ("message" in item ? item.message : item)) };
}

/** Extracts the plain-text content of a user message (string or text blocks). */
export function userMessageText(message: Extract<AgentMessage, { role: "developer" | "user" }> | Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("");
}

export class ChatTranscriptBuilder {
	#ownContainer: TranscriptContainer | undefined;
	#ownPendingTools: Map<string, ToolExecutionHandle> | undefined;
	#ownSettledToolCalls: Set<string> | undefined;
	readonly #readArgs = new Map<string, Record<string, unknown>>();
	readonly #readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
	readonly #liveBackgroundCalls = new Set<string>();
	#readGroup: ReadToolGroupComponent | null = null;
	#pendingUsage: Usage | undefined;
	#pendingUsageDuration: number | undefined;
	#pendingUsageTtft: number | undefined;
	#lastAssistantUsage: Usage | undefined;
	#waitingPoll: ToolExecutionComponent | null = null;
	#todoSnapshot: ToolExecutionComponent | null = null;
	#expandables: Array<{ setExpanded(expanded: boolean): void }> = [];
	#expanded = false;

	constructor(private readonly deps: ChatTranscriptBuilderDeps) {
		this.#expanded = deps.initialExpanded ?? false;
		this.#lastAssistantUsage = deps.getLastAssistantUsage?.();
	}

	get container(): TranscriptContainer {
		if (typeof this.deps.container === "function") return this.deps.container();
		if (this.deps.container) return this.deps.container;
		this.#ownContainer ??= new TranscriptContainer();
		return this.#ownContainer;
	}

	get #pendingTools(): Map<string, ToolExecutionHandle> {
		if (typeof this.deps.pendingTools === "function") return this.deps.pendingTools();
		if (this.deps.pendingTools) return this.deps.pendingTools;
		this.#ownPendingTools ??= new Map();
		return this.#ownPendingTools;
	}

	get #settledToolCalls(): Set<string> {
		if (typeof this.deps.settledToolCalls === "function") return this.deps.settledToolCalls();
		if (this.deps.settledToolCalls) return this.deps.settledToolCalls;
		this.#ownSettledToolCalls ??= new Set();
		return this.#ownSettledToolCalls;
	}

	get #cwd(): string {
		return typeof this.deps.cwd === "function" ? this.deps.cwd() : this.deps.cwd;
	}
	get #settings(): Pick<Settings, "get"> {
		return this.deps.getSettings?.() ?? settings;
	}

	/** Whether the transcript currently holds any rendered rows. */
	get isEmpty(): boolean {
		return this.container.children.length === 0;
	}
	/** Discard all components and rebuild the whole transcript from `input`. */
	rebuild(
		input: SessionContext | readonly SessionMessageEntry[] | readonly AgentMessage[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.reset();
		const { messages, cacheMissExplainedAt } = extractMessagesAndCacheMiss(input);
		const count = messages.length;
		for (let i = 0; i < count; i++) {
			const message = messages[i]!;
			this.#appendPersistedMessage(message, {
				populateHistory: options.populateHistory,
				cacheMissExplained: cacheMissExplainedAt?.[i] ?? false,
			});
		}
		this.#finalizeRebuild();
	}

	/** Append newly persisted entries without rebuilding already rendered rows. */
	append(
		input: SessionContext | readonly SessionMessageEntry[] | readonly AgentMessage[],
		options: { populateHistory?: boolean } = {},
	): void {
		const { messages, cacheMissExplainedAt } = extractMessagesAndCacheMiss(input);
		const count = messages.length;
		for (let i = 0; i < count; i++) {
			const message = messages[i]!;
			this.#appendPersistedMessage(message, {
				populateHistory: options.populateHistory,
				cacheMissExplained: cacheMissExplainedAt?.[i] ?? false,
			});
		}
		if (this.#readArgs.size === 0 && this.#pendingTools.size === 0) this.#flushPendingUsage();
	}

	/** Append a single message to the transcript (live dispatch). */
	appendMessage(
		message: AgentMessage,
		options?: { populateHistory?: boolean; imageLinks?: readonly (string | undefined)[] },
	): Component[] {
		switch (message.role) {
			case "assistant": {
				const timeline = splitAssistantMessageToolTimeline(message);
				const assistantComponent = this.#createAssistantComponent(timeline.beforeTools);
				this.container.addChild(assistantComponent);
				return [];
			}
			case "toolResult":
				// Live tool results are rendered inline with tool calls, handled by eventController.
				return [];
			default:
				return this.#appendCommonMessage(message, options);
		}
	}

	/** Toggle tool-output expansion across every expandable component. */
	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		for (const component of this.#expandables) component.setExpanded(expanded);
	}

	get expanded(): boolean {
		return this.#expanded;
	}

	/** Tear down components (sealing pending spinners) and clear build state. */
	reset(): void {
		if (this.deps.pendingTools === undefined && this.#ownPendingTools) {
			for (const pending of this.#ownPendingTools.values()) pending.seal();
		}
		this.#pendingTools.clear();
		this.#settledToolCalls.clear();
		this.#readArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#liveBackgroundCalls.clear();
		this.#readGroup = null;
		this.#pendingUsage = undefined;
		this.#pendingUsageDuration = undefined;
		this.#pendingUsageTtft = undefined;
		this.#lastAssistantUsage = undefined;
		this.deps.setLastAssistantUsage?.(undefined);
		this.#waitingPoll = null;
		this.#todoSnapshot = null;
		this.#expandables = [];
		this.container.clear();
	}

	dispose(): void {
		this.reset();
	}

	#trackExpandable(component: { setExpanded(expanded: boolean): void }): void {
		component.setExpanded(this.#expanded);
		this.#expandables.push(component);
	}

	/** A `job` poll showing all-running is displaced by the next `job` call. */
	#resolveWaitingPoll(nextToolName?: string): void {
		const previous = this.#waitingPoll;
		if (!previous) return;
		this.#waitingPoll = null;
		if (nextToolName === "job" && previous.isDisplaceableBlock() && this.container.isBlockUncommitted(previous)) {
			this.container.removeChild(previous);
		}
		previous.seal();
	}

	#resolveTodoSnapshot(nextToolName?: string): void {
		const previous = this.#todoSnapshot;
		if (!previous) return;
		if (!previous.isDisplaceableBlock()) {
			this.#todoSnapshot = null;
			return;
		}
		if (previous.canBeDisplacedBy(nextToolName)) {
			this.#todoSnapshot = null;
			if (this.container.isBlockUncommitted(previous)) {
				this.container.removeChild(previous);
			}
			previous.seal();
			return;
		}
		if (nextToolName !== undefined) return;
		this.#todoSnapshot = null;
		previous.seal();
	}

	#ensureReadGroup(): ReadToolGroupComponent {
		if (!this.#readGroup) {
			this.#readGroup = new ReadToolGroupComponent({
				showContentPreview: this.#settings.get("read.toolResultPreview"),
			});
			this.#trackExpandable(this.#readGroup);
			this.container.addChild(this.#readGroup);
		}
		return this.#readGroup;
	}

	#flushPendingUsage(): void {
		if (!this.#pendingUsage) return;
		this.#readGroup?.seal();
		this.#readGroup = null;
		this.container.addChild(
			createUsageRowBlock(this.#pendingUsage, this.#pendingUsageDuration, this.#pendingUsageTtft),
		);
		this.#pendingUsage = undefined;
		this.#pendingUsageDuration = undefined;
		this.#pendingUsageTtft = undefined;
	}

	#appendPersistedMessage(
		message: AgentMessage,
		options?: {
			populateHistory?: boolean;
			imageLinks?: readonly (string | undefined)[];
			cacheMissExplained?: boolean;
		},
	): void {
		if (message.role !== "toolResult") this.#flushPendingUsage();
		switch (message.role) {
			case "assistant":
				this.#appendAssistantMessage(message, options?.cacheMissExplained ?? false);
				break;
			case "toolResult":
				this.#appendToolResult(message);
				break;
			default:
				this.#appendCommonMessage(message, options);
				break;
		}
	}

	#appendCommonMessage(
		message: AgentMessage,
		options?: {
			populateHistory?: boolean;
			imageLinks?: readonly (string | undefined)[];
		},
	): Component[] {
		switch (message.role) {
			case "user":
			case "developer": {
				if (message.role === "user") {
					this.#resolveWaitingPoll();
					this.#resolveTodoSnapshot();
				}
				const textContent = userMessageText(message);
				if (textContent) {
					const ledgerMarker = ledgerMarkerLine(textContent);
					if (ledgerMarker !== null) {
						this.container.addChild(new Text(ledgerMarker, 0, 0));
						return [];
					}
					const isSynthetic = message.role === "developer" ? true : (message.synthetic ?? false);
					const imageLinks = options?.imageLinks ?? this.deps.resolveImageLinks?.(message);
					const userComponent = new UserMessageComponent(textContent, isSynthetic, imageLinks);
					this.container.addChild(userComponent);
					if (options?.populateHistory && message.role === "user" && !isSynthetic) {
						this.deps.onPopulateHistory?.(textContent);
					}
				}
				return [];
			}
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.deps.ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, { truncation: message.meta?.truncation });
				this.container.addChild(component);
				return [];
			}
			case "pythonExecution": {
				const component = new EvalExecutionComponent(message.code, this.deps.ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, { truncation: message.meta?.truncation });
				this.container.addChild(component);
				return [];
			}
			case "hookMessage":
			case "custom":
				return this.#appendCustomMessage(message);
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.container.addChild(component);
				return [];
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.container.addChild(component);
				return [];
			}
			case "fileMention": {
				const indent = this.deps.indentFileMentions ?? 0;
				const block = buildFileMentionBlock(message.files, indent);
				if (block.children.length > 0) this.container.addChild(block);
				return [];
			}
			default:
				return [];
		}
	}

	#createAssistantComponent(message?: Extract<AgentMessage, { role: "assistant" }>): AssistantMessageComponent {
		const hideThinkingBlock = this.deps.hideThinkingBlock?.() ?? false;
		const proseOnlyThinking = this.deps.proseOnlyThinking ? this.deps.proseOnlyThinking() : true;
		const thinkingRenderers = this.deps.getThinkingRenderers?.() ?? (this.deps.getMessageRenderer ? undefined : []);
		const assistantComponent: AssistantMessageComponent = new AssistantMessageComponent(
			message,
			hideThinkingBlock,
			() => this.deps.requestRender(),
			thinkingRenderers,
			this.deps.ui.imageBudget,
			proseOnlyThinking,
			() => this.deps.ui.requestComponentRender(assistantComponent),
		);
		return assistantComponent;
	}

	#appendAssistantMessage(message: Extract<AgentMessage, { role: "assistant" }>, cacheMissExplained: boolean): void {
		const timeline = splitAssistantMessageToolTimeline(message);
		const assistantComponent = this.#createAssistantComponent(timeline.beforeTools);
		this.container.addChild(assistantComponent);

		const usage = message.usage;
		if (this.#settings.get("display.cacheMissMarker") && !cacheMissExplained) {
			const invalidation = detectCacheInvalidation(this.#lastAssistantUsage, usage, undefined, {
				explicitCache: usesExplicitPromptCache(message.api, message.model),
			});
			if (invalidation) assistantComponent.setCacheInvalidation(invalidation);
		}
		if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
			this.#lastAssistantUsage = usage;
			this.deps.setLastAssistantUsage?.(usage);
		}

		const hasVisibleAssistantContent = assistantHasVisibleContent(message);
		if (hasVisibleAssistantContent) {
			this.#readGroup?.seal();
			this.#readGroup = null;
		}

		const retryAttempt = this.deps.retryAttempt?.() ?? 0;
		const errorPresentation = resolveAssistantErrorPresentation(message, retryAttempt);
		const hasErrorStop = errorPresentation.kind === "full";
		const errorMessage = hasErrorStop ? errorPresentation.text : null;
		const appendAssistantSegment = (segment: Extract<AgentMessage, { role: "assistant" }> | undefined) => {
			if (!segment || !assistantHasVisibleContent(segment)) return;
			const component = this.#createAssistantComponent(segment);
			this.container.addChild(component);
		};

		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.#resolveWaitingPoll(content.name);

			const afterToolSegment = timeline.afterToolCalls.get(content.id);
			if (
				content.name === "read" &&
				readArgsHaveTarget(content.arguments) &&
				!readArgsTargetInternalUrl(content.arguments)
			) {
				if (hasErrorStop && errorMessage) {
					const group = this.#ensureReadGroup();
					group.updateArgs(content.arguments, content.id);
					group.updateResult(turnFailedToolResult(errorMessage), false, content.id);
					this.#settledToolCalls.add(content.id);
				} else if (afterToolSegment) {
					const group = this.#ensureReadGroup();
					group.updateArgs(content.arguments, content.id);
					this.#pendingTools.set(content.id, group);
					this.#readToolCallAssistantComponents.set(content.id, assistantComponent);
				} else {
					const normalizedArgs = normalizeToolArgs(content.arguments);
					this.#readArgs.set(content.id, normalizedArgs);
					this.#readToolCallAssistantComponents.set(content.id, assistantComponent);
				}
				appendAssistantSegment(afterToolSegment);
				continue;
			}

			this.#readGroup?.seal();
			this.#readGroup = null;

			const tool = this.deps.getTool?.(content.name);
			const partialJson = getStreamingPartialJson(content);
			const rawInput = content.customWireName !== undefined;
			const renderArgs = partialJson
				? decodeStreamedToolArgs(partialJson, {
						rawInput,
						fullArgs: content.arguments,
						streamingStringKeys: streamingStringKeysForTool(content.name, rawInput),
						argot: this.deps.getArgotSession?.(),
					})
				: content.arguments;

			const component = new ToolExecutionComponent(
				content.name,
				renderArgs,
				{
					snapshots: this.deps.getSnapshots?.(),
					showImages: settings.get("terminal.showImages"),
					editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
					editAllowFuzzy: settings.get("edit.fuzzyMatch"),
					liveRegion: this.container,
				},
				tool,
				this.deps.ui,
				this.#cwd,
				content.id,
			);
			this.#trackExpandable(component);
			this.container.addChild(component);

			if (hasErrorStop && errorMessage) {
				component.updateResult(turnFailedToolResult(errorMessage), false, content.id);
				this.#settledToolCalls.add(content.id);
			} else {
				this.#pendingTools.set(content.id, component);
			}
			appendAssistantSegment(afterToolSegment);
		}

		const strippedToolCalls =
			"strippedToolCalls" in message && typeof message.strippedToolCalls === "number"
				? message.strippedToolCalls
				: 0;
		if (strippedToolCalls > 0) {
			this.container.addChild(
				new Text(
					theme.fg(
						"dim",
						theme.italic(`${formatCount("tool call", strippedToolCalls)} elided — no result on this branch`),
					),
					1,
					0,
				),
			);
		}

		this.#pendingUsage =
			this.#settings.get("display.showTokenUsage") && assistantUsageIsBilled(message.usage)
				? message.usage
				: undefined;
		this.#pendingUsageDuration = message.duration;
		this.#pendingUsageTtft = message.ttft;
	}

	#appendToolResult(message: Extract<AgentMessage, { role: "toolResult" }>): void {
		const backgroundStillRunning = isLiveBackgroundTask(message.toolName, message.details);
		if (backgroundStillRunning) {
			this.#liveBackgroundCalls.add(message.toolCallId);
		} else {
			this.#settledToolCalls.add(message.toolCallId);
		}

		const pending = this.#pendingTools.get(message.toolCallId);
		const isReadGroupResult = message.toolName === "read" && (!pending || pending instanceof ReadToolGroupComponent);
		if (isReadGroupResult) {
			const assistantComponent = this.#readToolCallAssistantComponents.get(message.toolCallId);
			const images: ImageContent[] = message.content.filter(
				(content): content is ImageContent => content.type === "image",
			);
			if (images.length > 0 && assistantComponent && settings.get("terminal.showImages")) {
				assistantComponent.setToolResultImages(message.toolCallId, images);
				const hasText = message.content.some(c => c.type === "text");
				if (!hasText) {
					this.#readArgs.delete(message.toolCallId);
					this.#readToolCallAssistantComponents.delete(message.toolCallId);
					return;
				}
			}

			let component = pending;
			if (!component) {
				const group = this.#ensureReadGroup();
				const args = this.#readArgs.get(message.toolCallId);
				if (args) group.updateArgs(args, message.toolCallId);
				component = group;
				this.#pendingTools.set(message.toolCallId, group);
			}
			component.updateResult(message, false, message.toolCallId);
			this.#pendingTools.delete(message.toolCallId);
			this.#readArgs.delete(message.toolCallId);
			this.#readToolCallAssistantComponents.delete(message.toolCallId);
			return;
		}

		if (!pending) return;
		pending.updateResult(message, backgroundStillRunning, message.toolCallId);
		if (backgroundStillRunning) return;
		this.#pendingTools.delete(message.toolCallId);

		if (message.toolName === "job" && pending instanceof ToolExecutionComponent && pending.isDisplaceableBlock()) {
			this.#waitingPoll = pending;
		} else if (
			message.toolName === "todo" &&
			pending instanceof ToolExecutionComponent &&
			pending.canBeDisplacedBy("todo")
		) {
			this.#resolveTodoSnapshot("todo");
			this.#todoSnapshot = pending;
		}
	}

	#appendCustomMessage(message: Extract<AgentMessage, { role: "custom" | "hookMessage" }>): Component[] {
		if (!message.display) return [];
		if (message.customType === "async-result") {
			this.container.addChild(buildAsyncResultBlock(message));
			return [];
		}
		if (message.customType === LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE) {
			const files =
				message.details &&
				typeof message.details === "object" &&
				"files" in message.details &&
				Array.isArray(message.details.files)
					? (message.details.files as LateDiagnosticsFile[])
					: [];
			const component = new LateDiagnosticsMessageComponent(files);
			this.#trackExpandable(component);
			this.container.addChild(component);
			return [];
		}
		if (message.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
			this.container.addChild(new CollabPromptMessageComponent(message as CustomMessage<CollabPromptDetails>));
			return [];
		}
		if (message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
			const component = new SkillMessageComponent(message as CustomMessage<SkillPromptDetails>);
			this.#trackExpandable(component);
			this.container.addChild(component);
			return [];
		}
		if (
			message.customType === "irc:incoming" ||
			message.customType === "irc:autoreply" ||
			message.customType === "irc:relay"
		) {
			const card = buildIrcMessageCard(message, () => this.#expanded);
			this.container.addChild(card);
			return [card];
		}
		if (message.customType === "advisor") {
			const advisorDetails =
				message.details && typeof message.details === "object"
					? (message.details as AdvisorMessageDetails)
					: undefined;
			this.container.addChild(createAdvisorMessageCard(advisorDetails, () => this.#expanded, theme));
			return [];
		}
		if (message.customType === BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE) {
			this.container.addChild(createBackgroundTanDispatchBlock(message as CustomMessage<unknown>));
			return [];
		}
		const handoffComponent = createHandoffSummaryMessageComponent(message as CustomMessage<unknown>, this.#expanded);
		if (handoffComponent) {
			this.#trackExpandable(handoffComponent);
			this.container.addChild(handoffComponent);
			return [];
		}
		const component = new CustomMessageComponent(
			message as CustomMessage<unknown>,
			this.deps.getMessageRenderer?.(message.customType),
		);
		this.#trackExpandable(component);
		this.container.addChild(component);
		return [];
	}

	#finalizeRebuild(): void {
		this.#flushPendingUsage();
		this.#readGroup?.seal();
		this.#resolveWaitingPoll();

		const isStreaming = this.deps.isStreaming?.() ?? false;
		if (this.#todoSnapshot && isStreaming) {
			this.deps.onInheritDisplaceableTodo?.(this.#todoSnapshot);
			this.#todoSnapshot = null;
		} else {
			this.#resolveTodoSnapshot();
		}

		if (isStreaming) {
			for (const [toolCallId, component] of this.#pendingTools) {
				component.setArgsComplete(toolCallId);
			}
		} else {
			for (const [toolCallId, component] of this.#pendingTools) {
				if (this.#liveBackgroundCalls.has(toolCallId)) continue;
				component.seal();
				this.#settledToolCalls.add(toolCallId);
				this.#pendingTools.delete(toolCallId);
			}
		}
		this.deps.requestRender();
	}
}
