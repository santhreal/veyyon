/**
 * Shared transcript rendering for interactive chat and read-only viewers.
 * `rebuild` reconstructs persisted history; `append` consumes new persisted entries.
 * Live `appendMessage` excludes tool mounting, which the event controller performs.
 */
import type { AgentMessage, AgentTool } from "@veyyon/agent-core";
import type { ImageContent, Usage } from "@veyyon/ai";
import { getStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import type { SnapshotStore } from "@veyyon/hashline";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import type { SessionMessageEntry } from "@veyyon/kernel/session/session-entries";
import { type Component, Text, type TUI } from "@veyyon/tui";
import { formatCount } from "@veyyon/utils";
import type { BlockId, CustomBlock, HookBlock, TranscriptBlock } from "@veyyon/wire/presentation";
import type { ArgotSession } from "argot/session";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import type { Settings } from "../../../../config/settings";
import { settings } from "../../../../config/settings-instance";
import type { AssistantThinkingRenderer, MessageRenderer } from "../../../../extensibility/extensions/types";
import {
	resolveAssistantErrorPresentation,
	toAssistantMessageView,
	toTranscriptBlock,
	toUserMessageView,
} from "../../../../presentation/transcript-builder";
import type { CustomMessage } from "../../../../session/messages";
import { theme } from "../../../../theme/theme";
import { decodeStreamedToolArgs, streamingStringKeysForTool } from "../../../../tools/core/streamed-tool-args";
import { isLiveBackgroundTask } from "../../utils/async-tool-state";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	buildFileMentionBlock,
	ledgerMarkerLine,
	normalizeToolArgs,
	splitAssistantMessageToolTimeline,
} from "../../utils/transcript-render-helpers";
import { AssistantMessageComponent } from "./assistant-message";
import { BashExecutionComponent } from "./bash-execution";
import { detectCacheInvalidation, usesExplicitPromptCache } from "./cache-invalidation-marker";
import { BranchSummaryMessageComponent, CompactionSummaryMessageComponent } from "./compaction-summary-message";
import { CustomMessageComponent, createSpecializedCustomComponent } from "./custom-message";
import { EvalExecutionComponent } from "./eval-execution";
import { HookMessageComponent } from "./hook-message";
import type { CustomRenderCapability } from "./message-frame";
import { ReadToolGroupComponent, readArgsHaveTarget, readArgsTargetInternalUrl } from "./read-tool-group";
import { ToolExecutionComponent, type ToolExecutionHandle, turnFailedToolResult } from "./tool-execution";
import { TranscriptBlockComponent, type TranscriptBlockComponentOptions } from "./transcript-block-component";
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
	getCustomRenderer?: (block: CustomBlock | HookBlock) => CustomRenderCapability | undefined;
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
	/** Group projected file-read entries; defaults to true. */
	groupReadEntries?: boolean;
	initialExpanded?: boolean;
	indentFileMentions?: number;
}

function isExpandable(component: unknown): component is { setExpanded(expanded: boolean): void } {
	return (
		typeof component === "object" &&
		component !== null &&
		"setExpanded" in component &&
		typeof (component as { setExpanded?: unknown }).setExpanded === "function"
	);
}

function extractMessagesAndCacheMiss(
	input: SessionContext | readonly SessionMessageEntry[] | readonly AgentMessage[],
): { messages: readonly AgentMessage[]; cacheMissExplainedAt?: boolean[] } {
	if ("messages" in input) {
		return { messages: input.messages, cacheMissExplainedAt: input.cacheMissExplainedAt };
	}
	return { messages: input.map(item => ("message" in item ? item.message : item)) };
}

export class ChatTranscriptBuilder {
	#ownContainer: TranscriptContainer | undefined;
	#ownPendingTools: Map<string, ToolExecutionHandle> | undefined;
	#ownSettledToolCalls: Set<string> | undefined;
	readonly #blocksById = new Map<
		BlockId,
		{ block: TranscriptBlock; component: TranscriptBlockComponent | ReadToolGroupComponent; readToolCallId?: string }
	>();
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

	/** Discard rendered rows while retaining the session's completed-call ledger. */
	clearTranscript(): void {
		if (this.deps.pendingTools === undefined && this.#ownPendingTools) {
			for (const pending of this.#ownPendingTools.values()) pending.seal();
		}
		this.#blocksById.clear();
		this.#pendingTools.clear();
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
		this.container.disposeChildren();
	}

	#getTranscriptBlockOptions(): TranscriptBlockComponentOptions {
		return {
			tui: this.deps.ui,
			onRequestRender: () => this.deps.requestRender(),
			expanded: this.#expanded,
			cwd: this.#cwd,
			getCustomRenderer: this.deps.getCustomRenderer,
			getThinkingRenderers: this.deps.getThinkingRenderers,
			hideThinkingBlock: this.deps.hideThinkingBlock,
			proseOnlyThinking: this.deps.proseOnlyThinking,
		};
	}

	setTranscriptBlocks(blocks: readonly TranscriptBlock[]): void {
		this.clearTranscript();
		for (const block of blocks) {
			this.appendTranscriptBlock(block);
		}
	}

	appendTranscriptBlock(block: TranscriptBlock): void {
		if (this.#blocksById.has(block.id)) {
			this.updateTranscriptBlock(block.id, block);
			return;
		}
		if (
			this.deps.groupReadEntries !== false &&
			block.kind === "tool-execution" &&
			block.display?.readEntry &&
			!readArgsTargetInternalUrl({ path: block.display.readEntry.path })
		) {
			const group = this.#ensureReadGroup();
			group.updateEntry(block.display.readEntry);
			this.#blocksById.set(block.id, {
				block,
				component: group,
				readToolCallId: block.display.readEntry.toolCallId,
			});
			return;
		}

		this.#readGroup?.seal();
		this.#readGroup = null;
		const comp = new TranscriptBlockComponent(block, this.#getTranscriptBlockOptions());
		this.#blocksById.set(block.id, { block, component: comp });
		this.#trackExpandable(comp);
		this.container.addChild(comp);
	}

	updateTranscriptBlock(id: BlockId, patch: Partial<TranscriptBlock>): void {
		const record = this.#blocksById.get(id);
		if (!record) return;
		const block = { ...record.block, ...patch, id } as TranscriptBlock;
		record.block = block;
		const existing = record.component;
		if (existing instanceof ReadToolGroupComponent) {
			if (block.kind === "tool-execution" && block.display?.readEntry) {
				existing.updateEntry(block.display.readEntry);
				return;
			}
		}
		if (existing instanceof TranscriptBlockComponent) {
			existing.set(block);
			return;
		}
	}

	removeTranscriptBlock(id: BlockId): boolean {
		const entry = this.#blocksById.get(id);
		if (!entry || !this.container.isBlockUncommitted(entry.component)) return false;
		const comp = entry.component;
		this.#blocksById.delete(id);
		if (comp instanceof ReadToolGroupComponent && entry.readToolCallId !== undefined) {
			if (comp.removeEntry(entry.readToolCallId) > 0) return true;
		}
		if (this.#readGroup === comp) this.#readGroup = null;
		this.container.removeChild(comp);
		const expandableIndex = this.#expandables.indexOf(comp);
		if (expandableIndex !== -1) this.#expandables.splice(expandableIndex, 1);
		comp.dispose?.();
		return true;
	}

	/** Reset session history before rebuilding it from another transcript. */
	reset(): void {
		this.clearTranscript();
		this.#settledToolCalls.clear();
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
				const userView = toUserMessageView(message);
				const textContent = userView.text;
				if (textContent) {
					const ledgerMarker = ledgerMarkerLine(textContent);
					if (ledgerMarker !== null) {
						this.container.addChild(new Text(ledgerMarker, 0, 0));
						return [];
					}
					userView.imageLinks = options?.imageLinks ?? this.deps.resolveImageLinks?.(message);
					const userComponent = new UserMessageComponent(userView);
					this.container.addChild(userComponent);
					if (options?.populateHistory && message.role === "user" && !userView.synthetic) {
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

	#createAssistantComponent(
		message: Extract<AgentMessage, { role: "assistant" }>,
		retryAttempt = this.deps.retryAttempt?.() ?? 0,
	): AssistantMessageComponent {
		const hideThinkingBlock = this.deps.hideThinkingBlock?.() ?? false;
		const proseOnlyThinking = this.deps.proseOnlyThinking ? this.deps.proseOnlyThinking() : true;
		const thinkingRenderers = this.deps.getThinkingRenderers?.() ?? (this.deps.getMessageRenderer ? undefined : []);
		const assistantComponent: AssistantMessageComponent = new AssistantMessageComponent(
			toAssistantMessageView(message, { retryAttempt }),
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
		const retryAttempt = this.deps.retryAttempt?.() ?? 0;
		const timeline = splitAssistantMessageToolTimeline(message);
		const assistantComponent = this.#createAssistantComponent(timeline.beforeTools, retryAttempt);
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

		const errorPresentation = resolveAssistantErrorPresentation(message, retryAttempt);
		const hasErrorStop = errorPresentation.kind === "full";
		const errorMessage = hasErrorStop ? errorPresentation.text : null;
		const appendAssistantSegment = (segment: Extract<AgentMessage, { role: "assistant" }> | undefined) => {
			if (!segment || !assistantHasVisibleContent(segment)) return;
			const component = this.#createAssistantComponent(segment, retryAttempt);
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
		const block = toTranscriptBlock(message, { index: this.container.children.length });

		// Specialized display takes precedence over extension renderers (matching production semantics)
		if (block.kind === "custom" || block.kind === "hook") {
			if (block.display !== undefined) {
				const component = createSpecializedCustomComponent(block.display, () => this.#expanded);
				if (isExpandable(component)) {
					this.#trackExpandable(component);
				}
				this.container.addChild(component);
				if (block.display.variant === "irc") {
					return [component];
				}
				return [];
			}
		}

		const rawRenderer = this.deps.getMessageRenderer?.(message.customType);
		const renderCustom: CustomRenderCapability | undefined = rawRenderer
			? (opts, uiTheme) => rawRenderer(message as CustomMessage<unknown>, opts, uiTheme)
			: undefined;

		if (block.kind === "hook") {
			const component = new HookMessageComponent(block, renderCustom);
			this.#trackExpandable(component);
			this.container.addChild(component);
			return [];
		}

		if (block.kind === "custom") {
			const component = new CustomMessageComponent(block, renderCustom);
			this.#trackExpandable(component);
			this.container.addChild(component);
			return [];
		}

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
