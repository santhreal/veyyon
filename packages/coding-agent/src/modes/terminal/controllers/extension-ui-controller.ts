import { abortDetached } from "@veyyon/kernel/session/detached-abort";
import {
	type Component,
	Container,
	DEFAULT_MASK_CHAR,
	type OverlayHandle,
	type OverlayOptions,
	Spacer,
	TERMINAL,
	Text,
	type TUI,
} from "@veyyon/tui";
import { clampLow, errorMessage } from "@veyyon/utils";
import type { SgrMouseEvent } from "@veyyon/utils/mouse";
import type { CollabUiRequestDraft, CollabUiSelectItem } from "@veyyon/wire";
import { type AutoresearchUiDelegate, registerAutoresearchUi } from "../../../autoresearch/dashboard";
import { KeybindingsManager } from "../../../config/keybindings";
import type {
	CompactOptions,
	ExtensionActions,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionError,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
	ExtensionUiComponent,
	ExtensionWidgetOptions,
	SendUserMessageHandler,
	TerminalInputHandler,
} from "../../../extensibility/extensions";
import { runExtensionSetModel } from "../../../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../../../extensibility/extensions/get-commands-handler";
import { createExtensionModelQuery } from "../../../extensibility/extensions/model-api";
import type { TerminalWidgetContent } from "../../../extensibility/terminal-capability";
import { toConfirmDialog, toPromptDialog, toSelectDialog } from "../../../presentation/overlay-builder";
import { normalizeCustomMessagePayload, USER_INTERRUPT_LABEL } from "../../../session/messages";
import { getAvailableThemesWithPaths, getThemeByName, setTheme, type Theme, theme } from "../../../theme/theme";
import {
	ASK_CHAT_OPTION_LABEL,
	ASK_NEXT_OPTION_LABEL,
	ASK_OTHER_OPTION_LABEL,
} from "../../../tools/agent/ask-option-labels";
import { setTerminalTitle } from "../../../utils/title-generator";
import { AskDialogComponent, boundPromptTitle } from "../components/dialogs/ask-dialog";
import { HookEditorComponent } from "../components/dialogs/hook-editor";
import { HookInputComponent } from "../components/dialogs/hook-input";
import { HookSelectorComponent, type HookSelectorSlider } from "../components/selectors/hook-selector";
import type { InteractiveModeContext, InteractiveSelectorDialogOptions } from "../types";

/**
 * The slice of the interactive context this uses: 31 members of the 215
 * `InteractiveModeContext` requires. Still a slice, and naming it is what lets a
 * test construct one without the `as unknown as InteractiveModeContext` cast the
 * full interface forces (see `CollabHostContext`).
 */
export type ExtensionUiControllerContext = Pick<
	InteractiveModeContext,
	| "addAutocompleteProvider"
	| "clearWorkingLoader"
	| "clearTransientSessionUi"
	| "collabHost"
	| "editor"
	| "editorContainer"
	| "executeCompaction"
	| "focusActiveEditorArea"
	| "hookEditor"
	| "hookInput"
	| "hookSelector"
	| "hookWidgetContainerAbove"
	| "hookWidgetContainerBelow"
	| "initialChatRendered"
	| "present"
	| "rebuildChatFromMessages"
	| "reloadTodos"
	| "renderInitialMessages"
	| "resetTranscript"
	| "session"
	| "sessionManager"
	| "setEditorComponent"
	| "setToolNotifier"
	| "setToolUIContext"
	| "setToolsExpanded"
	| "setWorkingMessage"
	| "showError"
	| "showStatus"
	| "showWarning"
	| "shutdownRequested"
	| "statusLine"
	| "toolOutputExpanded"
	| "ui"
>;

const MAX_WIDGET_LINES = 10;

interface CollabDialogWinner {
	source: "local" | "remote";
	value: string | undefined;
}

interface CollabAskDialogWinner {
	source: "local" | "remote";
	value: ExtensionAskDialogResult | undefined;
}
/** Tagged result from a guest UI request, distinguishing a real answer (even
 *  one whose literal value is "unavailable"), an explicit guest cancel, and a
 *  transport-unavailable sentinel (collab teardown / abort). Replaces the old
 *  `string | "unavailable" | undefined` channel that let a guest answer of
 *  "unavailable" collide with the transport sentinel. */
type GuestUiResult = { kind: "answered"; value: string } | { kind: "cancelled" } | { kind: "unavailable" };

/** What a guest answered to one ask question: the options it checked and the text it typed after picking Other. */
interface GuestAskAnswer {
	selected: Set<string>;
	customInput: string | undefined;
}

/** One guest pick: a row label, or the text typed into the editor the Other row opens. */
type GuestAskPick = { label: string } | { customInput: string };

/** How a guest left an ask question without answering it: Chat, a lost transport, or a cancel. */
type GuestAskExit = "chat" | "unavailable" | undefined;

/**
 * The select a multi-choice guest question shows with `selected` checked.
 *
 * Mirrors the local dialog's Next gating: the Next row is omitted until an option is checked, so a guest cannot submit
 * an empty multi-select result (PRRT_kwDOQxs0bc6OFbDW). The remote select has no "disabled" row, so the row is omitted
 * rather than dimmed. An Other answer ends the question, so only a checked option opens Next.
 */
function multiSelectRequest(
	question: ExtensionAskDialogQuestion,
	options: CollabUiSelectItem[],
	other: CollabUiSelectItem[],
	selected: Set<string>,
): CollabUiRequestDraft {
	const hasAnswer = selected.size > 0;
	const rows = options.concat(other);
	if (hasAnswer) rows.push(ASK_NEXT_OPTION_LABEL);
	rows.push(ASK_CHAT_OPTION_LABEL);
	const checkedIndices: number[] = [];
	for (const [index, option] of question.options.entries()) {
		if (selected.has(option.label)) checkedIndices.push(index);
	}
	return {
		kind: "select",
		title: question.question,
		options: rows,
		selectionMarker: "checkbox",
		checkedIndices,
		markableCount: question.options.length,
		helpText: hasAnswer
			? "up/down navigate  enter toggle  Next → continue  esc cancel"
			: "up/down navigate  enter toggle  esc cancel",
	};
}

function toWireSelectOptions(options: ExtensionUISelectItem[]): CollabUiSelectItem[] {
	return options.map(option =>
		typeof option === "string"
			? option
			: option.description
				? { label: option.label, description: option.description }
				: { label: option.label },
	);
}

export class ExtensionUiController {
	#extensionTerminalInputUnsubscribers = new Set<() => void>();
	#hookWidgetsAbove = new Map<string, ExtensionUiComponent>();
	#hookWidgetsBelow = new Map<string, ExtensionUiComponent>();
	// Single-file dialog surface (`editorContainer` + focus) is shared by the
	// selector / input / editor modals, so only one may be presented at a time;
	// the rest queue. See `#presentDialog`.
	#dialogActive = false;
	#dialogQueue: Array<() => void> = [];
	/** Live overlay for the hook selector card, so `hide` reaches the right one. */
	#hookSelectorOverlay: OverlayHandle | undefined;
	/** Live overlay for the hook input card. */
	#hookInputOverlay: OverlayHandle | undefined;
	/** Live overlay for the hook editor card. */
	#hookEditorOverlay: OverlayHandle | undefined;
	constructor(private ctx: ExtensionUiControllerContext) {}

	/**
	 * Initialize the hook system with TUI-based UI context.
	 */
	async initHooksAndCustomTools(): Promise<void> {
		// Create and set hook & tool UI context
		const uiContext: ExtensionUIContext = {
			timeoutStartsOnPresentation: true,
			select: (title, options, dialogOptions) => this.showCollabAwareSelector(title, options, dialogOptions),
			confirm: (title, message, _dialogOptions) => this.showHookConfirm(title, message),
			input: (title, placeholder, dialogOptions) => this.showHookInput(title, placeholder, dialogOptions),
			askDialog: (questions, dialogOptions) => this.showAskDialog(questions, dialogOptions),
			notify: (message, type) => this.showHookNotify(message, type),
			onTerminalInput: handler => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setHookStatus(key, text),
			setWorkingMessage: message => this.ctx.setWorkingMessage(message),
			setWidget: (key, content, options) => this.setHookWidget(key, content, options),
			setTitle: title => setTerminalTitle(title),
			terminal: {
				custom: (factory, options) => this.showHookCustom(factory, options),
				setWidgetComponent: (key, factory, options) => this.setHookWidget(key, factory, options),
				setEditorComponent: factory => this.ctx.setEditorComponent(factory),
			},
			setEditorText: text => {
				this.ctx.editor.setText(text);
				this.ctx.ui.requestRender();
			},
			pasteToEditor: text => {
				this.ctx.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
				this.ctx.ui.requestRender();
			},
			getEditorText: () => this.ctx.editor.getText(),
			editor: (title, prefill, dialogOptions, editorOptions) =>
				this.showCollabAwareEditor(title, prefill, dialogOptions, editorOptions),
			addAutocompleteProvider: factory => this.ctx.addAutocompleteProvider(factory),
			get theme() {
				return theme;
			},
			getAllThemes: async () => (await getAvailableThemesWithPaths()).map(t => ({ name: t.name, path: t.path })),
			getTheme: name => getThemeByName(name),
			setTheme: async themeArg => {
				if (typeof themeArg === "string") {
					return await setTheme(themeArg, true);
				}
				// Theme object passed directly - not supported in current implementation
				return Promise.resolve({ success: false, error: "Direct theme object not supported" });
			},
			getToolsExpanded: () => this.ctx.toolOutputExpanded,
			setToolsExpanded: expanded => this.ctx.setToolsExpanded(expanded),
		};
		this.ctx.setToolUIContext(uiContext, true);
		// This host CAN reach an operator who is looking elsewhere, so it installs
		// the delivery a tool's notification rides. TerminalNotification extends
		// HostNotification, which is what makes this a pass-through rather than a
		// translation, and a GUI host installs its own here instead.
		this.ctx.setToolNotifier(notification => {
			TERMINAL.sendNotification(notification);
		});

		this.initializeHookRunner(uiContext, true);
		const extensionRunner = this.ctx.session.extensionRunner;
		if (!extensionRunner) {
			return;
		}
		// Subscribe to extension errors
		extensionRunner.onError((error: ExtensionError) => {
			this.showExtensionError(error.extensionPath, error.error);
		});

		// Emit session_start event
		await extensionRunner.emit({
			type: "session_start",
		});
	}

	setHookWidget(key: string, content: TerminalWidgetContent, options?: ExtensionWidgetOptions): void {
		const placement = options?.placement ?? "aboveEditor";
		removeHookWidget(this.#hookWidgetsAbove, key);
		removeHookWidget(this.#hookWidgetsBelow, key);

		if (content === undefined) {
			this.#rebuildHookWidgets();
			return;
		}

		const target = placement === "belowEditor" ? this.#hookWidgetsBelow : this.#hookWidgetsAbove;
		target.set(key, this.#createHookWidget(content));
		this.#rebuildHookWidgets();
	}

	#createHookWidget(content: TerminalWidgetContent): ExtensionUiComponent {
		if (Array.isArray(content)) {
			const container = new Container();
			for (const line of content.slice(0, MAX_WIDGET_LINES)) {
				// A whitespace-only Text renders zero rows, so a deliberate blank separator in
				// extension-supplied content needs a Spacer to survive.
				container.addChild(line.trim() === "" ? new Spacer(1) : new Text(line, 1, 0));
			}
			if (content.length > MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			return container;
		}
		if (content === undefined) {
			throw new Error("Widget content missing");
		}
		return content(this.ctx.ui, theme);
	}

	#rebuildHookWidgets(): void {
		renderHookWidgetContainer(this.ctx.hookWidgetContainerAbove, this.#hookWidgetsAbove, true, true);
		renderHookWidgetContainer(this.ctx.hookWidgetContainerBelow, this.#hookWidgetsBelow, false, false);
		this.ctx.ui.requestRender();
	}

	initializeHookRunner(uiContext: ExtensionUIContext, _hasUI: boolean): void {
		const extensionRunner = this.ctx.session.extensionRunner;
		if (!extensionRunner) {
			return;
		}

		const actions: ExtensionActions = {
			sendMessage: (message, options) => {
				const wasStreaming = this.ctx.session.isStreaming;
				const normalized = normalizeCustomMessagePayload(message);
				this.ctx.session
					.sendCustomMessage(normalized, options)
					.then(() => this.#applyCustomMessageDisplay(wasStreaming, normalized.display))
					.catch((err: unknown) => {
						const errorText = `Extension sendMessage failed: ${errorMessage(err)}`;
						this.ctx.showError(errorText);
					});
			},
			sendUserMessage: this.#sendExtensionUserMessage,
			appendEntry: (customType, data) => {
				this.ctx.sessionManager.appendCustomEntry(customType, data);
			},
			setLabel: (targetId, label) => {
				this.ctx.sessionManager.appendLabelChange(targetId, label);
			},
			getActiveTools: () => this.ctx.session.getActiveToolNames(),
			getAllTools: () => this.ctx.session.getAllToolNames(),
			setActiveTools: toolNames => this.ctx.session.setActiveToolsByName(toolNames),
			setModel: (model, options) => runExtensionSetModel(this.ctx.session, model, options),
			getThinkingLevel: () => this.ctx.session.thinkingLevel,
			setThinkingLevel: (level, persist) => this.ctx.session.setThinkingLevel(level, persist),
			getCommands: () => getSessionSlashCommands(this.ctx.session),
			getSessionName: () => this.ctx.sessionManager.getSessionName(),
			setSessionName: name => this.#updateSessionName(name),
		};
		const contextActions: ExtensionContextActions = {
			getModel: () => this.ctx.session.model,
			isIdle: () => !this.ctx.session.isStreaming,
			abort: () => {
				abortDetached(this.ctx.session, "extension-ui-controller.initializeHookRunner.abort", USER_INTERRUPT_LABEL);
			},
			hasPendingMessages: () => this.ctx.session.queuedMessageCount > 0,
			shutdown: () => {
				// Defer the actual teardown to the main loop, which calls
				// `checkShutdownRequested()` at idle boundaries so any queued
				// steering / follow-up messages drain first (see issue #1020).
				this.ctx.shutdownRequested = true;
			},
			getContextUsage: () => this.ctx.session.getContextUsage(),
			compact: instructionsOrOptions => this.#compactSession(instructionsOrOptions),
			getSystemPrompt: () => this.ctx.session.systemPrompt,
			obfuscateProviderText: text => this.ctx.session.obfuscateProviderText(text),
		};
		const commandActions: ExtensionCommandContextActions = {
			getContextUsage: () => this.ctx.session.getContextUsage(),
			waitForIdle: () => this.ctx.session.agent.waitForIdle(),
			reload: async () => {
				await this.ctx.session.reload();
				this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				this.ctx.showStatus("Reloaded session");
			},
			newSession: async options => {
				this.ctx.clearTransientSessionUi();

				// Create new session
				this.clearExtensionTerminalInputListeners();
				this.clearHookWidgets();
				const success = await this.ctx.session.newSession({ parentSession: options?.parentSession });
				if (!success) {
					return { cancelled: true };
				}

				// Call setup callback if provided
				if (options?.setup) {
					await options.setup(this.ctx.sessionManager);
				}

				// Clear UI state
				this.ctx.clearTransientSessionUi();
				this.ctx.resetTranscript();

				this.ctx.present([
					new Spacer(1),
					new Text(`${theme.fg("accent", `${theme.status.success} New session started`)}`, 1, 1),
				]);
				await this.ctx.reloadTodos();
				this.ctx.ui.requestRender(true, { clearScrollback: true });

				return { cancelled: false };
			},
			branch: async entryId => {
				const result = await this.ctx.session.branch(entryId);
				if (result.cancelled) {
					return { cancelled: true };
				}

				// Update UI
				this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				this.ctx.editor.setText(result.selectedText);
				this.ctx.showStatus("Branched to new session");

				return { cancelled: false };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.ctx.session.navigateTree(targetId, { summarize: options?.summarize });
				if (result.cancelled) {
					return { cancelled: true };
				}

				// Update UI
				this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				if (result.editorText && !this.ctx.editor.getText().trim()) {
					this.ctx.editor.setText(result.editorText);
				}
				this.ctx.showStatus("Navigated to selected point");

				return { cancelled: false };
			},
			compact: async instructionsOrOptions => this.#handleInteractiveCompact(instructionsOrOptions),
			switchSession: async sessionPath => {
				this.clearHookWidgets();
				const result = await this.ctx.session.switchSession(sessionPath);
				if (!result) {
					return { cancelled: true };
				}
				this.ctx.renderInitialMessages({ clearTerminalHistory: true });
				await this.ctx.reloadTodos();
				return { cancelled: false };
			},
		};

		extensionRunner.initialize(actions, contextActions, commandActions, uiContext);
	}

	/**
	 * Emit session event to all extension tools.
	 */
	async emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void> {
		const event = { reason, previousSessionFile };
		const uiContext = this.ctx.session.extensionRunner?.getUIContext();
		if (!uiContext) {
			return;
		}
		for (const registeredTool of this.ctx.session.extensionRunner?.getAllRegisteredTools() ?? []) {
			if (registeredTool.definition.onSession) {
				try {
					await registeredTool.definition.onSession(event, {
						ui: uiContext,
						getContextUsage: () => this.ctx.session.getContextUsage(),
						compact: instructionsOrOptions => this.#compactSession(instructionsOrOptions),
						hasUI: true,
						cwd: this.ctx.sessionManager.getCwd(),
						sessionManager: this.ctx.session.sessionManager,
						modelRegistry: this.ctx.session.modelRegistry,
						model: this.ctx.session.model,
						models: createExtensionModelQuery(
							this.ctx.session.modelRegistry,
							this.ctx.session.settings,
							() => this.ctx.session.model,
						),
						isIdle: () => !this.ctx.session.isStreaming,
						hasPendingMessages: () => this.ctx.session.queuedMessageCount > 0,
						abort: () => {
							abortDetached(this.ctx.session, "extension-ui-controller.abort", USER_INTERRUPT_LABEL);
						},
						shutdown: () => {
							// Signal shutdown request
						},
						getSystemPrompt: () => this.ctx.session.systemPrompt,
					});
				} catch (err) {
					this.showToolError(registeredTool.definition.name, errorMessage(err));
				}
			}
		}
	}

	/**
	 * Show a tool error in the chat.
	 */
	showToolError(toolName: string, error: string): void {
		const errorText = new Text(theme.fg("error", `Tool "${toolName}" error: ${error}`), 1, 0);
		this.ctx.present(errorText);
	}

	/**
	 * Set hook status text in the footer.
	 */
	setHookStatus(key: string, text: string | undefined): void {
		this.ctx.statusLine.setHookStatus(key, text);
		this.ctx.ui.requestRender();
	}

	async showCollabAwareSelector(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
		extra?: { slider?: HookSelectorSlider },
	): Promise<string | undefined> {
		const selectDialog = toSelectDialog({
			id: `select:${Date.now()}`,
			title,
			options: options.map(opt =>
				typeof opt === "string"
					? { value: opt, label: opt }
					: { value: opt.label, label: opt.label, description: opt.description },
			),
			selectedIndex: dialogOptions?.initialIndex,
			filterable: options.length > 12,
		});
		const request: CollabUiRequestDraft = {
			kind: "select",
			title: selectDialog.title,
			options: toWireSelectOptions(options),
			initialIndex: dialogOptions?.initialIndex,
			selectionMarker: dialogOptions?.selectionMarker,
			checkedIndices: dialogOptions?.checkedIndices ? dialogOptions.checkedIndices.slice() : undefined,
			markableCount: dialogOptions?.markableCount,
			helpText: dialogOptions?.helpText,
		};
		return this.#raceCollabDialog(request, dialogOptions?.signal, signal =>
			this.showHookSelector(selectDialog.title, options, { ...dialogOptions, signal }, extra),
		);
	}

	async showCollabAwareEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		const request: CollabUiRequestDraft = { kind: "editor", title, prefill };
		return this.#raceCollabDialog(request, dialogOptions?.signal, signal =>
			this.showHookEditor(title, prefill, { ...dialogOptions, signal }, editorOptions),
		);
	}

	async showAskDialog(
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		const host = this.ctx.collabHost;
		if (!host) return this.#showLocalAskDialog(questions, dialogOptions);
		const localAbort = new AbortController();
		const remoteAbort = new AbortController();
		const parentSignal = dialogOptions?.signal;
		const localSignal = parentSignal ? AbortSignal.any([parentSignal, localAbort.signal]) : localAbort.signal;
		const remoteSignal = parentSignal ? AbortSignal.any([parentSignal, remoteAbort.signal]) : remoteAbort.signal;
		const localWinner = this.#showLocalAskDialog(questions, { ...dialogOptions, signal: localSignal }).then(
			(value): CollabAskDialogWinner => ({ source: "local", value }),
		);
		const remoteWinner: Promise<CollabAskDialogWinner> = this.#runGuestAskDialog(questions, remoteSignal).then(
			result => (result === "unavailable" ? localWinner : { source: "remote", value: result }),
		);
		const winner = await Promise.race([localWinner, remoteWinner]);
		if (winner.source === "remote") localAbort.abort();
		else remoteAbort.abort();
		return winner.value;
	}

	/**
	 * Local ask dialog: a fullscreen ModalShell overlay (the `/copy`/session-
	 * picker idiom), not an editor-slot component. A nested custom-answer/note
	 * prompt (`onPrompt`) temporarily hides the overlay and swaps a
	 * `HookEditorComponent` into the normal editor slot instead of stacking a
	 * second fullscreen surface — the overlay un-hides and regains focus once
	 * the prompt settles.
	 */
	#showLocalAskDialog(
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		return this.#presentDialog<ExtensionAskDialogResult>(dialogOptions?.signal, settle => {
			let askDialog: AskDialogComponent | undefined;
			let overlayHandle: OverlayHandle | undefined;
			let promptEditor: HookEditorComponent | undefined;
			let promptResolve: ((value: string | undefined) => void) | undefined;
			let closed = false;

			let promptOverlay: OverlayHandle | undefined;

			const restoreAskDialog = (): void => {
				promptOverlay?.hide();
				promptOverlay = undefined;
				if (closed || !askDialog) return;
				overlayHandle?.setHidden(false);
				this.ctx.ui.setFocus(askDialog);
				this.ctx.ui.requestRender();
			};

			const finishPrompt = (value: string | undefined): void => {
				const resolvePrompt = promptResolve;
				promptResolve = undefined;
				promptEditor = undefined;
				restoreAskDialog();
				resolvePrompt?.(value);
			};

			const promptForText = (title: string, prefill?: string): Promise<string | undefined> => {
				if (closed) return Promise.resolve(undefined);
				const { promise, resolve } = Promise.withResolvers<string | undefined>();
				promptResolve = resolve;
				promptEditor = new HookEditorComponent(
					this.ctx.ui,
					title,
					prefill,
					value => finishPrompt(value),
					() => finishPrompt(undefined),
					{ promptStyle: true, onRequestRender: () => this.ctx.ui.requestRender() },
				);
				// The question's own card steps aside while its custom answer is
				// being typed: two cards stacked over the transcript would put the
				// question's chips under the editor's.
				overlayHandle?.setHidden(true);
				promptOverlay = this.ctx.ui.showOverlay(promptEditor, {
					anchor: "top-left",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
					fullscreen: true,
				});
				this.ctx.ui.setFocus(promptEditor);
				this.ctx.ui.requestRender();
				return promise;
			};

			askDialog = new AskDialogComponent(
				questions,
				{
					onSubmit: result => settle(result),
					onCancel: () => settle(undefined),
					onPrompt: promptForText,
				},
				{
					timeout: dialogOptions?.timeout,
					onTimeout: dialogOptions?.onTimeout,
					tui: this.ctx.ui,
				},
			);
			askDialog.setOnRequestRender(() => this.ctx.ui.requestRender());
			overlayHandle = this.ctx.ui.showOverlay(askDialog, {
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(askDialog);
			this.ctx.ui.requestRender();

			return () => {
				closed = true;
				askDialog?.dispose();
				overlayHandle?.hide();
				overlayHandle = undefined;
				// A nested prompt card may have been mid-flight when this settled.
				promptOverlay?.hide();
				promptOverlay = undefined;
				promptResolve?.(undefined);
				promptResolve = undefined;
				promptEditor = undefined;
				this.ctx.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			};
		});
	}

	/**
	 * Race the local hook dialog against a mirrored guest ask. First *answer*
	 * wins and cancels the other side. A remote `unavailable` settlement
	 * (collab teardown, relay drop, abort) is NOT an answer: the local dialog
	 * keeps running — the host user may be mid-keystroke in it — and its
	 * eventual result is returned.
	 */
	async #raceCollabDialog(
		request: CollabUiRequestDraft,
		signal: AbortSignal | undefined,
		local: (signal: AbortSignal | undefined) => Promise<string | undefined>,
	): Promise<string | undefined> {
		const host = this.ctx.collabHost;
		if (!host) return local(signal);
		const localAbort = new AbortController();
		const remoteAbort = new AbortController();
		const remote = host.requestGuestUi(
			request,
			signal ? AbortSignal.any([signal, remoteAbort.signal]) : remoteAbort.signal,
		);
		if (!remote) return local(signal);
		const localWinner = local(signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal).then(
			(value): CollabDialogWinner => ({ source: "local", value }),
		);
		const remoteWinner: Promise<CollabDialogWinner> = remote.then(result =>
			result.kind === "answered" ? { source: "remote", value: result.value } : localWinner,
		);
		const winner = await Promise.race([localWinner, remoteWinner]);
		if (winner.source === "remote") localAbort.abort();
		else remoteAbort.abort();
		return winner.value;
	}

	async #runGuestAskDialog(
		questions: ExtensionAskDialogQuestion[],
		signal: AbortSignal,
	): Promise<ExtensionAskDialogResult | "unavailable" | undefined> {
		const results: ExtensionAskDialogResultItem[] = [];
		for (const question of questions) {
			const result = await this.#runGuestAskQuestion(question, signal);
			if (result === "unavailable" || result === undefined) return result;
			if (result === "chat") return { kind: "chat" };
			results.push(result);
		}
		return { kind: "submit", results };
	}

	async #runGuestAskQuestion(
		question: ExtensionAskDialogQuestion,
		signal: AbortSignal,
	): Promise<ExtensionAskDialogResultItem | "chat" | "unavailable" | undefined> {
		const options: CollabUiSelectItem[] = question.options.map(option =>
			option.description?.trim() ? { label: option.label, description: option.description.trim() } : option.label,
		);
		// Mirror the local dialog: `allowOther: false` offers no free-text row, so a
		// guest cannot return an answer outside the listed options.
		const other: CollabUiSelectItem[] = question.allowOther === false ? [] : [ASK_OTHER_OPTION_LABEL];
		const answer = question.multi
			? await this.#runGuestMultiSelect(question, options, other, signal)
			: await this.#runGuestSingleSelect(question, options, other, signal);
		if (answer === undefined || typeof answer === "string") return answer;
		const labels = question.options.map(option => option.label);
		return {
			id: question.id,
			question: question.question,
			options: labels,
			multi: question.multi ?? false,
			selectedOptions: labels.filter(label => answer.selected.has(label)),
			customInput: answer.customInput,
		};
	}

	/** Toggles the option the guest picks until it picks Next or types an Other answer. */
	async #runGuestMultiSelect(
		question: ExtensionAskDialogQuestion,
		options: CollabUiSelectItem[],
		other: CollabUiSelectItem[],
		signal: AbortSignal,
	): Promise<GuestAskAnswer | GuestAskExit> {
		const selected = new Set<string>();
		while (true) {
			const pick = await this.#guestPick(
				question,
				multiSelectRequest(question, options, other, selected),
				other,
				signal,
			);
			if (pick === undefined || typeof pick === "string") return pick;
			if ("customInput" in pick) return { selected, customInput: pick.customInput };
			if (pick.label === ASK_NEXT_OPTION_LABEL) return { selected, customInput: undefined };
			if (!selected.delete(pick.label)) selected.add(pick.label);
		}
	}

	/** The one option the guest picks, starting on the question's recommended option, or its Other answer. */
	async #runGuestSingleSelect(
		question: ExtensionAskDialogQuestion,
		options: CollabUiSelectItem[],
		other: CollabUiSelectItem[],
		signal: AbortSignal,
	): Promise<GuestAskAnswer | GuestAskExit> {
		const recommended =
			typeof question.recommended === "number" && Number.isInteger(question.recommended) ? question.recommended : 0;
		const request: CollabUiRequestDraft = {
			kind: "select",
			title: question.question,
			options: options.concat(other, [ASK_CHAT_OPTION_LABEL]),
			initialIndex: clampLow(recommended, 0, Math.max(0, question.options.length - 1)),
			selectionMarker: "radio",
			markableCount: question.options.length,
			helpText: "up/down navigate  enter select  esc cancel",
		};
		const pick = await this.#guestPick(question, request, other, signal);
		if (pick === undefined || typeof pick === "string") return pick;
		return "customInput" in pick
			? { selected: new Set(), customInput: pick.customInput }
			: { selected: new Set([pick.label]), customInput: undefined };
	}

	/**
	 * The row the guest picks from `request`, the text it types after picking Other, or how it left the question. A
	 * guest that cancels the Other editor sees `request` again rather than cancelling the whole ask.
	 */
	async #guestPick(
		question: ExtensionAskDialogQuestion,
		request: CollabUiRequestDraft,
		other: CollabUiSelectItem[],
		signal: AbortSignal,
	): Promise<GuestAskPick | GuestAskExit> {
		while (true) {
			const choice = await this.#requestGuestUiString(request, signal);
			if (choice.kind === "unavailable") return "unavailable";
			if (choice.kind === "cancelled") return undefined;
			if (choice.value === ASK_CHAT_OPTION_LABEL) return "chat";
			if (other.length === 0 || choice.value !== ASK_OTHER_OPTION_LABEL) return { label: choice.value };
			const input = await this.#requestGuestUiString(
				{ kind: "editor", title: boundPromptTitle("Custom answer: ", question.question) },
				signal,
			);
			if (input.kind === "unavailable") return "unavailable";
			if (input.kind === "answered") return { customInput: input.value };
		}
	}

	async #requestGuestUiString(request: CollabUiRequestDraft, signal: AbortSignal): Promise<GuestUiResult> {
		const host = this.ctx.collabHost;
		if (!host) return { kind: "unavailable" };
		const remote = host.requestGuestUi(request, signal);
		if (!remote) return { kind: "unavailable" };
		const result = await remote;
		if (result.kind === "unavailable") return { kind: "unavailable" };
		return typeof result.value === "string" ? { kind: "answered", value: result.value } : { kind: "cancelled" };
	}

	/**
	 * Show a selector for hooks: a fullscreen ModalShell overlay over the
	 * transcript, the same surface the ask dialog and the session pickers use,
	 * rather than a bordered stack swapped into the editor slot.
	 */
	showHookSelector(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
		extra?: { slider?: HookSelectorSlider },
	): Promise<string | undefined> {
		return this.#presentDialog(dialogOptions?.signal, settle => {
			const maxVisible = clampLow(this.ctx.ui.terminal.rows - 12, 4, 15);
			const selector = new HookSelectorComponent(
				title,
				options,
				option => settle(option),
				() => settle(undefined),
				{
					onLeft: dialogOptions?.onLeft
						? () => {
								dialogOptions.onLeft?.();
								settle(undefined);
							}
						: undefined,
					onRight: dialogOptions?.onRight
						? () => {
								dialogOptions.onRight?.();
								settle(undefined);
							}
						: undefined,
					onExternalEditor: dialogOptions?.onExternalEditor,
					helpText: dialogOptions?.helpText,
					initialIndex: dialogOptions?.initialIndex,
					timeout: dialogOptions?.timeout,
					onTimeout: dialogOptions?.onTimeout,
					onTimeoutStart: dialogOptions?.onTimeoutStart,
					onTimeoutReset: dialogOptions?.onTimeoutReset,
					tui: this.ctx.ui,
					disabledIndices: dialogOptions?.disabledIndices,
					selectionMarker: dialogOptions?.selectionMarker,
					checkedIndices: dialogOptions?.checkedIndices,
					markableCount: dialogOptions?.markableCount,
					maxVisible,
					slider: extra?.slider,
					onRequestRender: () => this.ctx.ui.requestRender(),
				},
			);
			this.ctx.hookSelector = selector;
			this.#hookSelectorOverlay = this.ctx.ui.showOverlay(selector, {
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(selector);
			this.ctx.ui.requestRender();
			return () => this.hideHookSelector();
		});
	}
	/**
	 * Hide the hook selector.
	 */
	hideHookSelector(): void {
		this.ctx.hookSelector?.dispose();
		// The overlay only hides; disposing the component is the host's job.
		this.#hookSelectorOverlay?.hide();
		this.#hookSelectorOverlay = undefined;
		this.ctx.hookSelector = undefined;
		this.ctx.focusActiveEditorArea();
		this.ctx.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for hooks.
	 */
	async showHookConfirm(title: string, message: string): Promise<boolean> {
		const dialog = toConfirmDialog({
			id: `confirm:${Date.now()}`,
			title,
			body: message,
			confirmLabel: "Yes",
			cancelLabel: "No",
		});
		const result = await this.showHookSelector(dialog.body ? `${dialog.title}\n${dialog.body}` : dialog.title, [
			dialog.confirmLabel,
			dialog.cancelLabel,
		]);
		return result === dialog.confirmLabel;
	}

	/**
	 * Show a text input for hooks.
	 */
	showHookInput(
		title: string,
		placeholder?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		/**
		 * How the field renders, as opposed to how the dialog behaves. `mask` states that the field
		 * carries a credential; the character drawn in place of each keystroke is this host's, which
		 * is why the caller states a boolean and never a glyph. Separate from `dialogOptions` for the
		 * same reason {@link showHookEditor} keeps `editorOptions` separate: presentation is not an
		 * extension API concern, and masking must not become something a remote extension can switch
		 * off.
		 */
		inputOptions?: { mask?: boolean; hint?: string },
	): Promise<string | undefined> {
		const dialog = toPromptDialog({
			id: `prompt:${Date.now()}`,
			title,
			placeholder,
			masked: inputOptions?.mask,
		});
		return this.#presentDialog(dialogOptions?.signal, settle => {
			const input = new HookInputComponent(
				dialog.title,
				dialog.placeholder,
				value => settle(value),
				() => settle(undefined),
				{
					timeout: dialogOptions?.timeout,
					onTimeout: dialogOptions?.onTimeout,
					tui: this.ctx.ui,
					mask: dialog.masked ? DEFAULT_MASK_CHAR : undefined,
					credentialMode: dialog.masked,
					hint: inputOptions?.hint,
					onRequestRender: () => this.ctx.ui.requestRender(),
				},
			);
			this.ctx.hookInput = input;
			this.#hookInputOverlay = this.ctx.ui.showOverlay(input, {
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(input);
			this.ctx.ui.requestRender();
			return () => this.hideHookInput();
		});
	}

	/**
	 * Hide the hook input.
	 */
	hideHookInput(): void {
		this.ctx.hookInput?.dispose();
		// The overlay only hides; disposing the component is the host's job.
		this.#hookInputOverlay?.hide();
		this.#hookInputOverlay = undefined;
		this.ctx.hookInput = undefined;
		this.ctx.focusActiveEditorArea();
		this.ctx.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for hooks (with Ctrl+G support).
	 */
	showHookEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		return this.#presentDialog(dialogOptions?.signal, settle => {
			const editor = new HookEditorComponent(
				this.ctx.ui,
				title,
				prefill,
				value => settle(value),
				() => settle(undefined),
				{ ...editorOptions, onRequestRender: () => this.ctx.ui.requestRender() },
			);
			this.ctx.hookEditor = editor;
			this.#hookEditorOverlay = this.ctx.ui.showOverlay(editor, {
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(editor);
			this.ctx.ui.requestRender();
			return () => this.hideHookEditor();
		});
	}

	/**
	 * Hide the hook editor.
	 */
	hideHookEditor(): void {
		// The overlay only hides; disposing what it held is the host's job.
		this.#hookEditorOverlay?.hide();
		this.#hookEditorOverlay = undefined;
		this.ctx.hookEditor = undefined;
		this.ctx.focusActiveEditorArea();
		this.ctx.ui.requestRender();
	}

	/**
	 * Show a notification for hooks.
	 */
	showHookNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.ctx.showError(message);
		} else if (type === "warning") {
			this.ctx.showWarning(message);
		} else {
			this.ctx.showStatus(message);
		}
	}

	/**
	 * Show a custom component with keyboard focus.
	 */
	async showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: { overlay?: boolean | OverlayOptions },
	): Promise<T> {
		const savedText = this.ctx.editor.getText();
		const keybindings = KeybindingsManager.inMemory();

		const { promise, resolve } = Promise.withResolvers<T>();
		let component: (Component & { dispose?(): void }) | undefined;
		let overlayHandle: OverlayHandle | undefined;
		let closed = false;

		const close = (result: T) => {
			if (closed) return;
			closed = true;
			component?.dispose?.();
			overlayHandle?.hide();
			overlayHandle = undefined;
			if (!options?.overlay) {
				this.ctx.editorContainer.clear();
				this.ctx.editorContainer.addChild(this.ctx.editor);
				this.ctx.editor.setText(savedText);
			}
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
			resolve(result);
		};

		this.#restWorkingLoaderWhileIdle();
		Promise.try(() => factory(this.ctx.ui, theme, keybindings, close)).then(c => {
			if (closed) {
				c.dispose?.();
				return;
			}
			component = c;
			if (options?.overlay) {
				// `true` is the transcript-region card: the composer zone (prompt,
				// status line, footline) stays painted under it, so a running console
				// or dashboard never takes the whole screen. A caller with a shape of
				// its own (a centered launcher) passes the geometry.
				overlayHandle = this.ctx.ui.showOverlay(
					component,
					options.overlay === true
						? { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0, aboveFooter: true }
						: options.overlay,
				);
				return;
			}
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(component);
			this.ctx.ui.setFocus(component);
			this.ctx.ui.requestRender();
		});
		return promise;
	}

	/**
	 * Show an extension error in the UI.
	 */
	addExtensionTerminalInputListener(handler: TerminalInputHandler): () => void {
		const unsubscribe = this.ctx.ui.addInputListener(handler);
		this.#extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.#extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	clearHookWidgets(): void {
		for (const widget of this.#hookWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.#hookWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.#hookWidgetsAbove.clear();
		this.#hookWidgetsBelow.clear();
		this.#rebuildHookWidgets();
	}

	clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.#extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.#extensionTerminalInputUnsubscribers.clear();
	}

	showExtensionError(extensionPath: string, error: string): void {
		const errorText = new Text(theme.fg("error", `Extension "${extensionPath}" error: ${error}`), 1, 0);
		this.ctx.present(errorText);
	}
	async #handleInteractiveCompact(instructionsOrOptions: string | CompactOptions | undefined): Promise<void> {
		await this.ctx.executeCompaction(instructionsOrOptions, false);
	}

	async #compactSession(instructionsOrOptions: string | CompactOptions | undefined): Promise<void> {
		const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
		const options =
			instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
		await this.ctx.session.compact(instructions, options);
	}

	async #updateSessionName(name: string): Promise<void> {
		await this.ctx.sessionManager.setSessionName(name, "user");
	}

	#sendExtensionUserMessage: SendUserMessageHandler = (content, options) => {
		this.ctx.session.sendUserMessage(content, options).catch((err: unknown) => {
			this.ctx.showError(`Extension sendUserMessage failed: ${errorMessage(err)}`);
		});
	};

	#applyCustomMessageDisplay(wasStreaming: boolean, shouldDisplay: boolean | undefined): void {
		// For non-streaming cases with display=true, update UI
		// (streaming cases update via message_end event).
		// Gate on initialChatRendered (#1955): an extension's session_start
		// sendMessage({display:true}) runs before renderInitialMessages, which would
		// re-render from session entries AND re-append via preserveExistingChat,
		// duplicating the message. After the initial render the rebuild must run.
		if (!wasStreaming && shouldDisplay && this.ctx.initialChatRendered) {
			this.ctx.rebuildChatFromMessages();
		}
	}

	/**
	 * Present a modal dialog on the shared editor surface, serializing against any
	 * dialog already open. `present` builds the component, swaps it into
	 * `editorContainer`, steals focus, and returns a `hide` closure; it is invoked
	 * with a single `settle` callback that the component fires on submit/cancel.
	 *
	 * Because selector / input / editor all clear `editorContainer` and re-focus,
	 * showing a second one while the first is open would orphan the first — its
	 * promise would hang until the caller's signal aborts. So at most one dialog is
	 * presented at a time and the rest queue (FIFO). `settle` (or an abort) hides
	 * the current dialog and hands the surface to the next queued request. A request
	 * whose signal aborts before its turn resolves `undefined` and is never shown.
	 */
	#presentDialog<T = string>(
		signal: AbortSignal | undefined,
		present: (settle: (value: T | undefined) => void) => () => void,
	): Promise<T | undefined> {
		const { promise, resolve, reject } = Promise.withResolvers<T | undefined>();
		let settled = false;
		let started = false;
		let hide: (() => void) | undefined;

		function onAbort(): void {
			settle(undefined);
		}

		const settle = (value: T | undefined): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (started) {
				hide?.();
				this.#dialogActive = false;
				this.#advanceDialogQueue();
			}
			resolve(value);
		};

		const startPresentation = (): void => {
			if (settled) {
				// Aborted before its turn arrived — never present, hand off the surface.
				this.#advanceDialogQueue();
				return;
			}
			started = true;
			this.#dialogActive = true;
			this.#restWorkingLoaderWhileIdle();
			try {
				hide = present(settle);
			} catch (error) {
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				this.#dialogActive = false;
				reject(error);
				this.#advanceDialogQueue();
			}
		};

		if (signal?.aborted) {
			resolve(undefined);
			return promise;
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		if (this.#dialogActive) {
			this.#dialogQueue.push(startPresentation);
		} else {
			startPresentation();
		}
		return promise;
	}

	/**
	 * A hook UI that waits on the user is not the agent working. A slash command
	 * mounts the `Working…` loader on submit and keeps it until its handler
	 * returns, so a command that opens a console sat under `Working… · 0:19
	 * ⟦esc⟧` for as long as the user read the console. Mid-turn the loader is
	 * the turn's and stays: a tool asking a question is still a turn in flight.
	 */
	#restWorkingLoaderWhileIdle(): void {
		if (this.ctx.session.isStreaming) return;
		this.ctx.clearWorkingLoader();
	}

	#advanceDialogQueue(): void {
		this.#dialogQueue.shift()?.();
	}
}

function removeHookWidget(widgets: Map<string, ExtensionUiComponent>, key: string): void {
	const existing = widgets.get(key);
	existing?.dispose?.();
	widgets.delete(key);
}

function renderHookWidgetContainer(
	container: Container,
	widgets: Map<string, ExtensionUiComponent>,
	spacerWhenEmpty: boolean,
	leadingSpacer: boolean,
): void {
	container.clear();

	if (widgets.size === 0) {
		if (spacerWhenEmpty) {
			container.addChild(new Spacer(1));
		}
		return;
	}

	if (leadingSpacer) {
		container.addChild(new Spacer(1));
	}
	for (const widget of widgets.values()) {
		container.addChild(widget);
	}
}
/** The terminal host's autoresearch surfaces: the run screen and the launcher, each a `custom` overlay. */
export const terminalAutoresearchUi: AutoresearchUiDelegate = {
	async showScreen(ctx, runtime, model, options) {
		const terminal = ctx.ui.terminal;
		if (!terminal) {
			ctx.ui.notify("Autoresearch screen requires an interactive terminal", "warning");
			return;
		}
		// The run screen and its console load when a run is first shown, not with the controller.
		const { AutoresearchScreenComponent } = await import("../components/dialogs/autoresearch-screen");
		await terminal.custom<void>(
			(tui, _theme, _keybindings, done) => {
				options.onMount({ requestRender: () => tui.requestRender() });
				const component = new AutoresearchScreenComponent({
					runtime,
					model,
					close: () => done(undefined),
					requestRender: () => tui.requestRender(),
					rows: () => tui.terminal.rows - tui.pinnedFooterRows,
				});
				return {
					render: (width: number) => component.render(width),
					handleInput: (data: string) => component.handleInput(data),
					routeMouse: (event: SgrMouseEvent, line: number, col: number) => component.routeMouse(event, line, col),
					dispose: () => {
						options.onDispose();
					},
				};
			},
			{ overlay: true },
		);
	},
	async showLauncher(ctx, model) {
		const terminal = ctx.ui.terminal;
		if (!terminal) {
			ctx.ui.notify("Autoswarm launcher requires an interactive terminal", "warning");
			return;
		}
		const { LAUNCHER_OVERLAY, LauncherComponent } = await import("../components/dialogs/autoresearch-launcher");
		await terminal.custom<void>(
			(tui, _theme, _keybindings, done) => {
				const component = new LauncherComponent({
					model,
					close: () => done(undefined),
					requestRender: () => tui.requestRender(),
					rows: () => tui.terminal.rows - tui.pinnedFooterRows - 2,
				});
				return {
					render: (width: number) => component.render(width),
					handleInput: (data: string) => component.handleInput(data),
					routeMouse: (event: SgrMouseEvent, line: number, col: number) => component.routeMouse(event, line, col),
				};
			},
			{ overlay: LAUNCHER_OVERLAY },
		);
	},
};
registerAutoresearchUi(terminalAutoresearchUi);
