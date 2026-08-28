import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ImageContent, Message, TextContent, Usage } from "@veyyon/ai";
import { getStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import { type Component, Spacer, Text, TruncatedText } from "@veyyon/tui";
import { APP_NAME, errorMessage, formatCount } from "@veyyon/utils";
import type { AdvisorMessageDetails } from "../../advisor";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "../../collab/protocol";
import { type SettingsSaveFailure, settings } from "../../config/settings";
import { getFileSnapshotStore } from "../../edit/file-snapshot-store";
import { createAdvisorMessageCard } from "../../modes/components/advisor-message";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { createBackgroundTanDispatchBlock } from "../../modes/components/background-tan-message";
import { BashExecutionComponent } from "../../modes/components/bash-execution";
import { detectCacheInvalidation, usesExplicitPromptCache } from "../../modes/components/cache-invalidation-marker";
import { CollabPromptMessageComponent } from "../../modes/components/collab-prompt-message";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	createHandoffSummaryMessageComponent,
} from "../../modes/components/compaction-summary-message";
import { CustomMessageComponent } from "../../modes/components/custom-message";
import { EvalExecutionComponent } from "../../modes/components/eval-execution";
import {
	type LateDiagnosticsFile,
	LateDiagnosticsMessageComponent,
} from "../../modes/components/late-diagnostics-message";
import {
	ReadToolGroupComponent,
	readArgsHaveTarget,
	readArgsTargetInternalUrl,
} from "../../modes/components/read-tool-group";
import { SkillMessageComponent } from "../../modes/components/skill-message";
import { ToolExecutionComponent, turnFailedToolResult } from "../../modes/components/tool-execution";
import { TranscriptBlock } from "../../modes/components/transcript-container";
import { createUsageRowBlock } from "../../modes/components/usage-row";
import { UserMessageComponent } from "../../modes/components/user-message";
import { decodeStreamedToolArgs, streamingStringKeysForTool } from "../../modes/controllers/tool-args-reveal";
import { materializeImageReferenceLinksSync } from "../../modes/image-references";
import { theme } from "../../modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "../../modes/types";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	type CustomMessage,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "../../session/messages";
import type { SessionContext, StrippedToolCallsMarker } from "../../session/session-context";
import { replaceTabs } from "../../tools/render-utils";
import { buildSkillCommandPrompt, invokeSkillCommandFromText, isKnownSkillCommand } from "../skill-command";
import { isLiveBackgroundTask } from "./async-tool-state";
import { createAssistantMessageComponent } from "./interactive-context-helpers";
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
} from "./transcript-render-helpers";

export type UiHelpersContext = Pick<
	InteractiveModeContext,
	| "addMessageToChat"
	| "chatContainer"
	| "compactionQueuedMessages"
	| "editor"
	| "effectiveHideThinkingBlock"
	| "eventController"
	| "fileSlashCommands"
	| "focusedAgentId"
	| "getUserMessageText"
	| "initialChatRendered"
	| "isKnownSlashCommand"
	| "keybindings"
	| "lastAssistantUsage"
	| "lastStatusSpacer"
	| "lastStatusText"
	| "pendingBashComponents"
	| "pendingMessagesContainer"
	| "pendingPythonComponents"
	| "pendingTools"
	| "settledToolCalls"
	| "present"
	| "proseOnlyThinking"
	| "recordLocalSubmission"
	| "refreshComposerShortcuts"
	| "renderSessionContext"
	| "resetTranscript"
	| "session"
	| "settings"
	| "showError"
	| "showStatus"
	| "skillCommands"
	| "statusLine"
	| "toolOutputExpanded"
	| "ui"
	| "updateEditorBorderColor"
	| "updatePendingMessagesDisplay"
	| "viewSession"
	| "withLocalSubmission"
>;

interface RenderInitialMessagesOptions {
	preserveExistingChat?: boolean;
	clearTerminalHistory?: boolean;
}

type QueuedMessages = {
	steering: string[];
	followUp: string[];
};

function imageLinksForMessage(
	message: Extract<AgentMessage, { role: "developer" | "user" }>,
	putBlobSync: InteractiveModeContext["sessionManager"]["putBlobSync"],
): (string | undefined)[] | undefined {
	if (typeof message.content === "string") return undefined;
	const images = message.content.filter(
		(content): content is ImageContent =>
			content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string",
	);
	return materializeImageReferenceLinksSync(images, putBlobSync);
}

export class UiHelpers {
	constructor(private ctx: UiHelpersContext) {}

	getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		if (typeof message.content === "string") return message.content;
		let result = "";
		for (let i = 0; i < message.content.length; i++) {
			const block = message.content[i]!;
			if (block.type === "text") result += block.text;
		}
		return result;
	}

	showStatus(message: string, options?: { dim?: boolean }): void {
		const children = this.ctx.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;
		const useDim = options?.dim ?? true;
		const rendered = useDim ? theme.fg("dim", message) : message;

		if (last && secondLast && last === this.ctx.lastStatusText && secondLast === this.ctx.lastStatusSpacer) {
			this.ctx.lastStatusText.setText(rendered);
			this.ctx.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(rendered, 1, 0);
		this.ctx.present([spacer, text]);
		this.ctx.lastStatusSpacer = spacer;
		this.ctx.lastStatusText = text;
	}

	addMessageToChat(
		message: AgentMessage,
		options?: { populateHistory?: boolean; imageLinks?: readonly (string | undefined)[] },
	): Component[] {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ctx.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
				});
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "pythonExecution": {
				const component = new EvalExecutionComponent(message.code, this.ctx.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
				});
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "hookMessage":
			case "custom": {
				if (message.display) {
					if (message.customType === "async-result") {
						this.ctx.chatContainer.addChild(buildAsyncResultBlock(message));
						break;
					}
					if (message.customType === LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE) {
						const details = (
							message as CustomMessage<{
								files?: LateDiagnosticsFile[];
							}>
						).details;
						const component = new LateDiagnosticsMessageComponent(details?.files ?? []);
						component.setExpanded(this.ctx.toolOutputExpanded);
						this.ctx.chatContainer.addChild(component);
						break;
					}
					if (message.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
						const component = new CollabPromptMessageComponent(message as CustomMessage<CollabPromptDetails>);
						this.ctx.chatContainer.addChild(component);
						break;
					}
					if (message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
						const component = new SkillMessageComponent(message as CustomMessage<SkillPromptDetails>);
						component.setExpanded(this.ctx.toolOutputExpanded);
						this.ctx.chatContainer.addChild(component);
						break;
					}
					if (
						message.customType === "irc:incoming" ||
						message.customType === "irc:autoreply" ||
						message.customType === "irc:relay"
					) {
						const card = buildIrcMessageCard(message, () => this.ctx.toolOutputExpanded);
						this.ctx.chatContainer.addChild(card);
						return [card];
					}
					if (message.customType === "advisor") {
						const details = (message as CustomMessage<AdvisorMessageDetails>).details;
						this.ctx.chatContainer.addChild(
							createAdvisorMessageCard(details, () => this.ctx.toolOutputExpanded, theme),
						);
						break;
					}
					if (message.customType === BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE) {
						this.ctx.chatContainer.addChild(createBackgroundTanDispatchBlock(message as CustomMessage<unknown>));
						break;
					}
					const handoffComponent = createHandoffSummaryMessageComponent(
						message as CustomMessage<unknown>,
						this.ctx.toolOutputExpanded,
					);
					if (handoffComponent) {
						this.ctx.chatContainer.addChild(handoffComponent);
						break;
					}
					const renderer = this.ctx.viewSession.extensionRunner?.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(message as CustomMessage<unknown>, renderer);
					component.setExpanded(this.ctx.toolOutputExpanded);
					this.ctx.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(message);
				component.setExpanded(this.ctx.toolOutputExpanded);
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(message);
				component.setExpanded(this.ctx.toolOutputExpanded);
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "fileMention": {
				const block = buildFileMentionBlock(message.files, 0);
				if (block.children.length > 0) this.ctx.chatContainer.addChild(block);
				break;
			}
			case "user":
			case "developer": {
				const textContent = this.ctx.getUserMessageText(message);
				if (textContent) {
					const ledgerMarker = ledgerMarkerLine(textContent);
					if (ledgerMarker !== null) {
						this.ctx.chatContainer.addChild(new Text(ledgerMarker, 0, 0));
						break;
					}
					const isSynthetic = message.role === "developer" ? true : (message.synthetic ?? false);
					const imageLinks =
						options?.imageLinks ??
						imageLinksForMessage(
							message,
							this.ctx.viewSession.sessionManager.putBlobSync.bind(this.ctx.viewSession.sessionManager),
						);
					const userComponent = new UserMessageComponent(textContent, isSynthetic, imageLinks);
					this.ctx.chatContainer.addChild(userComponent);
					if (options?.populateHistory && message.role === "user" && !isSynthetic) {
						this.ctx.editor.addToHistory(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = createAssistantMessageComponent(
					this.ctx,
					splitAssistantMessageToolTimeline(message).beforeTools,
				);
				this.ctx.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				break;
			}
			default: {
				message satisfies never;
			}
		}
		return [];
	}

	renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.ctx.pendingTools.clear();
		this.ctx.settledToolCalls.clear();
		this.ctx.lastAssistantUsage = undefined;

		if (options.updateFooter) {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}

		let readGroup: ReadToolGroupComponent | null = null;
		const readToolCallArgs = new Map<string, Record<string, unknown>>();
		const readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
		let pendingUsage: Usage | undefined;
		let pendingUsageDuration: number | undefined;
		let pendingUsageTtft: number | undefined;
		const flushPendingUsage = () => {
			if (!pendingUsage) return;
			readGroup?.seal();
			readGroup = null;
			this.ctx.chatContainer.addChild(createUsageRowBlock(pendingUsage, pendingUsageDuration, pendingUsageTtft));
			pendingUsage = undefined;
			pendingUsageDuration = undefined;
			pendingUsageTtft = undefined;
		};
		let waitingPoll: ToolExecutionComponent | null = null;
		const resolveWaitingPoll = (nextToolName?: string) => {
			const previous = waitingPoll;
			if (!previous) return;
			waitingPoll = null;
			if (
				nextToolName === "job" &&
				previous.isDisplaceableBlock() &&
				this.ctx.chatContainer.isBlockUncommitted(previous)
			) {
				this.ctx.chatContainer.removeChild(previous);
			}
			previous.seal();
		};
		const liveBackgroundCalls = new Set<string>();
		let todoSnapshot: ToolExecutionComponent | null = null;
		const resolveTodoSnapshot = (nextToolName?: string) => {
			const previous = todoSnapshot;
			if (!previous) return;
			if (!previous.isDisplaceableBlock()) {
				todoSnapshot = null;
				return;
			}
			if (previous.canBeDisplacedBy(nextToolName)) {
				todoSnapshot = null;
				if (this.ctx.chatContainer.isBlockUncommitted(previous)) {
					this.ctx.chatContainer.removeChild(previous);
				}
				previous.seal();
				return;
			}
			if (nextToolName !== undefined) return;
			todoSnapshot = null;
			previous.seal();
		};
		const messages = sessionContext.messages;
		const count = messages.length;
		for (let i = 0; i < count; i++) {
			const message = messages[i]!;
			if (message.role !== "toolResult") flushPendingUsage();
			if (message.role === "assistant") {
				const timeline = splitAssistantMessageToolTimeline(message);
				this.ctx.addMessageToChat(message);
				const lastChild = this.ctx.chatContainer.children[this.ctx.chatContainer.children.length - 1];
				const assistantComponent = lastChild instanceof AssistantMessageComponent ? lastChild : undefined;
				if (assistantComponent) {
					const usage = message.usage;
					const explained = sessionContext.cacheMissExplainedAt?.[i] ?? false;
					if (this.ctx.settings.get("display.cacheMissMarker") && !explained) {
						const invalidation = detectCacheInvalidation(this.ctx.lastAssistantUsage, usage, undefined, {
							explicitCache: usesExplicitPromptCache(message.api, message.model),
						});
						if (invalidation) assistantComponent.setCacheInvalidation(invalidation);
					}
					if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
						this.ctx.lastAssistantUsage = usage;
					}
				}
				const hasVisibleAssistantContent = assistantHasVisibleContent(message);
				if (hasVisibleAssistantContent) {
					readGroup?.seal();
					readGroup = null;
				}
				const errorPresentation = resolveAssistantErrorPresentation(message, this.ctx.viewSession.retryAttempt);
				const hasErrorStop = errorPresentation.kind === "full";
				const errorMessage = hasErrorStop ? errorPresentation.text : null;
				const appendAssistantSegment = (segment: AssistantMessage | undefined) => {
					if (!segment || !assistantHasVisibleContent(segment)) return;
					const component = createAssistantMessageComponent(this.ctx, segment);
					this.ctx.chatContainer.addChild(component);
				};

				const blocks = message.content;
				for (let ci = 0; ci < blocks.length; ci++) {
					const content = blocks[ci]!;
					if (content.type !== "toolCall") {
						continue;
					}
					resolveWaitingPoll(content.name);
					const afterToolSegment = timeline.afterToolCalls.get(content.id);

					if (
						content.name === "read" &&
						readArgsHaveTarget(content.arguments) &&
						!readArgsTargetInternalUrl(content.arguments)
					) {
						if (hasErrorStop && errorMessage) {
							if (!readGroup) {
								readGroup = new ReadToolGroupComponent({
									showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
								});
								readGroup.setExpanded(this.ctx.toolOutputExpanded);
								this.ctx.chatContainer.addChild(readGroup);
							}
							readGroup.updateArgs(content.arguments, content.id);
							readGroup.updateResult(turnFailedToolResult(errorMessage), false, content.id);
							this.ctx.settledToolCalls.add(content.id);
						} else if (afterToolSegment) {
							if (!readGroup) {
								readGroup = new ReadToolGroupComponent({
									showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
								});
								readGroup.setExpanded(this.ctx.toolOutputExpanded);
								this.ctx.chatContainer.addChild(readGroup);
							}
							readGroup.updateArgs(content.arguments, content.id);
							this.ctx.pendingTools.set(content.id, readGroup);
							if (assistantComponent) {
								readToolCallAssistantComponents.set(content.id, assistantComponent);
							}
						} else {
							const normalizedArgs = normalizeToolArgs(content.arguments);
							readToolCallArgs.set(content.id, normalizedArgs);
							if (assistantComponent) {
								readToolCallAssistantComponents.set(content.id, assistantComponent);
							}
						}
						appendAssistantSegment(afterToolSegment);
						continue;
					}

					readGroup?.seal();
					readGroup = null;
					const tool = this.ctx.viewSession.getToolByName(content.name);
					const partialJson = getStreamingPartialJson(content);
					const rawInput = content.customWireName !== undefined;
					const renderArgs = partialJson
						? decodeStreamedToolArgs(partialJson, {
								rawInput,
								fullArgs: content.arguments,
								streamingStringKeys: streamingStringKeysForTool(content.name, rawInput),
								argot: this.ctx.viewSession.getArgotSession?.(),
							})
						: content.arguments;
					const component = new ToolExecutionComponent(
						content.name,
						renderArgs,
						{
							snapshots: getFileSnapshotStore(this.ctx.viewSession),
							showImages: settings.get("terminal.showImages"),
							editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
							editAllowFuzzy: settings.get("edit.fuzzyMatch"),
							liveRegion: this.ctx.chatContainer,
						},
						tool,
						this.ctx.ui,
						this.ctx.viewSession.sessionManager.getCwd(),
						content.id,
					);
					component.setExpanded(this.ctx.toolOutputExpanded);
					this.ctx.chatContainer.addChild(component);

					if (hasErrorStop && errorMessage) {
						component.updateResult(turnFailedToolResult(errorMessage), false, content.id);
						this.ctx.settledToolCalls.add(content.id);
					} else {
						this.ctx.pendingTools.set(content.id, component);
					}
					appendAssistantSegment(afterToolSegment);
				}
				const strippedToolCalls = (message as AgentMessage & StrippedToolCallsMarker).strippedToolCalls ?? 0;
				if (strippedToolCalls > 0) {
					this.ctx.chatContainer.addChild(
						new Text(
							theme.fg(
								"dim",
								theme.italic(
									`${formatCount("tool call", strippedToolCalls)} elided — no result on this branch`,
								),
							),
							1,
							0,
						),
					);
				}
				pendingUsage =
					this.ctx.settings.get("display.showTokenUsage") && assistantUsageIsBilled(message.usage)
						? message.usage
						: undefined;
				pendingUsageDuration = message.duration;
				pendingUsageTtft = message.ttft;
			} else if (message.role === "toolResult") {
				const backgroundStillRunning = isLiveBackgroundTask(message.toolName, message.details);
				if (backgroundStillRunning) liveBackgroundCalls.add(message.toolCallId);
				else this.ctx.settledToolCalls.add(message.toolCallId);
				const pendingReadComponent = this.ctx.pendingTools.get(message.toolCallId);
				const isReadGroupResult =
					message.toolName === "read" &&
					(!pendingReadComponent || pendingReadComponent instanceof ReadToolGroupComponent);
				if (isReadGroupResult) {
					const assistantComponent = readToolCallAssistantComponents.get(message.toolCallId);
					const images: ImageContent[] = message.content.filter(
						(content): content is ImageContent => content.type === "image",
					);
					if (images.length > 0 && assistantComponent && settings.get("terminal.showImages")) {
						assistantComponent.setToolResultImages(message.toolCallId, images);
						const hasText = message.content.some(c => c.type === "text");
						if (!hasText) {
							readToolCallArgs.delete(message.toolCallId);
							readToolCallAssistantComponents.delete(message.toolCallId);
							continue;
						}
					}
					let component = this.ctx.pendingTools.get(message.toolCallId);
					if (!component) {
						if (!readGroup) {
							readGroup = new ReadToolGroupComponent({
								showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
							});
							readGroup.setExpanded(this.ctx.toolOutputExpanded);
							this.ctx.chatContainer.addChild(readGroup);
						}
						const args = readToolCallArgs.get(message.toolCallId);
						if (args) {
							readGroup.updateArgs(args, message.toolCallId);
						}
						component = readGroup;
						this.ctx.pendingTools.set(message.toolCallId, readGroup);
					}
					component.updateResult(message, false, message.toolCallId);
					this.ctx.pendingTools.delete(message.toolCallId);
					readToolCallArgs.delete(message.toolCallId);
					readToolCallAssistantComponents.delete(message.toolCallId);
					continue;
				}

				const component = this.ctx.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message, backgroundStillRunning, message.toolCallId);
					if (backgroundStillRunning) continue;
					this.ctx.pendingTools.delete(message.toolCallId);
					if (
						message.toolName === "job" &&
						component instanceof ToolExecutionComponent &&
						component.isDisplaceableBlock()
					) {
						waitingPoll = component;
					} else if (
						message.toolName === "todo" &&
						component instanceof ToolExecutionComponent &&
						component.canBeDisplacedBy("todo")
					) {
						resolveTodoSnapshot("todo");
						todoSnapshot = component;
					}
				}
			} else {
				if (message.role === "user") resolveWaitingPoll();
				if (message.role === "user") resolveTodoSnapshot();
				this.ctx.addMessageToChat(message, options);
			}
		}
		flushPendingUsage();

		readGroup?.seal();
		resolveWaitingPoll();
		if (todoSnapshot && this.ctx.viewSession.isStreaming) {
			this.ctx.eventController?.inheritDisplaceableTodo(todoSnapshot);
			todoSnapshot = null;
		} else {
			resolveTodoSnapshot();
		}

		if (this.ctx.viewSession.isStreaming) {
			for (const [toolCallId, component] of this.ctx.pendingTools) {
				component.setArgsComplete(toolCallId);
			}
		} else {
			for (const [toolCallId, component] of this.ctx.pendingTools) {
				if (liveBackgroundCalls.has(toolCallId)) continue;
				component.seal();
				this.ctx.settledToolCalls.add(toolCallId);
				this.ctx.pendingTools.delete(toolCallId);
			}
		}
		this.ctx.ui.requestRender();
	}

	renderInitialMessages(options: RenderInitialMessagesOptions = {}): void {
		const preservedChatChildren = options.preserveExistingChat ? this.ctx.chatContainer.children : undefined;
		this.ctx.initialChatRendered = true;
		if (preservedChatChildren) {
			this.ctx.chatContainer.clear();
		} else {
			this.ctx.resetTranscript();
		}
		this.ctx.pendingMessagesContainer.disposeChildren();
		this.ctx.pendingBashComponents = [];
		this.ctx.pendingPythonComponents = [];

		const context = this.ctx.viewSession.buildTranscriptSessionContext({
			collapseCompactedHistory: settings.get("display.collapseCompacted"),
			keepDanglingToolCalls: this.ctx.viewSession.isStreaming,
		});
		this.ctx.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: !this.ctx.focusedAgentId,
		});

		const allEntries = this.ctx.viewSession.sessionManager.getEntries();
		let compactionCount = 0;
		for (const entry of allEntries) {
			if (entry.type === "compaction") {
				compactionCount++;
			}
		}
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.ctx.showStatus(`Session compacted ${times}`);
		}
		if (options.clearTerminalHistory) {
			this.ctx.ui.requestRender(true, { clearScrollback: true });
		}
		if (preservedChatChildren && preservedChatChildren.length > 0) {
			for (const child of preservedChatChildren) {
				this.ctx.chatContainer.addChild(child);
			}
			this.ctx.ui.requestRender();
		}
	}

	clearEditor(): void {
		this.ctx.editor.clearDraft();
		this.ctx.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.ctx.present([new Spacer(1), new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0)]);
	}

	showWarning(warningMessage: string): void {
		this.ctx.present([new Spacer(1), new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0)]);
	}

	showUpdateReadyNotification(newVersion: string, warnings: readonly string[] = []): void {
		const block = new TranscriptBlock();
		block.addChild(
			new Text(
				theme.fg("accent", `${APP_NAME} ${newVersion} installed`) + theme.fg("dim", " · restart to use it"),
				1,
				0,
			),
		);
		if (warnings.length > 0) {
			const noun = warnings.length === 1 ? "completion file" : "completion files";
			block.addChild(
				new Text(
					theme.fg(
						"warning",
						`${warnings.length} shell ${noun} could not be refreshed · re-run the installer to rewrite ${warnings.length === 1 ? "it" : "them"}`,
					),
					1,
					0,
				),
			);
		}
		this.ctx.present(block);
	}

	showUpdateFailedNotification(newVersion: string, error: string): void {
		this.ctx.showError(
			`Automatic update to ${APP_NAME} ${newVersion} failed: ${error}\nRun \`${APP_NAME} update\` to retry, or turn off Automatic Updates in /settings.`,
		);
	}

	showUnparseableSettingsNotification(files: readonly { path: string; quarantinePath: string }[]): void {
		const lines = files.map(file => `  ${file.path}\n    original kept at ${file.quarantinePath}`).join("\n");
		this.ctx.showError(
			`Could not read your settings, so this session is using defaults for them:\n${lines}\n` +
				"Fix the syntax in the file above, or copy the preserved file back over it.",
		);
	}

	showSettingsSaveFailureNotification(failure: SettingsSaveFailure): void {
		const attempts = `${failure.attempts} attempt${failure.attempts === 1 ? "" : "s"}`;
		this.ctx.showError(
			`Could not save your settings after ${attempts}, so this change will not survive a restart:\n` +
				`  ${failure.path}\n    ${failure.reason}\n` +
				"Check that the file and its directory are writable, then change the setting again.",
		);
	}

	showNewVersionNotification(newVersion: string): void {
		const block = new TranscriptBlock();
		block.addChild(
			new Text(
				theme.fg("accent", `${APP_NAME} ${newVersion} available`) +
					theme.fg("dim", " · run ") +
					theme.fg("accent", `${APP_NAME} update`) +
					theme.fg("dim", " · ") +
					theme.fg("accent", "/changelog") +
					theme.fg("dim", " for what's new"),
				1,
				0,
			),
		);
		this.ctx.present(block);
	}

	showPluginUpdatesNotification(count: number): void {
		const plural = count === 1 ? "update" : "updates";
		const block = new TranscriptBlock();
		block.addChild(
			new Text(
				theme.fg("accent", `${count} plugin ${plural} available`) +
					theme.fg("dim", " · run ") +
					theme.fg("accent", "/plugins") +
					theme.fg("dim", " to install"),
				1,
				0,
			),
		);
		this.ctx.present(block);
	}

	showPluginUpdatesInstalledNotification(count: number): void {
		const plural = count === 1 ? "plugin" : "plugins";
		const block = new TranscriptBlock();
		block.addChild(
			new Text(
				theme.fg("accent", `Updated ${count} ${plural}`) + theme.fg("dim", " · restart to load the new versions"),
				1,
				0,
			),
		);
		this.ctx.present(block);
	}

	updatePendingMessagesDisplay(): void {
		this.ctx.pendingMessagesContainer.disposeChildren();
		const queuedMessages = this.ctx.viewSession.getQueuedMessages() as QueuedMessages;

		const steeringMessages = queuedMessages.steering.slice();
		for (const entry of this.ctx.compactionQueuedMessages as CompactionQueuedMessage[]) {
			if (entry.mode === "steer") steeringMessages.push(entry.text);
		}

		const followUpMessages = queuedMessages.followUp.slice();
		for (const entry of this.ctx.compactionQueuedMessages as CompactionQueuedMessage[]) {
			if (entry.mode === "followUp") followUpMessages.push(entry.text);
		}

		const groups = [
			{ label: "Steering", messages: steeringMessages },
			{ label: "After yield", messages: followUpMessages },
		].filter(group => group.messages.length > 0);
		if (groups.length > 0) {
			this.ctx.pendingMessagesContainer.addChild(new Spacer(1));
			for (const group of groups) {
				const heading = theme.fg("muted", `${group.label}${theme.sep.dot}${group.messages.length}`);
				this.ctx.pendingMessagesContainer.addChild(new TruncatedText(heading, 1, 0));
				for (let index = 0; index < group.messages.length; index++) {
					const message = replaceTabs(group.messages[index] ?? "").replace(/\r?\n/g, " ↵ ");
					const queuedText = theme.fg("dim", `  ${index + 1}. ${message}`);
					this.ctx.pendingMessagesContainer.addChild(new TruncatedText(queuedText, 1, 0));
				}
			}
			const dequeueKey = this.ctx.keybindings.getDisplayString("app.message.dequeue") || "Alt+Up";
			const hintText = theme.fg("dim", `  ${theme.tree.hook} ${dequeueKey} to edit`);
			this.ctx.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
		this.ctx.refreshComposerShortcuts();
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void {
		const queuedImages = images && images.length > 0 ? images : undefined;
		this.ctx.compactionQueuedMessages.push({ text, mode, images: queuedImages } as CompactionQueuedMessage);
		this.ctx.editor.clearDraft(text);
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.showStatus(
			queuedImages ? "Queued message with image for after compaction" : "Queued message for after compaction",
		);
	}

	async #deliverQueuedMessage(message: CompactionQueuedMessage): Promise<void> {
		if (
			await invokeSkillCommandFromText(this.ctx, message.text, message.mode, {
				propagateErrors: true,
				queueOnly: true,
				images: message.images,
			})
		) {
			return;
		}
		if (this.ctx.isKnownSlashCommand(message.text)) {
			await this.ctx.session.prompt(message.text);
			return;
		}
		await this.ctx.withLocalSubmission(
			message.text,
			() =>
				message.mode === "followUp"
					? this.ctx.session.followUp(message.text, message.images)
					: this.ctx.session.steer(message.text, message.images),
			{ imageCount: message.images?.length ?? 0 },
		);
	}

	isKnownSlashCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		if (!commandName) return false;

		if (this.ctx.session.extensionRunner?.getCommand(commandName)) {
			return true;
		}

		for (const command of this.ctx.session.customCommands) {
			if (command.command.name === commandName) {
				return true;
			}
		}

		return this.ctx.fileSlashCommands.has(commandName);
	}

	async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.ctx.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...(this.ctx.compactionQueuedMessages as CompactionQueuedMessage[])];
		this.ctx.compactionQueuedMessages = [] as CompactionQueuedMessage[];
		this.ctx.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.ctx.session.clearQueue();
			this.ctx.compactionQueuedMessages = queuedMessages;
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${errorMessage(error)}`,
			);
		};

		try {
			if (options?.willRetry) {
				for (const message of queuedMessages) {
					await this.#deliverQueuedMessage(message);
				}
				this.ctx.updatePendingMessagesDisplay();
				return;
			}

			let firstPromptIndex = -1;
			for (let i = 0; i < queuedMessages.length; i++) {
				if (!this.ctx.isKnownSlashCommand(queuedMessages[i].text)) {
					firstPromptIndex = i;
					break;
				}
			}
			if (firstPromptIndex === -1) {
				for (const message of queuedMessages) {
					await this.ctx.session.prompt(message.text);
				}
				return;
			}

			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.#deliverQueuedMessage(message);
			}

			let promptPromise: Promise<unknown>;
			if (isKnownSkillCommand(this.ctx, firstPrompt.text)) {
				const built = await buildSkillCommandPrompt(
					this.ctx,
					firstPrompt.text,
					firstPrompt.mode,
					firstPrompt.images,
				);
				promptPromise = built
					? this.ctx.session.promptCustomMessage(built.message, built.options).catch(restoreQueue)
					: Promise.resolve();
			} else {
				const disposeFirstPrompt = this.ctx.recordLocalSubmission(
					firstPrompt.text,
					firstPrompt.images?.length ?? 0,
				);
				promptPromise = this.ctx.session
					.prompt(firstPrompt.text, {
						streamingBehavior: firstPrompt.mode === "followUp" ? "followUp" : "steer",
						images: firstPrompt.images,
					})
					.catch((error: unknown) => {
						disposeFirstPrompt();
						restoreQueue(error);
					});
			}

			for (const message of rest) {
				await this.#deliverQueuedMessage(message);
			}
			this.ctx.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	flushPendingBashComponents(): void {
		for (const component of this.ctx.pendingBashComponents) {
			this.ctx.pendingMessagesContainer.removeChild(component);
			this.ctx.chatContainer.addChild(component);
		}
		this.ctx.pendingBashComponents = [];
		for (const component of this.ctx.pendingPythonComponents) {
			this.ctx.pendingMessagesContainer.removeChild(component);
			this.ctx.chatContainer.addChild(component);
		}
		this.ctx.pendingPythonComponents = [];
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.ctx.viewSession.messages.length - 1; i >= 0; i--) {
			const message = this.ctx.viewSession.messages[i];
			if (message?.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	extractAssistantText(message: AssistantMessage): string {
		let text = "";
		const blocks = message.content;
		for (let ci = 0; ci < blocks.length; ci++) {
			if (blocks[ci]!.type === "text") {
				text += (blocks[ci] as TextContent).text;
			}
		}
		return text.trim();
	}
}
