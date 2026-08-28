import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { ImageContent } from "@veyyon/ai";
import { type AutocompleteProvider, matchesKey, type SlashCommand } from "@veyyon/tui";
import { errorMessage, isEnoent, logger, sanitizeText } from "@veyyon/utils";
import { EXIT_INTERRUPTED } from "../../cli/exit-codes";
import { isSettingsInitialized, settings } from "../../config/settings-instance";
import { resolveLocalRoot } from "../../internal-urls/local-protocol";
import { AGENT_VIEW_LEFT_TAP_WINDOW_MS } from "../../modes/components/agent-view-timings";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { extractImagePathFromText } from "../../modes/components/custom-editor";
import { pointerMotionEnabled } from "../../modes/components/modal-shell";
import { renderSegmentTrack } from "../../modes/components/segment-track";
import { TinyTitleDownloadProgressComponent } from "../../modes/components/tiny-title-download-progress";
import { expandEmoticons } from "../../modes/emoji-autocomplete";
import { materializeImageReferenceLinks, shiftImageMarkers } from "../../modes/image-references";
import { createPromptActionAutocompleteProvider } from "../../modes/prompt-action-autocomplete";
import { parseQueueShorthand, splitQueuedMessages } from "../../modes/queue-input";
import { invokeSkillCommandFromText, isKnownSkillCommand } from "../../modes/skill-command";
import type { InteractiveModeContext } from "../../modes/types";
import { turnControlPrompts } from "../../prompts/turn-control/rows";
import { abortDetached } from "../../session/detached-abort";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { executeBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { isSensitiveSlashCommand, normalizeSubmittedPrompt } from "../../slash-commands/helpers/parse";
import type { TuiSlashCommandHostContext } from "../../slash-commands/types";
import { isTinyTitleLocalModelKey } from "../../tiny/models";
import { isLowSignalTitleInput } from "../../tiny/text";
import { tinyTitleClient } from "../../tiny/title-client";
import type { TinyTitleProgressEvent } from "../../tiny/title-protocol";
import { requestManualBackground } from "../../tools/bash-foreground-registry";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import { vocalizer } from "../../tts/vocalizer";
import {
	copyToClipboard,
	readImageFromClipboard,
	readMacFileUrlsFromClipboard,
	readTextFromClipboard,
} from "../../utils/clipboard";
import { EnhancedPasteController } from "../../utils/enhanced-paste";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { ensureSupportedImageInput, ImageInputTooLargeError, loadImageInput } from "../../utils/image-loading";
import { resizeImage } from "../../utils/image-resize";
import { autoTitleDisabled, generateSessionTitle } from "../../utils/title-generator";
import type { SkillCommandHost } from "../skill-command";

export function shouldSkipHistory(slashText: string): boolean {
	return isSensitiveSlashCommand(slashText);
}

interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

interface PasteTarget {
	pasteText(text: string): void;
}

function hasPasteText(value: unknown): value is PasteTarget {
	return typeof value === "object" && value !== null && typeof (value as PasteTarget).pasteText === "function";
}

const SHELL_PROMPT_COMMAND_RE =
	/^(?:\.{0,2}\/|~\/|cd(?:\s|$)|sudo(?:\s|$)|git(?:\s|$)|bun(?:\s|$)|npm(?:\s|$)|pnpm(?:\s|$)|yarn(?:\s|$)|node(?:\s|$)|python\d*(?:\s|$)|cargo(?:\s|$)|go(?:\s|$)|make(?:\s|$)|docker(?:\s|$)|kubectl(?:\s|$))/;
const SHELL_PROMPT_OPERATOR_RE = /(?:^|\s)(?:&&|\|\||\||2>&1|[<>]{1,2})(?:\s|$)/;
const VEYYON_STATUS_LINE_RE = /^\s*in:\s+\d+\s+out:\s+\d+(?:\s+cache\s+\S+)?\s+t:\s+\S+\s+tok\/s:\s+\S+/m;

function looksLikePastedShellPrompt(code: string): boolean {
	const firstLine = code.split("\n", 1)[0]?.trimStart() ?? "";
	return (
		SHELL_PROMPT_COMMAND_RE.test(firstLine) ||
		SHELL_PROMPT_OPERATOR_RE.test(firstLine) ||
		VEYYON_STATUS_LINE_RE.test(code)
	);
}

function pythonCommandPrefixLength(trimmedText: string): 0 | 1 | 2 {
	if (trimmedText.charCodeAt(0) !== 36 /* $ */) return 0;
	if (trimmedText.charCodeAt(1) === 123 /* { */) return 0;

	const prefixLength = trimmedText.charCodeAt(1) === 36 /* $ */ ? 2 : 1;
	const next = trimmedText.charCodeAt(prefixLength);
	if (Number.isNaN(next)) return prefixLength;
	return next === 32 || next === 9 || next === 10 || next === 13 ? prefixLength : 0;
}

function parsePythonCommandInput(text: string): { code: string; isExcluded: boolean } | undefined {
	const trimmed = text.trimStart();
	const prefixLength = pythonCommandPrefixLength(trimmed);
	if (prefixLength === 0) return undefined;
	const code = trimmed.slice(prefixLength).trim();
	if (prefixLength === 1 && looksLikePastedShellPrompt(code)) return undefined;
	return {
		code,
		isExcluded: prefixLength === 2,
	};
}

function wrapPasteInAttachmentBlock(content: string): string {
	return `<attachment>\n${content}\n</attachment>`;
}

function safeAbort(label: string, fn: () => void): void {
	try {
		fn();
	} catch (err) {
		logger.debug(`Failed to abort ${label}`, { error: errorMessage(err) });
	}
}

const TINY_TITLE_PROGRESS_DONE_TTL_MS = 3_000;
const TINY_TITLE_PROGRESS_REVEAL_DELAY_MS = 1_000;
const LEFT_DOUBLE_TAP_MIN_GAP_MS = 40;

export type InputControllerContext = TuiSlashCommandHostContext &
	SkillCommandHost &
	Pick<
		InteractiveModeContext,
		| "canBranchBtw"
		| "cancelPendingSubmission"
		| "canCopyBtw"
		| "clearEditor"
		| "dismissWelcome"
		| "flushPendingBashComponents"
		| "focusedAgentId"
		| "goalModePaused"
		| "handleBashCommand"
		| "handleBtwBranchKey"
		| "handleBtwCopyKey"
		| "handleBtwEscape"
		| "handleOmfgEscape"
		| "handlePythonCommand"
		| "handleSTTToggle"
		| "hasActiveBtw"
		| "hasActiveOmfg"
		| "hasDisplayableThinkingContent"
		| "hideThinkingBlock"
		| "isBashMode"
		| "isPythonMode"
		| "isShuttingDown"
		| "keybindings"
		| "lastEscapeTime"
		| "lastLeftTapTime"
		| "lastSigintTime"
		| "loadingAnimation"
		| "locallySubmittedUserSignatures"
		| "onInputCallback"
		| "openGoalDetail"
		| "pauseLoop"
		| "queueCompactionMessage"
		| "refreshComposerShortcuts"
		| "showHistorySearch"
		| "showModelCycleTrack"
		| "startPendingSubmission"
		| "toggleThinkingBlockVisibility"
		| "toolOutputExpanded"
		| "unfocusSession"
		| "viewSession"
		| "withLocalSubmission"
	>;

export class InputController {
	constructor(
		private ctx: InputControllerContext,
		private clipboard: {
			readImage: typeof readImageFromClipboard;
			readText: typeof readTextFromClipboard;
			readMacFileUrls?: typeof readMacFileUrlsFromClipboard;
		} = {
			readImage: readImageFromClipboard,
			readText: readTextFromClipboard,
			readMacFileUrls: readMacFileUrlsFromClipboard,
		},
	) {}

	#enhancedPaste?: EnhancedPasteController;
	#focusedLeftTapListenerInstalled = false;
	#btwBranchListenerInstalled = false;
	#btwCopyListenerInstalled = false;
	#goalDetailListenerInstalled = false;
	#leftTapCount = 0;
	#attachmentCounter = 0;

	#showTinyTitleDownloadProgress(modelKey: string): void {
		if (!isTinyTitleLocalModelKey(modelKey)) return;
		const component = new TinyTitleDownloadProgressComponent(modelKey, {
			requestRender: () => this.ctx.ui.requestRender(),
			enabled: pointerMotionEnabled(),
		});
		let added = false;
		let disposed = false;
		let removeTimer: NodeJS.Timeout | undefined;
		const remove = (): void => {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			component.dispose();
			if (removeTimer) {
				clearTimeout(removeTimer);
				removeTimer = undefined;
			}
			if (added) {
				this.ctx.chatContainer.removeChild(component);
				this.ctx.ui.requestRender();
			}
		};
		const scheduleRemove = (): void => {
			if (removeTimer) clearTimeout(removeTimer);
			removeTimer = setTimeout(remove, TINY_TITLE_PROGRESS_DONE_TTL_MS);
			removeTimer.unref?.();
		};
		let revealAt = 0;
		const update = (event: TinyTitleProgressEvent): void => {
			if (disposed || event.modelKey !== modelKey) return;
			component.update(event);
			if (revealAt === 0) revealAt = performance.now() + TINY_TITLE_PROGRESS_REVEAL_DELAY_MS;
			const complete = component.isComplete();
			if (!added && !complete && performance.now() >= revealAt) {
				this.ctx.chatContainer.addChild(component);
				added = true;
			}
			if (added) this.ctx.ui.requestRender();
			if (complete) {
				if (added) scheduleRemove();
				else remove();
			}
		};
		const unsubscribe = tinyTitleClient.onProgress(update);
	}

	#abortStreamingTurn(): void {
		abortDetached(this.ctx.session, "input-controller.abortStreamingTurn", USER_INTERRUPT_LABEL);
	}

	setupKeyHandlers(): void {
		this.ctx.editor.setActionKeys("app.interrupt", this.ctx.keybindings.getKeys("app.interrupt"));
		if (!this.#focusedLeftTapListenerInstalled) {
			this.#focusedLeftTapListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				if (!this.ctx.focusedAgentId) return undefined;
				if (!matchesKey(data, "left")) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				this.#handleFocusedLeftTap();
				return { consume: true };
			});
		}
		if (!this.#btwBranchListenerInstalled) {
			this.#btwBranchListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				if (!matchesKey(data, "b")) return undefined;
				if (!this.ctx.canBranchBtw()) return undefined;
				if (this.ctx.ui.getFocused() !== this.ctx.editor) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				void this.ctx.handleBtwBranchKey();
				return { consume: true };
			});
		}
		if (!this.#btwCopyListenerInstalled) {
			this.#btwCopyListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				if (!matchesKey(data, "c")) return undefined;
				if (!this.ctx.canCopyBtw()) return undefined;
				if (this.ctx.ui.getFocused() !== this.ctx.editor) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				void this.ctx.handleBtwCopyKey();
				return { consume: true };
			});
		}
		if (!this.#goalDetailListenerInstalled) {
			this.#goalDetailListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				if (!matchesKey(data, "down")) return undefined;
				if (!this.ctx.goalModeEnabled && !this.ctx.goalModePaused) return undefined;
				if (this.ctx.ui.getFocused() !== this.ctx.editor) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				void this.ctx.openGoalDetail();
				return { consume: true };
			});
		}
		this.ctx.editor.onEscape = () => {
			if (this.ctx.hasActiveBtw() && this.ctx.handleBtwEscape()) {
				return;
			}
			if (this.ctx.hasActiveOmfg() && this.ctx.handleOmfgEscape()) {
				return;
			}

			if (!this.ctx.focusedAgentId) {
				const viewSession = this.ctx.viewSession;
				let aborted = false;
				if (viewSession.isCompacting) {
					safeAbort("compaction", () => viewSession.abortCompaction());
					aborted = true;
				}
				if (viewSession.isGeneratingHandoff) {
					safeAbort("handoff", () => viewSession.abortHandoff());
					aborted = true;
				}
				if (viewSession.isRetrying) {
					safeAbort("retry", () => viewSession.abortRetry());
					aborted = true;
				}
				if (aborted) return;
			}

			if (vocalizer.isSpeaking()) {
				vocalizer.clear();
				this.ctx.lastEscapeTime = 0;
				return;
			}

			if (this.ctx.loopModeEnabled) {
				this.ctx.pauseLoop();
				if (this.ctx.session.isStreaming) {
					this.#abortStreamingTurn();
				} else {
					this.ctx.cancelPendingSubmission();
				}
				return;
			}
			if (this.ctx.focusedAgentId) {
				if (this.ctx.editor.getText().trim()) {
					this.ctx.editor.setText("");
					this.ctx.ui.requestRender();
				} else {
					void this.ctx.unfocusSession();
				}
				return; // double-escape backtrack (/tree, /branch) stays main-only
			}
			if (this.ctx.collabGuest) {
				if (this.ctx.collabGuest.state?.isStreaming || this.ctx.loadingAnimation) {
					this.ctx.collabGuest.sendAbort();
				}
				return;
			}
			if (this.ctx.loadingAnimation) {
				if (this.ctx.cancelPendingSubmission()) {
					return;
				}
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.ctx.session.isBashRunning) {
				this.ctx.session.abortBash();
			} else if (this.ctx.isBashMode) {
				this.ctx.editor.setText("");
				this.ctx.isBashMode = false;
				this.ctx.updateEditorBorderColor();
			} else if (this.ctx.session.isEvalRunning) {
				this.ctx.session.abortEval();
			} else if (this.ctx.isPythonMode) {
				this.ctx.editor.setText("");
				this.ctx.isPythonMode = false;
				this.ctx.updateEditorBorderColor();
			} else if (this.ctx.session.isStreaming) {
				this.#abortStreamingTurn();
			} else if (this.ctx.editor.getText().trim()) {
				this.ctx.lastEscapeTime = 0;
			} else {
				const action = settings.get("doubleEscapeAction");
				if (action !== "none") {
					const now = Date.now();
					if (now - this.ctx.lastEscapeTime < 500) {
						if (action === "tree") {
							this.ctx.showTreeSelector();
						} else {
							this.ctx.showUserMessageSelector();
						}
						this.ctx.ui.resetDisplay();
						this.ctx.lastEscapeTime = 0;
					} else {
						this.ctx.lastEscapeTime = now;
					}
				}
			}
		};

		this.ctx.editor.setActionKeys("app.clear", this.ctx.keybindings.getKeys("app.clear"));
		this.ctx.editor.onClear = () => this.handleCtrlC();
		this.ctx.editor.setActionKeys("app.exit", this.ctx.keybindings.getKeys("app.exit"));
		this.ctx.editor.setActionKeys("app.display.reset", this.ctx.keybindings.getKeys("app.display.reset"));
		this.ctx.editor.onDisplayReset = () => this.ctx.ui.resetDisplay();
		this.ctx.editor.onExit = () => this.handleCtrlD();
		this.ctx.editor.setActionKeys("app.suspend", this.ctx.keybindings.getKeys("app.suspend"));
		this.ctx.editor.onSuspend = () => this.handleCtrlZ();
		this.ctx.editor.setActionKeys("app.bash.background", this.ctx.keybindings.getKeys("app.bash.background"));
		this.ctx.editor.onBashBackground = () => requestManualBackground();
		this.ctx.editor.setActionKeys("app.thinking.cycle", this.ctx.keybindings.getKeys("app.thinking.cycle"));
		this.ctx.editor.onCycleThinkingLevel = () => this.cycleThinkingLevel();
		this.ctx.editor.setActionKeys("app.model.cycleForward", this.ctx.keybindings.getKeys("app.model.cycleForward"));
		this.ctx.editor.onCycleModelForward = () => this.cycleRoleModel("forward");
		this.ctx.editor.setActionKeys("app.model.cycleBackward", this.ctx.keybindings.getKeys("app.model.cycleBackward"));
		this.ctx.editor.onCycleModelBackward = () => this.cycleRoleModel("backward");
		this.ctx.editor.setActionKeys(
			"app.model.selectTemporary",
			this.ctx.keybindings.getKeys("app.model.selectTemporary"),
		);
		this.ctx.editor.onSelectModelTemporary = () => this.ctx.showModelSelector({ temporaryOnly: true });

		this.ctx.ui.onDebug = () => this.ctx.showDebugSelector();
		this.ctx.editor.setActionKeys("app.model.select", this.ctx.keybindings.getKeys("app.model.select"));
		this.ctx.editor.onSelectModel = () => this.ctx.showModelSelector();
		this.ctx.editor.setActionKeys("app.history.search", this.ctx.keybindings.getKeys("app.history.search"));
		this.ctx.editor.onHistorySearch = () => this.ctx.showHistorySearch();
		this.ctx.editor.setActionKeys("app.thinking.toggle", this.ctx.keybindings.getKeys("app.thinking.toggle"));
		this.ctx.editor.onToggleThinking = () => this.ctx.toggleThinkingBlockVisibility();
		this.ctx.editor.setActionKeys("app.editor.external", this.ctx.keybindings.getKeys("app.editor.external"));
		this.ctx.editor.onExternalEditor = () => void this.openExternalEditor();
		this.ctx.editor.setActionKeys(
			"app.clipboard.pasteImage",
			this.ctx.keybindings.getKeys("app.clipboard.pasteImage"),
		);
		this.ctx.editor.onPasteImage = () => this.handleImagePaste();
		this.ctx.editor.onPasteImagePath = path => this.handleImagePathPaste(path);
		this.ctx.editor.setActionKeys(
			"app.clipboard.pasteTextRaw",
			this.ctx.keybindings.getKeys("app.clipboard.pasteTextRaw"),
		);
		this.ctx.editor.onPasteTextRaw = () => void this.handleClipboardTextRawPaste();
		this.ctx.editor.onLargePaste = (text, lineCount) => this.handleLargePaste(text, lineCount);
		this.ctx.editor.setActionKeys(
			"app.clipboard.copyPrompt",
			this.ctx.keybindings.getKeys("app.clipboard.copyPrompt"),
		);
		this.ctx.editor.onCopyPrompt = () => this.handleCopyPrompt();
		this.ctx.editor.setActionKeys("app.tools.expand", this.ctx.keybindings.getKeys("app.tools.expand"));
		this.ctx.editor.onExpandTools = () => this.toggleToolOutputExpansion();
		this.ctx.editor.setActionKeys("app.message.dequeue", this.ctx.keybindings.getKeys("app.message.dequeue"));
		this.ctx.editor.onDequeue = () => this.handleDequeue();
		this.ctx.editor.setActionKeys("app.retry", this.ctx.keybindings.getKeys("app.retry"));
		this.ctx.editor.onRetry = () => void this.handleRetry();
		this.ctx.editor.clearCustomKeyHandlers();
		this.registerExtensionShortcuts();
		const planModeKeys = this.ctx.keybindings.getKeys("app.plan.toggle");
		for (const key of planModeKeys) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handlePlanModeCommand());
		}

		for (const key of this.ctx.keybindings.getKeys("app.session.new")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.handleClearCommand());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.tree")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showTreeSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.fork")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showUserMessageSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.resume")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showSessionSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.message.followUp")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.handleFollowUp());
		}
		for (const key of this.ctx.keybindings.getKeys("app.stt.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handleSTTToggle());
		}
		this.ctx.editor.sttHoldEnabled = () => settings.get("stt.enabled");
		this.ctx.editor.onSpaceHoldStart = () => void this.ctx.handleSTTToggle();
		this.ctx.editor.onSpaceHoldEnd = () => void this.ctx.handleSTTToggle();
		for (const key of this.ctx.keybindings.getKeys("app.clipboard.copyLine")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.handleCopyCurrentLine());
		}
		const hubKeys = new Set([
			...this.ctx.keybindings.getKeys("app.agents.hub"),
			...this.ctx.keybindings.getKeys("app.session.observe"),
		]);
		for (const key of hubKeys) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showAgentsDashboard());
		}

		this.ctx.editor.onLeftAtStart = () => {
			if (this.ctx.focusedAgentId) {
				this.#handleFocusedLeftTap();
				return;
			}
			if (this.#detectLeftDoubleTap()) {
				this.ctx.showAgentsDashboard({ requireContent: true });
			}
		};

		this.#setupEnhancedPaste();

		this.ctx.editor.onChange = (text: string) => {
			const wasBashMode = this.ctx.isBashMode;
			const wasPythonMode = this.ctx.isPythonMode;
			const trimmed = text.trimStart();
			this.ctx.isBashMode = trimmed.startsWith("!");
			this.ctx.isPythonMode = parsePythonCommandInput(trimmed) !== undefined;
			if (wasBashMode !== this.ctx.isBashMode || wasPythonMode !== this.ctx.isPythonMode) {
				this.ctx.updateEditorBorderColor();
			}
			this.ctx.refreshComposerShortcuts();
			if (text.length > 0) this.ctx.dismissWelcome();
		};
	}

	#handleFocusedLeftTap(): void {
		if (this.#detectLeftDoubleTap()) {
			void this.ctx.unfocusSession();
		}
	}

	#detectLeftDoubleTap(): boolean {
		const now = Date.now();
		const sinceLast = now - this.ctx.lastLeftTapTime;
		this.ctx.lastLeftTapTime = now;
		if (sinceLast >= AGENT_VIEW_LEFT_TAP_WINDOW_MS) {
			this.#leftTapCount = 1;
			return false;
		}
		this.#leftTapCount += 1;
		if (this.#leftTapCount === 2 && sinceLast >= LEFT_DOUBLE_TAP_MIN_GAP_MS) {
			this.#leftTapCount = 0;
			this.ctx.lastLeftTapTime = 0;
			return true;
		}
		return false;
	}

	#setupEnhancedPaste(): void {
		if (this.#enhancedPaste) return;

		this.#enhancedPaste = new EnhancedPasteController({
			write: data => this.ctx.ui.terminal.write(data),
			requestMode: () => this.ctx.ui.terminal.requestEnhancedPaste?.(),
			pasteText: text => {
				const focused = this.ctx.ui.getFocused();
				const target = focused && focused !== this.ctx.editor && hasPasteText(focused) ? focused : this.ctx.editor;
				target.pasteText(text);
				this.ctx.ui.requestRender();
			},
			pasteImage: async image => {
				const focused = this.ctx.ui.getFocused();
				if (focused && focused !== this.ctx.editor && hasPasteText(focused)) {
					this.ctx.showStatus("Image paste is not supported in this prompt");
					return;
				}
				await this.#normalizeAndInsertPastedImage(image, `Unsupported pasted image format: ${image.mimeType}`);
			},
			showStatus: message => this.ctx.showStatus(message),
		});
		this.ctx.ui.addInputListener(data => (this.#enhancedPaste?.handleInput(data) ? { consume: true } : undefined));
		this.ctx.ui.addStartListener(() => this.#enhancedPaste?.enable());
	}

	setupEditorSubmitHandler(): void {
		this.ctx.editor.onSubmit = async (text: string) => {
			this.ctx.ui.scrollToLiveTail();
			text = normalizeSubmittedPrompt(text);
			const hasPendingImages = this.ctx.editor.pendingImages.length > 0;
			if ((!isSettingsInitialized() || settings.get("emojiAutocomplete")) && text) text = expandEmoticons(text);

			if (this.ctx.focusedAgentId) {
				await this.#submitToFocusedSession(text, "steer");
				return;
			}

			if (!text && !hasPendingImages && this.ctx.session.isStreaming) {
				if (this.ctx.session.queuedMessageCount > 0) {
					const aborting = this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
					await aborting;
					this.ctx.updatePendingMessagesDisplay();
					this.ctx.ui.requestRender();
				}
				return;
			}

			if (!text && !hasPendingImages) return;

			if (text === "." || text === "c") {
				if (this.ctx.onInputCallback) {
					this.ctx.editor.clearDraft();
					this.ctx.onInputCallback({
						text: turnControlPrompts["turn-control/manual-continue"].text,
						cancelled: false,
						started: true,
						synthetic: true,
						userInitiated: true,
					});
				}
				return;
			}

			const runner = this.ctx.session.extensionRunner;
			let inputImages = this.ctx.editor.pendingImages.length > 0 ? this.ctx.editor.pendingImages.slice() : undefined;
			let inputImageLinks =
				this.ctx.editor.pendingImageLinks.length > 0 ? this.ctx.editor.pendingImageLinks.slice() : undefined;
			let hasInputImages = (inputImages?.length ?? 0) > 0;

			if (runner?.hasHandlers("input")) {
				const result = await runner.emitInput(text, inputImages, "interactive");
				if (result?.handled) {
					this.ctx.editor.clearDraft();
					return;
				}
				if (result?.text !== undefined) {
					text = normalizeSubmittedPrompt(result.text);
				}
				if (result?.images !== undefined) {
					inputImages = result.images;
					inputImageLinks = await materializeImageReferenceLinks(
						inputImages,
						this.ctx.sessionManager.putBlob.bind(this.ctx.sessionManager),
					);
				}
				hasInputImages = (inputImages?.length ?? 0) > 0;
			}

			if (!text && !hasInputImages) return;

			const queueBody = parseQueueShorthand(text);
			if (queueBody !== undefined) {
				await this.#queueForYield(queueBody, {
					historyText: text,
					images: inputImages,
					imageLinks: inputImageLinks,
				});
				return;
			}

			if (text) {
				const slashResult = await executeBuiltinSlashCommand(text, {
					ctx: this.ctx,
				});
				if (slashResult === true) {
					if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
					return;
				}
				if (typeof slashResult === "string") {
					if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
					text = slashResult;
				}
			}

			if (this.ctx.collabGuest) {
				if (text.startsWith("/")) {
					this.ctx.showStatus(`${text.split(/\s+/, 1)[0]} is host-only during a collab session`);
					this.ctx.editor.setText("");
					return;
				}
				if (text.startsWith("!") || parsePythonCommandInput(text)) {
					this.ctx.showStatus("Local execution is host-only during a collab session");
					this.ctx.editor.setText("");
					return;
				}
				if (this.ctx.collabGuest.readOnly) {
					this.ctx.showStatus("This collab link is read-only — prompting is disabled");
					return;
				}
				const images = inputImages && inputImages.length > 0 ? inputImages.slice() : undefined;
				this.ctx.editor.clearDraft(text);
				this.ctx.collabGuest.sendPrompt(text, images);
				return;
			}

			if (text && isKnownSkillCommand(this.ctx, text)) {
				if (this.ctx.session.isCompacting) {
					const images = inputImages && inputImages.length > 0 ? inputImages.slice() : undefined;
					this.ctx.queueCompactionMessage(text, "steer", images);
					return;
				}
				if (await this.#invokeSkillCommand(text, "steer", inputImages, inputImageLinks)) {
					return;
				}
			}

			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.ctx.session.isBashRunning) {
						this.ctx.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.ctx.editor.setText(text);
						return;
					}
					this.ctx.editor.addToHistory(text);
					await this.ctx.handleBashCommand(command, isExcluded);
					this.ctx.isBashMode = false;
					this.ctx.updateEditorBorderColor();
					return;
				}
			}

			const pythonCommand = parsePythonCommandInput(text);
			if (pythonCommand) {
				const { code, isExcluded } = pythonCommand;
				if (code) {
					if (this.ctx.session.isEvalRunning) {
						this.ctx.showWarning("A Python execution is already running. Press Esc to cancel it first.");
						this.ctx.editor.setText(text);
						return;
					}
					this.ctx.editor.addToHistory(text);
					await this.ctx.handlePythonCommand(code, isExcluded);
					this.ctx.isPythonMode = false;
					this.ctx.updateEditorBorderColor();
					return;
				}
			}

			if (this.ctx.loopModeEnabled) {
				this.ctx.loopPrompt = text;
			}

			if (this.ctx.session.isCompacting) {
				const images = inputImages && inputImages.length > 0 ? inputImages.slice() : undefined;
				this.ctx.queueCompactionMessage(text, "steer", images);
				return;
			}

			if (this.ctx.session.isStreaming) {
				this.ctx.editor.addToHistory(text);
				this.ctx.editor.setText("");
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? inputImages.slice() : undefined;
				this.ctx.editor.pendingImages = [];
				this.ctx.editor.pendingImageLinks = [];
				try {
					await this.ctx.withLocalSubmission(
						text,
						() => this.ctx.session.prompt(text, { streamingBehavior: "steer", images }),
						{ imageCount: images?.length ?? 0 },
					);
				} catch (error) {
					this.ctx.editor.setText(text);
					if (images && images.length > 0) {
						this.ctx.editor.pendingImages = images.slice();
						this.ctx.editor.pendingImageLinks = inputImageLinks
							? inputImageLinks.slice()
							: new Array(images.length);
						this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
					}
					this.ctx.showError(errorMessage(error));
				}
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
				return;
			}

			this.ctx.flushPendingBashComponents();

			if (!this.ctx.sessionManager.getSessionName() && !autoTitleDisabled() && !isLowSignalTitleInput(text)) {
				this.#showTinyTitleDownloadProgress(this.ctx.settings.get("providers.tinyModel"));
				const registry = this.ctx.session.modelRegistry;
				generateSessionTitle(
					text,
					registry,
					this.ctx.settings,
					this.ctx.session.sessionId,
					this.ctx.session.model,
					provider => this.ctx.session.agent.metadataForProvider(provider),
					this.ctx.session.titleSystemPrompt,
					providerText => this.ctx.session.obfuscateProviderText(providerText),
					this.ctx.session.sideComplete,
				)
					.then(async title => {
						if (title && !this.ctx.sessionManager.getSessionName()) {
							await this.ctx.sessionManager.setSessionName(title, "auto");
						}
					})
					.catch(err => {
						logger.warn("title-generator: uncaught auto-title error", {
							sessionId: this.ctx.session.sessionId,
							reason: "uncaught-auto-title-error",
							error: errorMessage(err),
						});
					});
			}

			if (this.ctx.onInputCallback) {
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? inputImages.slice() : undefined;
				this.ctx.editor.pendingImages = [];
				this.ctx.editor.pendingImageLinks = [];

				const submission = this.ctx.startPendingSubmission({
					text,
					images,
					imageLinks: inputImageLinks,
					streamingBehavior: "steer",
				});

				this.ctx.onInputCallback(submission);
			} else {
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? inputImages.slice() : undefined;
				this.ctx.editor.pendingImages = [];
				this.ctx.editor.pendingImageLinks = [];
				try {
					await this.ctx.withLocalSubmission(
						text,
						() => this.ctx.session.prompt(text, { streamingBehavior: "steer", images }),
						{
							imageCount: images?.length ?? 0,
						},
					);
				} catch (error) {
					this.ctx.editor.setText(text);
					if (images && images.length > 0) {
						this.ctx.editor.pendingImages = images.slice();
						this.ctx.editor.pendingImageLinks = inputImageLinks
							? inputImageLinks.slice()
							: new Array(images.length);
						this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
					}
					this.ctx.showError(errorMessage(error));
				}
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
			this.ctx.editor.addToHistory(text);
		};
	}

	async #submitToFocusedSession(text: string, streamingBehavior: "steer" | "followUp"): Promise<void> {
		const target = this.ctx.viewSession;
		const images = this.ctx.editor.pendingImages.length > 0 ? this.ctx.editor.pendingImages.slice() : undefined;
		const imageLinks =
			images && this.ctx.editor.pendingImageLinks.length > 0 ? this.ctx.editor.pendingImageLinks.slice() : undefined;
		if (!text && !images) {
			if (target.isStreaming && target.queuedMessageCount > 0) {
				const aborting = target.abort({ reason: USER_INTERRUPT_LABEL });
				await aborting;
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
			return;
		}
		if (text && (text.startsWith("/") || text.startsWith("!") || parsePythonCommandInput(text))) {
			this.ctx.showStatus("Commands run in the main session — press ←← to return first");
			return; // editor text not cleared: Editor does not auto-clear on submit
		}
		this.ctx.editor.clearDraft(text);
		try {
			await this.ctx.withLocalSubmission(text, () => target.prompt(text, { streamingBehavior, images }), {
				imageCount: images?.length ?? 0,
			});
		} catch (error) {
			this.ctx.editor.setText(text);
			if (images && images.length > 0) {
				this.ctx.editor.pendingImages = images.slice();
				this.ctx.editor.pendingImageLinks = imageLinks ? imageLinks.slice() : new Array(images.length);
				this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
			}
			this.ctx.showError(errorMessage(error));
		}
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.ui.requestRender();
	}

	handleCtrlC(): void {
		try {
			this.ctx.sessionManager.flushSync();
		} catch (err) {
			logger.warn("session-manager sync flush on Ctrl+C failed", {
				error: errorMessage(err),
			});
		}

		if (this.ctx.isShuttingDown) {
			process.exit(EXIT_INTERRUPTED);
		}

		const now = Date.now();
		if (now - this.ctx.lastSigintTime < 500) {
			void this.ctx.shutdown();
		} else {
			this.ctx.clearEditor();
			this.ctx.lastSigintTime = now;
		}
	}

	handleCtrlD(): void {
		void this.ctx.shutdown();
	}

	handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.ctx.showStatus("Suspend (Ctrl+Z) is not supported on this platform");
			return;
		}

		const onResume = (): void => {
			this.ctx.ui.start();
			this.ctx.ui.requestRender(true);
		};
		process.once("SIGCONT", onResume);

		this.ctx.ui.stop();

		try {
			process.kill(0, "SIGSTOP");
		} catch (err) {
			process.removeListener("SIGCONT", onResume);
			this.ctx.ui.start();
			this.ctx.ui.requestRender(true);
			const reason = errorMessage(err);
			this.ctx.showError(`Failed to suspend: ${reason}`);
		}
	}

	handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.ctx.showStatus("No queued messages to restore");
		} else {
			this.ctx.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	async #invokeSkillCommand(
		text: string,
		streamingBehavior: "steer" | "followUp",
		images?: ImageContent[],
		imageLinks?: (string | undefined)[],
	): Promise<boolean> {
		if (!isKnownSkillCommand(this.ctx, text)) return false;
		const draftImages = images && images.length > 0 ? images.slice() : undefined;
		const draftImageLinks = draftImages && imageLinks && imageLinks.length > 0 ? imageLinks.slice() : undefined;
		const restoreDraft = () => {
			this.ctx.editor.setText(text);
			if (draftImages && draftImages.length > 0) {
				this.ctx.editor.pendingImages = draftImages.slice();
				this.ctx.editor.pendingImageLinks = draftImageLinks
					? draftImageLinks.slice()
					: new Array(draftImages.length);
				this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
			}
		};

		this.ctx.editor.clearDraft(text);
		try {
			const handled = await invokeSkillCommandFromText(this.ctx, text, streamingBehavior, {
				images: draftImages,
				propagateErrors: true,
			});
			if (!handled) {
				restoreDraft();
				return false;
			}
			return true;
		} catch (error) {
			restoreDraft();
			this.ctx.showError(errorMessage(error));
			return true;
		} finally {
			if (this.ctx.session.isStreaming) {
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
		}
	}

	async handleRetry(): Promise<void> {
		if (this.ctx.collabGuest) {
			this.ctx.showStatus("/retry is host-only during a collab session");
			return;
		}
		const didRetry = await this.ctx.viewSession.retry();
		if (didRetry) {
			this.ctx.editor.clearDraft();
		} else {
			this.ctx.showStatus("Nothing to retry");
		}
	}

	async handleQueueCommand(text: string): Promise<void> {
		const images = this.ctx.editor.pendingImages.length > 0 ? this.ctx.editor.pendingImages.slice() : undefined;
		const imageLinks =
			images && this.ctx.editor.pendingImageLinks.length > 0 ? this.ctx.editor.pendingImageLinks.slice() : undefined;
		await this.#queueForYield(text, { images, imageLinks });
	}

	async #queueForYield(
		text: string,
		options: {
			historyText?: string;
			images?: ImageContent[];
			imageLinks?: (string | undefined)[];
		},
	): Promise<void> {
		const splitMessages = splitQueuedMessages(text);
		if (splitMessages.length === 0 && !options.images?.length) {
			this.ctx.editor.clearDraft();
			this.ctx.showWarning("Usage: /queue <message> (or start a prompt with -> / =>)");
			return;
		}

		const messages = splitMessages.length > 0 ? splitMessages : [""];
		const originalDraft = this.ctx.editor.getText();
		const images = options.images?.length ? options.images.slice() : undefined;
		const imageLinks = options.imageLinks
			? options.imageLinks.slice()
			: images
				? new Array(images.length)
				: undefined;
		this.ctx.editor.clearDraft(options.historyText);

		if (this.ctx.session.isCompacting) {
			for (let index = 0; index < messages.length; index++) {
				this.ctx.compactionQueuedMessages.push({
					text: messages[index] ?? "",
					mode: "followUp",
					images: index === 0 ? images : undefined,
				});
			}
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.showStatus(
				messages.length === 1
					? "Queued message for after compaction"
					: `Queued ${messages.length} messages for after compaction`,
			);
			this.ctx.ui.requestRender();
			return;
		}

		const startImmediately = !this.ctx.session.isStreaming && this.ctx.session.queuedMessageCount === 0;
		let queuedCount = 0;
		try {
			if (startImmediately && this.ctx.onInputCallback) {
				const first = messages[0] ?? "";
				const submission = this.ctx.startPendingSubmission({
					text: first,
					images,
					imageLinks,
					streamingBehavior: "followUp",
				});
				this.ctx.onInputCallback(submission);
				queuedCount = 1;
			}
			while (queuedCount < messages.length) {
				const message = messages[queuedCount] ?? "";
				const queuedImages = queuedCount === 0 ? images : undefined;
				await this.ctx.withLocalSubmission(
					message,
					async () => {
						if (startImmediately && queuedCount === 0) {
							await this.ctx.session.prompt(message, {
								images: queuedImages,
								streamingBehavior: "followUp",
							});
						} else {
							await this.ctx.session.followUp(message, queuedImages);
						}
					},
					{ imageCount: queuedImages?.length ?? 0 },
				);
				queuedCount++;
			}
		} catch (error) {
			if (queuedCount === 0) {
				this.ctx.editor.setText(originalDraft);
				if (images) {
					this.ctx.editor.pendingImages = images;
					this.ctx.editor.pendingImageLinks = imageLinks ?? new Array(images.length);
					this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
				}
			} else {
				const remaining = messages.slice(queuedCount);
				const restored =
					remaining.length === 1
						? `=> ${remaining[0]}`
						: `=>\n${remaining
								.map((message, index) => `${index + 1}. ${message.replaceAll("\n", "\n   ")}`)
								.join("\n")}`;
				this.ctx.editor.setText(restored);
			}
			this.ctx.showError(errorMessage(error));
		}

		this.ctx.updatePendingMessagesDisplay();
		if (queuedCount === messages.length) {
			this.ctx.showStatus(
				startImmediately
					? queuedCount === 1
						? "Sent queued message"
						: `Sent first message; queued ${queuedCount - 1} for later yields`
					: queuedCount === 1
						? "Queued message for when the agent yields"
						: `Queued ${queuedCount} messages for when the agent yields`,
			);
		}
		this.ctx.ui.requestRender();
	}

	async handleFollowUp(): Promise<void> {
		let text = normalizeSubmittedPrompt(this.ctx.editor.getExpandedText());
		const images = this.ctx.editor.pendingImages.length > 0 ? this.ctx.editor.pendingImages.slice() : undefined;
		const imageLinks =
			images && this.ctx.editor.pendingImageLinks.length > 0 ? this.ctx.editor.pendingImageLinks.slice() : undefined;
		if (!text && !images) return;

		if (this.ctx.focusedAgentId) {
			await this.#submitToFocusedSession(text, "followUp");
			return;
		}

		if (this.ctx.session.isCompacting) {
			const images = this.ctx.editor.pendingImages.length > 0 ? this.ctx.editor.pendingImages.slice() : undefined;
			this.ctx.queueCompactionMessage(text, "followUp", images);
			return;
		}

		if (text) {
			const slashResult = await executeBuiltinSlashCommand(text, {
				ctx: this.ctx,
			});
			if (slashResult === true) {
				if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
				return;
			}
			if (typeof slashResult === "string") {
				if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
				text = slashResult;
			}
		}

		if (text && (await this.#invokeSkillCommand(text, "followUp", images, imageLinks))) {
			return;
		}

		const restoreOnError = (error: unknown) => {
			this.ctx.editor.setText(text);
			if (images && images.length > 0) {
				this.ctx.editor.pendingImages = images.slice();
				this.ctx.editor.pendingImageLinks = imageLinks ? imageLinks.slice() : new Array(images.length);
				this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
			}
			this.ctx.showError(errorMessage(error));
		};

		if (this.ctx.session.isStreaming) {
			this.ctx.editor.clearDraft(text);
			try {
				await this.ctx.withLocalSubmission(
					text,
					() => this.ctx.session.prompt(text, { streamingBehavior: "followUp", images }),
					{ imageCount: images?.length ?? 0 },
				);
			} catch (error) {
				restoreOnError(error);
			}
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.ui.requestRender();
			return;
		}

		this.ctx.editor.clearDraft(text);
		try {
			await this.ctx.withLocalSubmission(text, () => this.ctx.session.prompt(text, { images }), {
				imageCount: images?.length ?? 0,
			});
		} catch (error) {
			restoreOnError(error);
		}
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		this.ctx.locallySubmittedUserSignatures.clear();
		const { steering, followUp } = this.ctx.session.clearQueue({ forInterrupt: options?.abort });
		const compactionQueued = this.ctx.compactionQueuedMessages;
		this.ctx.compactionQueuedMessages = [];
		const allQueued = steering.slice();
		for (let qi = 0; qi < compactionQueued.length; qi++) {
			const e = compactionQueued[qi]!;
			if (e.mode === "steer") allQueued.push({ text: e.text, images: e.images });
		}
		allQueued.push(...followUp);
		for (let qi = 0; qi < compactionQueued.length; qi++) {
			const e = compactionQueued[qi]!;
			if (e.mode === "followUp") allQueued.push({ text: e.text, images: e.images });
		}
		if (allQueued.length === 0) {
			this.ctx.updatePendingMessagesDisplay();
			if (options?.abort) {
				abortDetached(
					this.ctx.session,
					"input-controller.restoreQueuedMessagesToEditor.empty",
					USER_INTERRUPT_LABEL,
				);
			}
			return 0;
		}
		const queuedImages: (typeof allQueued)[0]["images"] = [];
		for (let qi = 0; qi < allQueued.length; qi++) {
			const imgs = allQueued[qi]!.images;
			if (imgs) for (let ii = 0; ii < imgs.length; ii++) queuedImages.push(imgs[ii]);
		}
		let queuedText: string;
		if (queuedImages.length > 0) {
			const parts: string[] = [];
			let imageOffset = this.ctx.editor.pendingImages.length;
			for (let qi = 0; qi < allQueued.length; qi++) {
				const entry = allQueued[qi]!;
				parts.push(shiftImageMarkers(entry.text, imageOffset));
				if (entry.images && entry.images.length > 0) imageOffset += entry.images.length;
			}
			queuedText = parts.join("\n\n");
		} else {
			let textJoined = "";
			for (let qi = 0; qi < allQueued.length; qi++) {
				if (qi > 0) textJoined += "\n\n";
				textJoined += allQueued[qi]!.text;
			}
			queuedText = textJoined;
		}
		const currentText = options?.currentText ?? this.ctx.editor.getText();
		const combinedText = [queuedText, currentText].filter(t => t.trim()).join("\n\n");
		this.ctx.editor.setText(combinedText);
		if (queuedImages.length > 0) {
			for (let ii = 0; ii < queuedImages.length; ii++) this.ctx.editor.pendingImages.push(queuedImages[ii]!);
			const qi = new Array(queuedImages.length);
			for (let ii = 0; ii < qi.length; ii++) this.ctx.editor.pendingImageLinks.push(qi[ii]!);
			this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
		}
		this.ctx.updatePendingMessagesDisplay();
		if (options?.abort) {
			abortDetached(
				this.ctx.session,
				"input-controller.restoreQueuedMessagesToEditor.restored",
				USER_INTERRUPT_LABEL,
			);
		}
		return allQueued.length;
	}

	async #insertPendingImage(imageData: ImageContent): Promise<void> {
		const imageLink = (
			await materializeImageReferenceLinks(
				[
					{
						type: "image",
						data: imageData.data,
						mimeType: imageData.mimeType,
					},
				],
				this.ctx.sessionManager.putBlob.bind(this.ctx.sessionManager),
			)
		)?.[0];
		this.ctx.editor.pendingImages.push({
			type: "image",
			data: imageData.data,
			mimeType: imageData.mimeType,
		});
		this.ctx.editor.pendingImageLinks.push(imageLink);
		this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
		const imageNum = this.ctx.editor.pendingImages.length;
		const dims = await this.#imageDimensions(imageData);
		const label = dims ? `[Image #${imageNum}, ${dims.width}x${dims.height}]` : `[Image #${imageNum}]`;
		this.ctx.editor.insertText(`${label} `);
		this.ctx.ui.requestRender();
	}

	async #imageDimensions(image: ImageContent): Promise<{ width: number; height: number } | undefined> {
		try {
			const { width, height } = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
			if (width && height) return { width, height };
		} catch {}
		return undefined;
	}

	async #normalizeAndInsertPastedImage(image: ImageContent, unsupportedMessage: string): Promise<boolean> {
		let imageData = await ensureSupportedImageInput(image);
		if (!imageData) {
			this.ctx.showStatus(unsupportedMessage);
			return false;
		}
		if (settings.get("images.autoResize")) {
			try {
				const resized = await resizeImage({
					type: "image",
					data: imageData.data,
					mimeType: imageData.mimeType,
				});
				imageData = { type: "image", data: resized.data, mimeType: resized.mimeType };
			} catch (error) {
				logger.warn("image auto-resize failed; attaching the original unresized image", {
					mimeType: imageData.mimeType,
					error: errorMessage(error),
				});
			}
		}
		await this.#insertPendingImage(imageData);
		return true;
	}

	async #tryPasteClipboardImage(): Promise<boolean> {
		const env = process.env;
		if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return false;
		try {
			const image = await this.clipboard.readImage();
			if (!image) return false;
			await this.#normalizeAndInsertPastedImage(
				{ type: "image", data: image.data.toBase64(), mimeType: image.mimeType },
				`Unsupported clipboard image format: ${image.mimeType}`,
			);
			return true;
		} catch {
			return false;
		}
	}

	async handleImagePathPaste(path: string): Promise<void> {
		try {
			const image = await loadImageInput({
				path,
				cwd: this.ctx.sessionManager.getCwd(),
				autoResize: false,
			});
			if (!image) {
				if (await this.#tryPasteClipboardImage()) return;
				this.ctx.editor.pasteText(path);
				this.ctx.ui.requestRender();
				this.ctx.showStatus("Pasted path is not a supported image");
				return;
			}
			await this.#normalizeAndInsertPastedImage(
				{ type: "image", data: image.data, mimeType: image.mimeType },
				`Unsupported pasted image format: ${image.mimeType}`,
			);
		} catch (error) {
			if (error instanceof ImageInputTooLargeError) {
				this.ctx.editor.pasteText(path);
				this.ctx.ui.requestRender();
				this.ctx.showStatus(error.message);
				return;
			}
			if (isEnoent(error)) {
				if (await this.#tryPasteClipboardImage()) return;
				const env = process.env;
				const overSsh = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
				const displayPath = truncateToWidth(
					shortenPath(
						sanitizeText(path)
							.replace(/[\r\n\t]+/g, " ")
							.trim(),
					),
					TRUNCATE_LENGTHS.CONTENT,
				);
				this.ctx.showStatus(
					overSsh
						? `Image not found at ${displayPath}. Over SSH this path is local to your terminal — paste the image directly (clipboard image-paste shortcut) to send its bytes.`
						: `Image not found at ${displayPath}`,
				);
				return;
			}
			if (await this.#tryPasteClipboardImage()) return;
			this.ctx.editor.pasteText(path);
			this.ctx.ui.requestRender();
			this.ctx.showStatus("Failed to read pasted image path");
		}
	}

	async handleImagePaste(): Promise<boolean> {
		try {
			const image = await this.clipboard.readImage();
			if (image) {
				return await this.#normalizeAndInsertPastedImage(
					{
						type: "image",
						data: image.data.toBase64(),
						mimeType: image.mimeType,
					},
					`Unsupported clipboard image format: ${image.mimeType}`,
				);
			}
			const fileUrls = (await this.clipboard.readMacFileUrls?.()) ?? [];
			let attachedFromFileUrls = false;
			for (const url of fileUrls) {
				const candidate = extractImagePathFromText(url);
				if (!candidate) continue;
				await this.handleImagePathPaste(candidate);
				attachedFromFileUrls = true;
			}
			if (attachedFromFileUrls) return true;
			const text = await this.clipboard.readText();
			if (!text) {
				this.ctx.showStatus("Clipboard is empty");
				return false;
			}
			const imagePath = extractImagePathFromText(text);
			if (imagePath) {
				await this.handleImagePathPaste(imagePath);
				return true;
			}
			const focused = this.ctx.ui.getFocused();
			const target = focused && focused !== this.ctx.editor && hasPasteText(focused) ? focused : this.ctx.editor;
			target.pasteText(text);
			this.ctx.ui.requestRender();
			return true;
		} catch {
			this.ctx.showStatus("Failed to read clipboard");
			return false;
		}
	}

	async handleClipboardTextRawPaste(): Promise<void> {
		try {
			const text = await this.clipboard.readText();
			if (text) {
				this.ctx.editor.insertText(text);
				this.ctx.ui.requestRender();
			} else {
				this.ctx.showStatus("No text in clipboard to paste raw");
			}
		} catch {
			this.ctx.showStatus("Failed to paste raw text from clipboard");
		}
	}

	handleLargePaste(text: string, lineCount: number): boolean {
		const threshold = this.ctx.settings.get("paste.largeMenuThreshold");
		if (!(threshold > 0) || lineCount < threshold) return false;
		void this.presentLargePasteMenu(text, lineCount);
		return true;
	}

	async presentLargePasteMenu(text: string, lineCount: number): Promise<void> {
		const WRAPPED_BLOCK = "Attach as a wrapped block";
		const LOCAL_FILE = "Attach as local file";
		const INLINE = "Paste inline";

		let choice: string | undefined;
		try {
			choice = await this.ctx.showHookSelector(
				`Pasted ${lineCount} lines`,
				[
					{ label: WRAPPED_BLOCK, description: "Wrap the text in <attachment> tags, collapsed to a marker" },
					{ label: LOCAL_FILE, description: "Save the text to a local://attachment file" },
					{ label: INLINE, description: "Collapse the text to an inline paste marker" },
				],
				{ helpText: "Esc to paste inline" },
			);
		} catch (error) {
			logger.warn("large-paste menu failed", { error: errorMessage(error) });
			choice = undefined;
		}

		switch (choice) {
			case WRAPPED_BLOCK:
				this.ctx.editor.insertPaste(wrapPasteInAttachmentBlock(text));
				break;
			case LOCAL_FILE:
				await this.#attachPasteAsFile(text, lineCount);
				break;
			case INLINE:
				this.ctx.editor.insertPaste(text);
				break;
			default:
				this.ctx.editor.insertPaste(text);
				break;
		}
		this.ctx.ui.requestRender();
	}

	async #attachPasteAsFile(text: string, lineCount: number): Promise<void> {
		try {
			const localRoot = resolveLocalRoot({
				getArtifactsDir: () => this.ctx.sessionManager.getArtifactsDir(),
				getSessionId: () => this.ctx.sessionManager.getSessionId(),
			});
			let name: string;
			let filePath: string;
			do {
				this.#attachmentCounter++;
				name = `attachment-${this.#attachmentCounter}`;
				filePath = path.join(localRoot, name);
			} while (await Bun.file(filePath).exists());
			await Bun.write(filePath, text);
			this.ctx.editor.insertText(`local://${name} `);
			this.ctx.showStatus(`Saved ${lineCount} pasted lines to local://${name}`);
		} catch (error) {
			logger.warn("failed to save large paste to file", {
				error: errorMessage(error),
			});
			this.ctx.editor.insertPaste(text);
			this.ctx.showError("Failed to save paste to a file — pasted inline instead");
		}
	}

	createAutocompleteProvider(commands: SlashCommand[], basePath: string): AutocompleteProvider {
		return createPromptActionAutocompleteProvider({
			commands,
			basePath,
			skills: this.ctx.session.skills,
			keybindings: this.ctx.keybindings,
			copyCurrentLine: () => this.handleCopyCurrentLine(),
			copyPrompt: () => this.handleCopyPrompt(),
			undo: prefix => this.ctx.editor.undoPastTransientText(prefix),
			moveCursorToMessageEnd: () => this.ctx.editor.moveToMessageEnd(),
			moveCursorToMessageStart: () => this.ctx.editor.moveToMessageStart(),
			moveCursorToLineStart: () => this.ctx.editor.moveToLineStart(),
			moveCursorToLineEnd: () => this.ctx.editor.moveToLineEnd(),
		});
	}

	handleCopyCurrentLine(): void {
		const { line } = this.ctx.editor.getCursor();
		const text = this.ctx.editor.getLines()[line] || "";
		if (!text) {
			this.ctx.showStatus("Nothing to copy");
			return;
		}
		try {
			copyToClipboard(text);
			const sanitized = sanitizeText(text);
			const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
			this.ctx.showStatus(`Copied line: ${preview}`);
		} catch {
			this.ctx.showWarning("Failed to copy to clipboard");
		}
	}

	handleCopyPrompt(): void {
		const text = this.ctx.editor.getText();
		if (!text) {
			this.ctx.showStatus("Nothing to copy");
			return;
		}
		try {
			copyToClipboard(text);
			const sanitized = sanitizeText(text);
			const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
			this.ctx.showStatus(`Copied: ${preview}`);
		} catch {
			this.ctx.showWarning("Failed to copy to clipboard");
		}
	}

	cycleThinkingLevel(): void {
		if (this.ctx.focusedAgentId) {
			this.ctx.showStatus("Model/thinking apply to the main session — press ←← to return first");
			return;
		}
		const newLevel = this.ctx.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.ctx.showStatus("Current model does not support thinking");
		} else {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}
	}

	async cycleRoleModel(direction: "forward" | "backward" = "forward"): Promise<void> {
		if (this.ctx.focusedAgentId) {
			this.ctx.showStatus("Model/thinking apply to the main session — press ←← to return first");
			return;
		}
		try {
			const cycleOrder = settings.get("cycleOrder");
			const result = await this.ctx.session.cycleRoleModels(cycleOrder, direction);
			if (!result) {
				this.ctx.showStatus("Only one role model available");
				return;
			}

			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			const track = renderSegmentTrack(
				cycleOrder.map(role => ({ label: role })),
				cycleOrder.indexOf(result.role),
			);
			this.ctx.showModelCycleTrack(track);
		} catch (error) {
			this.ctx.showError(errorMessage(error));
		}
	}

	toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.ctx.toolOutputExpanded);
	}

	setToolsExpanded(expanded: boolean): void {
		this.ctx.toolOutputExpanded = expanded;
		this.ctx.settings.set("display.toolOutputExpanded", expanded);
		for (const child of this.ctx.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.ctx.ui.resetDisplay();
	}

	toggleThinkingBlockVisibility(): void {
		const thinkingOff =
			((this.ctx.viewSession ?? this.ctx.session)?.thinkingLevel ?? ThinkingLevel.Off) === ThinkingLevel.Off;
		if (thinkingOff && !this.ctx.hasDisplayableThinkingContent) {
			this.ctx.showStatus("Thinking is off — enable thinking to show blocks");
			return;
		}
		this.ctx.hideThinkingBlock = !this.ctx.hideThinkingBlock;
		this.ctx.settings.set("hideThinkingBlock", this.ctx.hideThinkingBlock);

		for (const child of this.ctx.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHideThinkingBlock(this.ctx.hideThinkingBlock);
			}
		}

		if (this.ctx.streamingComponent && this.ctx.streamingMessage) {
			this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.hideThinkingBlock);
			this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
		}

		this.ctx.ui.resetDisplay();

		this.ctx.showStatus(`Thinking blocks: ${this.ctx.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	#getEditorTerminalPath(): string | null {
		if (process.platform === "win32") {
			return null;
		}
		return "/dev/tty";
	}

	async #openEditorTerminalHandle(): Promise<fs.FileHandle | null> {
		const terminalPath = this.#getEditorTerminalPath();
		if (!terminalPath) {
			return null;
		}
		try {
			return await fs.open(terminalPath, "r+");
		} catch {
			return null;
		}
	}

	async openExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.ctx.editor.getExpandedText?.() ?? this.ctx.editor.getText();

		let ttyHandle: fs.FileHandle | null = null;
		try {
			ttyHandle = await this.#openEditorTerminalHandle();
			this.ctx.ui.stop();

			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = ttyHandle
				? [ttyHandle.fd, ttyHandle.fd, ttyHandle.fd]
				: ["inherit", "inherit", "inherit"];

			const result = await openInEditor(editorCmd, currentText, { extension: ".veyyon.md", stdio });
			if (result !== null) {
				this.ctx.editor.setText(result);
			}
		} catch (error) {
			this.ctx.showWarning(`Failed to open external editor: ${errorMessage(error)}`);
		} finally {
			if (ttyHandle) {
				await ttyHandle.close();
			}

			this.ctx.ui.start();
			this.ctx.ui.requestRender();
		}
	}

	registerExtensionShortcuts(): void {
		const runner = this.ctx.session.extensionRunner;
		if (!runner) return;

		const shortcuts = runner.getShortcuts();
		for (const [keyId, shortcut] of shortcuts) {
			this.ctx.editor.setCustomKeyHandler(keyId, () => {
				const ctx = runner.createCommandContext();
				try {
					shortcut.handler(ctx);
				} catch (err) {
					runner.emitError({
						extensionPath: shortcut.extensionPath,
						event: "shortcut",
						error: errorMessage(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			});
		}
	}
}
