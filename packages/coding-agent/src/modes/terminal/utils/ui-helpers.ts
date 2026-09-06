import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ImageContent, Message } from "@veyyon/ai";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import { type Component, Spacer, Text, TruncatedText } from "@veyyon/tui";
import { APP_NAME, errorMessage } from "@veyyon/utils";
import { type SettingsSaveFailure, settings } from "../../../config/settings";
import { getFileSnapshotStore } from "../../../edit/file-snapshot-store";
import { theme } from "../../../theme/theme";
import { replaceTabs } from "../../../tools/core/render-utils";
import { ChatTranscriptBuilder, userMessageText } from "../components/transcript/chat-transcript-builder";
import { TranscriptBlock } from "../components/transcript/transcript-container";
import { materializeImageReferenceLinksSync } from "../image-references";
import { buildSkillCommandPrompt, invokeSkillCommandFromText, isKnownSkillCommand } from "../skill-command";
import type { CompactionQueuedMessage, InteractiveModeContext } from "../types";
/**
 * The slice of the interactive context this uses: 34 members of the 215
 * `InteractiveModeContext` requires. Still a slice, and naming it is what lets a
 * test construct one without the `as unknown as InteractiveModeContext` cast the
 * full interface forces (see `CollabHostContext`).
 */
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
	/** The warning line most recently appended, so an identical repeat can be recognised. */
	#lastWarningText: Text | undefined;
	#lastWarningMessage: string | undefined;
	readonly #builder: ChatTranscriptBuilder;

	constructor(private ctx: UiHelpersContext) {
		this.#builder = new ChatTranscriptBuilder({
			ui: ctx.ui,
			container: () => this.ctx.chatContainer,
			pendingTools: () => this.ctx.pendingTools,
			settledToolCalls: () => this.ctx.settledToolCalls,
			cwd: () => this.ctx.viewSession.sessionManager.getCwd(),
			getSettings: () => this.ctx.settings,
			getTool: name => ctx.viewSession.getToolByName(name),
			getMessageRenderer: customType => ctx.viewSession.extensionRunner?.getMessageRenderer(customType),
			getThinkingRenderers: () => ctx.viewSession.extensionRunner?.getAssistantThinkingRenderers(),
			getSnapshots: () => getFileSnapshotStore(ctx.viewSession),
			getArgotSession: () => ctx.viewSession.getArgotSession?.(),
			isStreaming: () => ctx.viewSession.isStreaming,
			retryAttempt: () => ctx.viewSession.retryAttempt,
			hideThinkingBlock: () => ctx.effectiveHideThinkingBlock,
			proseOnlyThinking: () => ctx.proseOnlyThinking,
			requestRender: () => ctx.ui.requestRender(),
			resolveImageLinks: message =>
				imageLinksForMessage(
					message,
					ctx.viewSession.sessionManager.putBlobSync.bind(ctx.viewSession.sessionManager),
				),
			onPopulateHistory: text => {
				ctx.editor.addToHistory(text);
			},
			onInheritDisplaceableTodo: component => {
				ctx.eventController?.inheritDisplaceableTodo(component);
			},
			getLastAssistantUsage: () => ctx.lastAssistantUsage,
			setLastAssistantUsage: usage => {
				ctx.lastAssistantUsage = usage;
			},
			initialExpanded: ctx.toolOutputExpanded,
			indentFileMentions: 0,
		});
	}

	/** Extract text content from a user message */
	getUserMessageText(message: Message): string {
		return message.role === "user" ? userMessageText(message) : "";
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
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
		this.#builder.setExpanded(this.ctx.toolOutputExpanded);
		return this.#builder.appendMessage(message, options);
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		if (options.updateFooter) {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}
		this.#builder.setExpanded(this.ctx.toolOutputExpanded);
		this.#builder.rebuild(sessionContext, options);
	}

	renderInitialMessages(options: RenderInitialMessagesOptions = {}): void {
		// This path is used to rebuild the visible chat transcript (e.g. after custom/debug UI).
		// Clear existing rendered chat first to avoid duplicating the full session in the container.
		// On a non-preserving rebuild the existing blocks are discarded for good, so
		// dispose them (stopping any live timers/subscriptions) before clearing. When
		// preserving, the same instances are re-added below, so detach without dispose.
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

		// Live display collapses to the compacted transcript tail unless the
		// user opted into the full inline history; export/resume callers can
		// still request either mode. Mid-turn rebuilds
		// (focus attach/unfocus while a tool executes) keep dangling toolCalls so
		// the in-flight call re-renders as pending instead of vanishing;
		// renderSessionContext then keeps it in `pendingTools` for live routing.
		const context = this.ctx.viewSession.buildTranscriptSessionContext({
			collapseCompactedHistory: settings.get("display.collapseCompacted"),
			keepDanglingToolCalls: this.ctx.viewSession.isStreaming,
		});
		this.ctx.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: !this.ctx.focusedAgentId,
		});

		// Show compaction info if session was compacted
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

	/**
	 * Show a warning in the chat.
	 *
	 * The same warning twice with nothing else added between them is one warning: a compaction
	 * dead end is reported by the prompt-time check and again by the continuation it schedules
	 * 100ms later, and the second line told the reader nothing the first had not. A different
	 * warning, or the same one after other content, still gets its own line.
	 */
	showWarning(warningMessage: string): void {
		const children = this.ctx.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		if (last !== undefined && last === this.#lastWarningText && this.#lastWarningMessage === warningMessage) {
			return;
		}
		const text = new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0);
		this.ctx.present([new Spacer(1), text]);
		this.#lastWarningText = text;
		this.#lastWarningMessage = warningMessage;
	}

	showUpdateReadyNotification(newVersion: string, warnings: readonly string[] = []): void {
		// An automatic update finished writing the new binary. It cannot affect the
		// process already running, so say what the user has to do about it.
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
		// An automatic update that fails must say so. Staying quiet would pin you to
		// an old version with nothing to notice and nothing to act on (Law 10).
		this.ctx.showError(
			`Automatic update to ${APP_NAME} ${newVersion} failed: ${error}\nRun \`${APP_NAME} update\` to retry, or turn off Automatic Updates in /settings.`,
		);
	}

	showUnparseableSettingsNotification(files: readonly { path: string; quarantinePath: string }[]): void {
		// The session is running without these files' settings. Saying nothing
		// would let a user spend a session wondering why their configuration
		// stopped applying (Law 10). The rescued copy is named so the fix is
		// obvious: correct the syntax, or copy the old file back over.
		const lines = files.map(file => `  ${file.path}\n    original kept at ${file.quarantinePath}`).join("\n");
		this.ctx.showError(
			`Could not read your settings, so this session is using defaults for them:\n${lines}\n` +
				"Fix the syntax in the file above, or copy the preserved file back over it.",
		);
	}

	showSettingsSaveFailureNotification(failure: SettingsSaveFailure): void {
		// The counterpart to showUnparseableSettingsNotification: that one covers a config
		// veyyon could not READ, this one a config it cannot WRITE. Both leave the user
		// with settings that are not what they think they are, and both used to be a log
		// line nobody sees. Here the in-memory value DID change, so the UI already showed
		// the new setting: without this the user only finds out on their next launch, when
		// it silently reverts (Law 10).
		// "1 attempt", not "1 attempts": a refused GLOBAL write is announced on the
		// first failure (nothing retries it), so the count is routinely 1 here.
		const attempts = `${failure.attempts} attempt${failure.attempts === 1 ? "" : "s"}`;
		this.ctx.showError(
			`Could not save your settings after ${attempts}, so this change will not survive a restart:\n` +
				`  ${failure.path}\n    ${failure.reason}\n` +
				"Check that the file and its directory are writable, then change the setting again.",
		);
	}

	showNewVersionNotification(newVersion: string): void {
		// A single quiet line, not a warning box: the update is good news, not an
		// alarm. Points at `/changelog` (which opens the web release notes).
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
		// `marketplace.autoUpdate: notify` promises a notification. It used to write
		// a debug log line, which no user sees, so the setting's own description was
		// false. Same quiet single line as the version notice, pointing at the
		// command that applies the updates.
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
		// The `auto` half. Installing plugins behind the user's back with no line in
		// the transcript is the same silent-change problem in the other direction.
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

		const steeringMessages = [...queuedMessages.steering];
		for (const entry of this.ctx.compactionQueuedMessages as CompactionQueuedMessage[]) {
			if (entry.mode === "steer") steeringMessages.push(entry.text);
		}

		const followUpMessages = [...queuedMessages.followUp];
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
		// Every call site here follows a queue mutation (enqueue/dequeue/clear/restore),
		// so this is the one choke point where the composer's queue chip needs refreshing.
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
				// preCommands are all slash commands; #deliverQueuedMessage handles
				// that branch (no local-submission marking needed since slash
				// commands don't generate a matching user message_start).
				await this.#deliverQueuedMessage(message);
			}

			// First prompt is fire-and-forget — its rejection is funneled through
			// `restoreQueue` rather than rethrown. Plain prompts use primitive
			// recordLocalSubmission and dispose manually in the catch. Skill prompts
			// are rebuilt as user-attributed custom messages so queued `/skill:` text
			// is not sent as a literal prompt after compaction.
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

	/** Move pending bash components from pending area to chat */
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
		for (const content of message.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}
		return text.trim();
	}
}
