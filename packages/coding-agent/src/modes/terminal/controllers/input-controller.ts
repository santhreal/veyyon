import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { ImageContent } from "@veyyon/ai";
import { abortDetached } from "@veyyon/kernel/session/detached-abort";
import { errorMessage, isEnoent, logger, sanitizeText } from "@veyyon/utils";
import type { AutocompleteProvider, SlashCommand } from "@veyyon/utils/autocomplete";
import { type KeyId, matchesKey } from "@veyyon/utils/keys";
import { EXIT_INTERRUPTED } from "../../../cli/exit-codes";
import type { CollabGuestLink } from "../../../collab/guest";
// The slot leaf, not the 94-module store: this file reads values, it does not fill them.
import { isSettingsInitialized, settings } from "../../../config/settings-instance";
// The owning module, not the `internal-urls` barrel: the barrel re-exports every protocol
// handler and reaches hundreds of modules.
import { resolveLocalRoot } from "../../../internal-urls/local-protocol";
import { toAssistantMessageView } from "../../../presentation/transcript-builder";
import { turnControlPrompts } from "../../../prompts/turn-control/rows";
import type { AgentSession } from "../../../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../../../session/messages";
import { dispatchBuiltinSlashCommand } from "../../../slash-commands/dispatch";
import { isSensitiveSlashCommand, normalizeSubmittedPrompt } from "../../../slash-commands/helpers/parse";
import type { TuiSlashCommandHostContext } from "../../../slash-commands/types";
import { vocalizer } from "../../../speech/tts/vocalizer";
import { isLowSignalTitleInput } from "../../../tiny/text";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../../../tools/core/render-utils";
import { requestManualBackground } from "../../../tools/shell/bash-foreground-registry";
import {
	copyToClipboard,
	readImageFromClipboard,
	readMacFileUrlsFromClipboard,
	readTextFromClipboard,
} from "../../../utils/clipboard";
import { EnhancedPasteController } from "../../../utils/enhanced-paste";
import { getEditorCommand, openInEditor } from "../../../utils/external-editor";
import { ensureSupportedImageInput, ImageInputTooLargeError, loadImageInput } from "../../../utils/image-loading";
import { resizeImage } from "../../../utils/image-resize";
import { autoTitleDisabled, generateSessionTitle } from "../../../utils/title-generator";
import { expandEmoticons } from "../autocomplete/emoji-autocomplete";
import { createPromptActionAutocompleteProvider } from "../autocomplete/prompt-action-autocomplete";
import { renderSegmentTrack } from "../components/chrome/segment-track";
import {
	CONFIGURABLE_EDITOR_ACTIONS,
	type DeferredEditorAction,
	extractImagePathFromText,
} from "../components/composer/custom-editor";
import { AGENT_VIEW_LEFT_TAP_WINDOW_MS } from "../components/dashboard/agent-view-timings";
import { AssistantMessageComponent } from "../components/transcript/assistant-message";
import { shiftImageMarkers } from "../image-reference-markers";
import { materializeImageReferenceLinks } from "../image-references";
import { parseQueueShorthand, splitQueuedMessages } from "../queue-input";
import { invokeSkillCommandFromText, isKnownSkillCommand, type SkillCommandHost } from "../skill-command";
import type { InteractiveModeContext } from "../types";
import { showTinyTitleDownloadRow } from "./tiny-title-download-row";

/**
 * Compatibility name for the editor-history policy.
 *
 * Classification itself lives beside the canonical slash parser so teardown,
 * normal Enter and follow-up submission cannot disagree about colon forms or
 * malformed `/secret` input.
 */
export function shouldSkipHistory(slashText: string): boolean {
	return isSensitiveSlashCommand(slashText);
}

interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

/** Minimal contract for any component that can receive a paste payload directly. */
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

/** Wrap pasted text in `<attachment>` tags so the model treats it as one quoted block. */
function wrapPasteInAttachmentBlock(content: string): string {
	return `<attachment>\n${content}\n</attachment>`;
}

/** Run a teardown abort that must never throw (Esc / Ctrl+C path). A thrown
 *  error is logged at debug instead of silently swallowed, so a failing abort
 *  stays diagnosable without disturbing teardown ordering. */
function safeAbort(label: string, fn: () => void): void {
	try {
		fn();
	} catch (err) {
		logger.debug(`Failed to abort ${label}`, { error: errorMessage(err) });
	}
}

/** A submission's text with the images and blob links that ride along with it. */
interface SubmittedInput {
	text: string;
	images: ImageContent[] | undefined;
	imageLinks: (string | undefined)[] | undefined;
}

/** A copy of `items`, or undefined when there are none, so a submission never aliases the editor's pending arrays. */
function nonEmptyCopy<T>(items: readonly T[] | undefined): T[] | undefined {
	return items && items.length > 0 ? items.slice() : undefined;
}

/** `text` as submitted: prompt-normalized, with its emoticons expanded unless emoji autocomplete is off. */
function preparedSubmitText(text: string): string {
	const normalized = normalizeSubmittedPrompt(text);
	if (!normalized || (isSettingsInitialized() && !settings.get("emojiAutocomplete"))) return normalized;
	return expandEmoticons(normalized);
}

/** A `/queue` submission split into the messages it sends, with the images that ride on the first. */
interface QueuedBatch {
	readonly messages: readonly string[];
	readonly images: ImageContent[] | undefined;
	readonly imageLinks: (string | undefined)[] | undefined;
	/** What the editor holds again when the first message fails: the line as typed, or the batch as an `=>` queue. */
	readonly draft: string;
	/** The session was idle with nothing queued, so the first message starts a turn. */
	readonly startImmediately: boolean;
}

/** The status once every message of a queued batch went out; `startedTurn` when the first one began a turn. */
function queuedStatus(count: number, startedTurn: boolean): string {
	if (count === 1) return startedTurn ? "Sent queued message" : "Queued message for when the agent yields";
	if (startedTurn) return `Sent first message; queued ${count - 1} for later yields`;
	return `Queued ${count} messages for when the agent yields`;
}

/** The `=>` draft that queues `remaining` again when it is submitted. */
function requeuedDraft(remaining: readonly string[]): string {
	if (remaining.length === 1) return `=> ${remaining[0]}`;
	return `=>\n${remaining.map((message, index) => `${index + 1}. ${message.replaceAll("\n", "\n   ")}`).join("\n")}`;
}

/**
 * The status for a pasted image path that does not exist here. Over SSH the path is on the terminal's own
 * filesystem, so pasting it as text would look like an attachment that was never sent. The path is untrusted
 * terminal input: control characters, ANSI and newlines are stripped, home collapses to `~`, and the shown
 * length is bounded.
 */
function missingImagePathStatus(path: string): string {
	const displayPath = truncateToWidth(
		shortenPath(
			sanitizeText(path)
				.replace(/[\r\n\t]+/g, " ")
				.trim(),
		),
		TRUNCATE_LENGTHS.CONTENT,
	);
	const env = process.env;
	if (!(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT)) return `Image not found at ${displayPath}`;
	return `Image not found at ${displayPath}. Over SSH this path is local to your terminal — paste the image directly (clipboard image-paste shortcut) to send its bytes.`;
}

// Double-tap ← on an empty editor opens the agent dashboard (and, in a
// focused agent view, ←← returns to the main session). The upper bound is
// AGENT_VIEW_LEFT_TAP_WINDOW_MS, imported rather than restated: it is the same
// gesture window the agent views were built around, and a second copy of the
// number here is how the two ends of one gesture drift apart. The lower bound
// rejects terminal-synthesized arrow-key bursts: "click to move cursor" /
// pointer features in iTerm2, WezTerm, kitty, and tmux emit several arrow keys
// in a single stdin read (sub-millisecond apart) on a stray click, which used to
// pop the card with no key ever pressed. Three or more rapid taps are likewise
// treated as a burst, not a gesture. A deliberate human double-tap is always
// tens of milliseconds apart.
const LEFT_DOUBLE_TAP_MIN_GAP_MS = 40;

// How long the second Esc has to arrive for a double-press to read as one gesture.
// Both Esc gestures share it: discarding a draft, and `doubleEscapeAction` on an
// empty composer. Two copies of the number is how one gesture grows two feels.
const DOUBLE_ESCAPE_WINDOW_MS = 500;

/**
 * The slice of `InteractiveModeContext` the input controller reads (H1-77). It
 * composes the two surfaces it forwards `ctx` to whole — the TUI slash-command
 * host (`dispatchBuiltinSlashCommand`) and the skill-command host
 * (`isKnownSkillCommand` / `invokeSkillCommandFromText`) — plus the 41 members
 * it reads directly (bash/python/btw/omfg key handling, thinking-block
 * visibility, submission gating, welcome/goal-detail, and the escape/tap
 * timing state). Composing the named host slices (ONE PLACE) keeps the forward
 * surfaces in lockstep instead of re-listing their members here, and naming the
 * whole thing is what lets `InputController` be built in a test without the
 * `as unknown as InteractiveModeContext` cast the 215-member interface forces.
 */
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
		/** Injectable clipboard reads so tests can drive paste flows without a real clipboard. */
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
	#composerKeyListenersInstalled = false;
	// Tap counter for the double-← gesture; reset whenever a quiet gap
	// (>= AGENT_VIEW_LEFT_TAP_WINDOW_MS) starts a fresh sequence. See
	// #detectLeftDoubleTap.
	#leftTapCount = 0;
	// Sequential index for `local://attachment-N` references created by large-paste and
	// pasted-file attachments. Seeded from 0 and bumped past existing attachment files.
	#attachmentCounter = 0;
	// When the first Esc over a non-empty composer armed the discard gesture, or 0 when
	// nothing is armed. Held apart from `ctx.lastEscapeTime`, which arms the empty-composer
	// `doubleEscapeAction`, so neither gesture can complete on the other's first press.
	#draftDiscardArmedAt = 0;

	#abortStreamingTurn(): void {
		abortDetached(this.ctx.session, "input-controller.abortStreamingTurn", USER_INTERRUPT_LABEL);
	}

	/**
	 * Consume `key` while the focused editor is empty and `allowed()` holds, running `act`; any other
	 * state leaves the key to the editor.
	 */
	#addEmptyComposerKeyListener(key: KeyId, allowed: () => boolean, act: () => Promise<unknown>): void {
		this.ctx.ui.addInputListener(data => {
			if (!matchesKey(data, key)) return undefined;
			if (!allowed()) return undefined;
			if (this.ctx.ui.getFocused() !== this.ctx.editor) return undefined;
			if (this.ctx.editor.getText().trim()) return undefined;
			void act();
			return { consume: true };
		});
	}

	/**
	 * Esc stops the topmost activity and nothing beneath it, in this order: a side-channel panel, the view session's
	 * context maintenance, speech playback, loop mode, a focused agent view, a collab guest's host turn, foreground
	 * work, then the draft and the double-Esc action.
	 *
	 * Side-channel panels are the topmost view, so Esc dismisses them before touching loop mode, maintenance, or the
	 * underlying main turn. Active context maintenance owns Esc: auto/manual compaction, handoff generation, and
	 * auto-retry backoff all advertise "(esc to cancel)". Dispatch on live session state instead of swapping onEscape
	 * handlers — interleaved start/end events used to clobber the single saved-handler slot (auto-compaction start →
	 * /compact → auto end → manual finally), leaving Esc wired to a stale no-op closure until restart.
	 *
	 * While an agent is focused, Esc honors the advertised view action ("Esc returns to main") instead of cancelling
	 * maintenance — accidentally killing a focused agent's compaction on the way out was #2819. The auto-maintenance
	 * loaders relabel their hint to match (see EventController). Main-session maintenance still owns Esc and stays
	 * cancellable from the main view (focused submit gates /compact and handoff, so manual maintenance is main-only
	 * anyway).
	 */
	#handleEscape(): void {
		if (this.#escapeOverlay()) return;
		if (vocalizer.isSpeaking()) {
			// Playback from the completed response can overlap the next agent
			// turn. Silence it before interrupting any ongoing main-turn work.
			vocalizer.clear();
			this.ctx.lastEscapeTime = 0;
			return;
		}
		if (this.ctx.loopModeEnabled) {
			this.#escapeLoopMode();
			return;
		}
		if (this.ctx.focusedAgentId) {
			this.#escapeFocusedView();
			return;
		}
		const guest = this.ctx.collabGuest;
		if (guest) {
			// The local replica session never streams, so the native abort path below would stop nothing.
			if (guest.state?.isStreaming || this.ctx.loadingAnimation) guest.sendAbort();
			return;
		}
		if (this.#stopForegroundWork()) return;
		if (this.ctx.editor.getText().trim()) this.#escapeDraft();
		else this.#runDoubleEscapeAction();
	}

	/** Dismisses a side-channel panel, else aborts the main view's context maintenance; true when either ran. */
	#escapeOverlay(): boolean {
		if (this.ctx.hasActiveBtw() && this.ctx.handleBtwEscape()) return true;
		if (this.ctx.hasActiveOmfg() && this.ctx.handleOmfgEscape()) return true;
		return !this.ctx.focusedAgentId && this.#abortViewMaintenance();
	}

	/** Aborts the view session's compaction, handoff generation and retry backoff; true when any of them ran. */
	#abortViewMaintenance(): boolean {
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
		return aborted;
	}

	/** Pauses loop mode and stops its turn: the streaming turn, else the submission waiting to start. */
	#escapeLoopMode(): void {
		this.ctx.pauseLoop();
		if (this.ctx.session.isStreaming) {
			this.#abortStreamingTurn();
		} else {
			this.ctx.cancelPendingSubmission();
		}
	}

	/**
	 * Clears typed text, else returns the view to the main session. Esc never interrupts the focused agent's turn
	 * (an empty steer-flush submit does), and the double-Esc backtrack (/tree, /branch) stays main-only.
	 */
	#escapeFocusedView(): void {
		if (this.ctx.editor.getText().trim()) {
			this.ctx.editor.setText("");
			this.ctx.ui.requestRender();
		} else {
			void this.ctx.unfocusSession();
		}
	}

	/**
	 * Stops the first foreground work that is running: a pending or queued submission, a bash command, an eval, or the
	 * streaming turn; an idle bash or python mode is left instead. False when there is none.
	 */
	#stopForegroundWork(): boolean {
		const { ctx } = this;
		if (ctx.loadingAnimation) {
			if (!ctx.cancelPendingSubmission()) this.restoreQueuedMessagesToEditor({ abort: true });
		} else if (ctx.session.isBashRunning) {
			ctx.session.abortBash();
		} else if (ctx.isBashMode) {
			ctx.editor.setText("");
			ctx.isBashMode = false;
			ctx.updateEditorBorderColor();
		} else if (ctx.session.isEvalRunning) {
			ctx.session.abortEval();
		} else if (ctx.isPythonMode) {
			ctx.editor.setText("");
			ctx.isPythonMode = false;
			ctx.updateEditorBorderColor();
		} else if (ctx.session.isStreaming) {
			this.#abortStreamingTurn();
		} else {
			return false;
		}
		return true;
	}

	/**
	 * One Esc must not destroy an in-progress draft, so the second one inside the window is what discards it — and
	 * `discardDraft` leaves it on the undo stack, so ctrl+z brings it back. The arming state is not `lastEscapeTime`:
	 * arming here, clearing the draft by hand, then pressing Esc again must not fall through to `doubleEscapeAction`
	 * as if the composer had been empty all along.
	 */
	#escapeDraft(): void {
		const now = Date.now();
		if (now - this.#draftDiscardArmedAt < DOUBLE_ESCAPE_WINDOW_MS) {
			this.ctx.editor.discardDraft();
			this.#draftDiscardArmedAt = 0;
		} else {
			this.#draftDiscardArmedAt = now;
		}
		this.ctx.lastEscapeTime = 0;
	}

	/** A second Esc on an empty composer inside the window opens /tree or /branch, as `doubleEscapeAction` sets. */
	#runDoubleEscapeAction(): void {
		this.#draftDiscardArmedAt = 0;
		const action = settings.get("doubleEscapeAction");
		if (action === "none") return;
		const now = Date.now();
		if (now - this.ctx.lastEscapeTime < DOUBLE_ESCAPE_WINDOW_MS) {
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

	/**
	 * Installs the empty-composer key listeners once: ← in a focused agent view, b and c on a side-channel answer, and ↓
	 * on an active or paused goal. Each consumes its key only in that state, so ordinary editing keeps every key.
	 */
	#installComposerKeyListeners(): void {
		if (this.#composerKeyListenersInstalled) return;
		this.#composerKeyListenersInstalled = true;
		this.ctx.ui.addInputListener(data => {
			if (!this.ctx.focusedAgentId) return undefined;
			if (!matchesKey(data, "left")) return undefined;
			if (this.ctx.editor.getText().trim()) return undefined;
			this.#handleFocusedLeftTap();
			return { consume: true };
		});
		this.#addEmptyComposerKeyListener(
			"b",
			() => this.ctx.canBranchBtw(),
			() => this.ctx.handleBtwBranchKey(),
		);
		this.#addEmptyComposerKeyListener(
			"c",
			() => this.ctx.canCopyBtw(),
			() => this.ctx.handleBtwCopyKey(),
		);
		this.#addEmptyComposerKeyListener(
			"down",
			() => this.ctx.goalModeEnabled || this.ctx.goalModePaused,
			() => this.ctx.openGoalDetail(),
		);
	}

	setupKeyHandlers(): void {
		if (typeof this.ctx.editor.applyKeybindings === "function") {
			this.ctx.editor.applyKeybindings(this.ctx.keybindings);
		} else if (typeof this.ctx.editor.setActionKeys === "function") {
			for (const action of CONFIGURABLE_EDITOR_ACTIONS) {
				this.ctx.editor.setActionKeys(action, this.ctx.keybindings.getKeys(action));
			}
		}
		this.#installComposerKeyListeners();
		this.ctx.editor.onEscape = () => this.#handleEscape();

		this.ctx.editor.onClear = () => this.handleCtrlC();
		this.ctx.editor.onDisplayReset = () => this.ctx.ui.resetDisplay();
		this.ctx.editor.onExit = () => this.handleCtrlD();
		this.ctx.editor.onSuspend = () => this.handleCtrlZ();
		// Conditional: consumes the key only while a foreground command is
		// waiting; otherwise ctrl+b stays readline cursor-left.
		this.ctx.editor.onBashBackground = () => requestManualBackground();
		this.ctx.editor.onCycleThinkingLevel = () => this.cycleThinkingLevel();
		this.ctx.editor.onCycleModelForward = () => this.cycleRoleModel("forward");
		this.ctx.editor.onCycleModelBackward = () => this.cycleRoleModel("backward");
		this.ctx.editor.onSelectModelTemporary = () => this.ctx.showModelSelector({ temporaryOnly: true });

		// Global debug handler on TUI (works regardless of focus)
		this.ctx.ui.onDebug = () => this.ctx.showDebugSelector();
		this.ctx.editor.onSelectModel = () => this.ctx.showModelSelector();
		this.ctx.editor.onHistorySearch = () => this.ctx.showHistorySearch();
		this.ctx.editor.onToggleThinking = () => this.ctx.toggleThinkingBlockVisibility();
		this.ctx.editor.onExternalEditor = () => void this.openExternalEditor();
		this.ctx.editor.onPasteImage = () => this.handleImagePaste();
		this.ctx.editor.onPasteImagePath = path => this.handleImagePathPaste(path);
		this.ctx.editor.onPasteTextRaw = () => void this.handleClipboardTextRawPaste();
		this.ctx.editor.onLargePaste = (text, lineCount) => this.handleLargePaste(text, lineCount);
		this.ctx.editor.onCopyPrompt = () => this.handleCopyPrompt();
		this.ctx.editor.onExpandTools = () => this.toggleToolOutputExpansion();
		this.ctx.editor.onDequeue = () => this.handleDequeue();
		this.ctx.editor.onRetry = () => void this.handleRetry();
		this.ctx.editor.clearCustomKeyHandlers();
		// Wire up extension shortcuts
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
		// Hold the space bar to push-to-talk: the editor recognizes the auto-repeat burst, tracks
		// the spam back out, and toggles STT on hold start / release. Gated on `stt.enabled` so a
		// disabled STT leaves the space bar typing normally.
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

		// Double-tap left arrow on an empty editor: opens the agent dashboard
		// from the main session, or returns the focused agent view to the main
		// session. Focused ←← intentionally matches Esc. From the main session the
		// gesture stays inert when there are no agents (requireContent); the
		// explicit hub key still opens the empty roster. The card closes with Esc or
		// the same key that opened it, so the gesture needs no close-tap handoff:
		// inside the card the arrows switch views.
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
			const c0 = text.charCodeAt(0);
			const trimmed = c0 >= 33 && c0 <= 126 ? text : text.trimStart();
			this.ctx.isBashMode = trimmed.startsWith("!");
			this.ctx.isPythonMode = trimmed.startsWith("$") && parsePythonCommandInput(trimmed) !== undefined;
			if (wasBashMode !== this.ctx.isBashMode || wasPythonMode !== this.ctx.isPythonMode) {
				this.ctx.updateEditorBorderColor();
			}
			this.ctx.refreshComposerShortcuts();
			// The first real keystroke ends the hero moment (UI-10).
			if (text.length > 0) this.ctx.dismissWelcome();
		};
	}

	#handleFocusedLeftTap(): void {
		if (this.#detectLeftDoubleTap()) {
			void this.ctx.unfocusSession();
		}
	}

	/**
	 * Detect a deliberate double-← gesture, rejecting terminal-synthesized arrow
	 * bursts. Returns true only on the *second* tap of a fresh sequence when it
	 * lands a human-plausible interval after the first
	 * (`[LEFT_DOUBLE_TAP_MIN_GAP_MS, AGENT_VIEW_LEFT_TAP_WINDOW_MS)`). Taps closer
	 * than the lower bound, or any third-and-later tap before a quiet gap, are a
	 * burst and never fire — so a stray click that makes the terminal emit a run
	 * of ← keys can no longer pop the agent dashboard.
	 */
	#detectLeftDoubleTap(): boolean {
		const now = Date.now();
		const sinceLast = now - this.ctx.lastLeftTapTime;
		this.ctx.lastLeftTapTime = now;
		if (sinceLast >= AGENT_VIEW_LEFT_TAP_WINDOW_MS) {
			// Quiet gap: this tap starts a fresh sequence.
			this.#leftTapCount = 1;
			return false;
		}
		this.#leftTapCount += 1;
		if (this.#leftTapCount === 2 && sinceLast >= LEFT_DOUBLE_TAP_MIN_GAP_MS) {
			// Exactly two taps, the second a human-plausible interval after the first.
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
			// The mode set is the terminal's to write, and only after DECRQM confirms
			// it: a blind `CSI ? 5522 h` is a logged parse error on kitty, which is the
			// terminal the enhanced-paste spec was written for. A Terminal with no
			// capability probe never confirms and so never arms.
			requestMode: () => this.ctx.ui.terminal.requestEnhancedPaste?.(),
			pasteText: text => {
				// Route enhanced-paste text to the currently focused component when it
				// exposes a `pasteText` hook (modal Input prompts: OAuth API-key entry,
				// Perplexity OTP, GitHub Enterprise URL, manual redirect URL). Falling
				// back to the main editor would have buried the text in the detached
				// editor while the modal Input had focus (#2127).
				const focused = this.ctx.ui.getFocused();
				const target = focused && focused !== this.ctx.editor && hasPasteText(focused) ? focused : this.ctx.editor;
				target.pasteText(text);
				this.ctx.ui.requestRender();
			},
			pasteImage: async image => {
				// Images can only land in the main editor — when a modal Input is
				// focused, refuse rather than dump the binary blob in a hidden buffer.
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
			await this.submit(text);
		};
	}

	drainEarlySubmissions(): void {
		const earlySubmissions = this.ctx.editor.takeEarlySubmissions();
		const earlyActions = this.ctx.editor.takeEarlyActions();
		if (earlySubmissions.length === 0 && earlyActions.length === 0) return;

		for (const early of earlySubmissions) {
			void this.ctx.editor
				.withPreservedDraft(() =>
					this.submit(early.text, {
						images: early.images,
						imageLinks: early.imageLinks,
					}),
				)
				.catch(error => this.ctx.showError(errorMessage(error)));
		}

		for (const action of earlyActions) {
			this.#executeDeferredAction(action);
		}
	}

	#executeDeferredAction(action: DeferredEditorAction): void {
		switch (action) {
			case "app.model.select":
				if (this.ctx.editor.onSelectModel) {
					this.ctx.editor.onSelectModel();
				} else {
					this.ctx.showModelSelector();
				}
				break;
			case "app.model.selectTemporary":
				if (this.ctx.editor.onSelectModelTemporary) {
					this.ctx.editor.onSelectModelTemporary();
				} else {
					this.ctx.showModelSelector({ temporaryOnly: true });
				}
				break;
		}
	}

	async submit(
		text: string,
		options?: {
			images?: ImageContent[];
			imageLinks?: (string | undefined)[];
		},
	): Promise<void> {
		// Chat idiom: submitting snaps a scrolled-up transcript back to the
		// live tail — the operator just engaged with the present.
		this.ctx.ui.scrollToLiveTail();
		text = preparedSubmitText(text);
		const { images, imageLinks } = options ?? this.#pendingDraftImages();
		// Focused agent session: the editor is a plain chat box for it.
		// Everything below (continue shortcuts, slash/bash/python, loop,
		// compaction queueing) is main-session-only.
		if (this.ctx.focusedAgentId) {
			await this.#submitToFocusedSession(text, "steer");
			return;
		}

		if (!text && !images?.length) {
			await this.#abortForQueuedMessages(this.ctx.session);
			return;
		}

		// Continue shortcuts: "." or "c" resume the agent with a hidden agent-authored
		// developer directive (no visible user message) instead of an empty turn, so the
		// model continues the prior intent rather than second-guessing the interrupt.
		if (text === "." || text === "c") {
			this.#continueTurn();
			return;
		}

		const input = await this.#applyInputHandlers({ text, images, imageLinks });
		if (!input || (!input.text && (input.images?.length ?? 0) === 0)) return;

		const queueBody = parseQueueShorthand(input.text);
		if (queueBody !== undefined) {
			await this.#queueForYield(queueBody, {
				historyText: input.text,
				images: input.images,
				imageLinks: input.imageLinks,
			});
			return;
		}

		const rewritten = await this.#consumeBuiltinSlashCommand(input.text);
		if (rewritten === undefined) return;
		input.text = rewritten;

		// Collab guest: prompts execute on the host; local slash/skill/bash/
		// python execution is host-only (builtins are gated inside
		// dispatchBuiltinSlashCommand, which already consumed allowed ones).
		if (this.ctx.collabGuest) {
			this.#submitAsCollabGuest(this.ctx.collabGuest, input.text, input.images);
			return;
		}

		await this.#submitToMainSession(input);
	}

	/**
	 * Empty submit: while `session` streams with queued messages, abort its active turn and let the
	 * post-unwind drain deliver the agent-core queue.
	 */
	async #abortForQueuedMessages(session: AgentSession): Promise<void> {
		if (!session.isStreaming || session.queuedMessageCount === 0) return;
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.ui.requestRender();
	}

	#continueTurn(): void {
		if (!this.ctx.onInputCallback) return;
		this.ctx.editor.clearDraft();
		this.ctx.onInputCallback({
			text: turnControlPrompts["turn-control/manual-continue"].text,
			cancelled: false,
			started: true,
			synthetic: true,
			userInitiated: true,
		});
	}

	/** Run extension input handlers; undefined when one handled the input, else the (possibly rewritten) input. */
	async #applyInputHandlers(input: SubmittedInput): Promise<SubmittedInput | undefined> {
		const runner = this.ctx.session.extensionRunner;
		if (!runner?.hasHandlers("input")) return input;
		const result = await runner.emitInput(input.text, input.images, "interactive");
		if (result?.handled) {
			this.ctx.editor.clearDraft();
			return undefined;
		}
		if (result?.text !== undefined) {
			input.text = normalizeSubmittedPrompt(result.text);
		}
		if (result?.images !== undefined) {
			input.images = result.images;
			input.imageLinks = await materializeImageReferenceLinks(
				result.images,
				this.ctx.sessionManager.putBlob.bind(this.ctx.sessionManager),
			);
		}
		return input;
	}

	#submitAsCollabGuest(guest: CollabGuestLink, text: string, images: ImageContent[] | undefined): void {
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
		if (guest.readOnly) {
			// Keep the typed text: the prompt was not consumed.
			this.ctx.showStatus("This collab link is read-only — prompting is disabled");
			return;
		}
		const sentImages = nonEmptyCopy(images);
		this.ctx.editor.clearDraft(text);
		// No local render: the prompt comes back from the host as a
		// collab-prompt event/entry and renders with the author badge.
		guest.sendPrompt(text, sentImages);
	}

	/** Route a main-session submission: skill, bash, python, compaction queue, streaming steer or a new turn. */
	async #submitToMainSession({ text, images, imageLinks }: SubmittedInput): Promise<void> {
		// Handle skill commands (/skill:name [args]). Enter ⇒ steer (matches the
		// free-text Enter semantics below); Ctrl+Enter routes through `handleFollowUp`.
		// During compaction, queue immediately so bash/python/loop-mode branches do
		// not consume the skill before the compaction-resume path re-parses it.
		if (text && isKnownSkillCommand(this.ctx, text)) {
			if (this.ctx.session.isCompacting) {
				this.ctx.queueCompactionMessage(text, "steer", nonEmptyCopy(images));
				return;
			}
			if (await this.#invokeSkillCommand(text, "steer", images, imageLinks)) {
				return;
			}
		}

		if (await this.#runShellShortcut(text)) return;

		// While loop mode is on, every user-typed prompt becomes the new loop
		// prompt that auto-resubmits after each yield.
		if (this.ctx.loopModeEnabled) {
			this.ctx.loopPrompt = text;
		}

		// Queue input during compaction
		if (this.ctx.session.isCompacting) {
			this.ctx.queueCompactionMessage(text, "steer", nonEmptyCopy(images));
			return;
		}

		// If streaming, use prompt() with steer behavior
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.ctx.session.isStreaming) {
			this.ctx.editor.addToHistory(text);
			this.ctx.editor.setText("");
			await this.#promptSteer(text, images, imageLinks);
			return;
		}

		// Normal message submission
		// First, move any pending bash components to chat
		this.ctx.flushPendingBashComponents();
		this.#autoTitle(text);

		if (this.ctx.onInputCallback) {
			// Include any pending images from clipboard paste
			this.#clearEditorImages();
			// Render user message immediately, then let session events catch up.
			// Tag the submission as "steer": this is a normal Enter the controller
			// believed was idle, but a background turn can start in the gap before
			// `submitInteractiveInput` dispatches it. Steering matches the
			// streaming-branch Enter (above) and keeps the message from throwing
			// AgentBusyError on that race.
			const submission = this.ctx.startPendingSubmission({
				text,
				images: nonEmptyCopy(images),
				imageLinks,
				streamingBehavior: "steer",
			});
			this.ctx.onInputCallback(submission);
		} else {
			// No input waiter: the main loop is between turns (post-turn
			// epilogue, retry backoff, or a scheduled continue) with the agent
			// momentarily idle. The editor already cleared itself on Enter, so
			// falling through here would silently swallow the message. Submit a
			// real prompt directly; if a background turn starts in the gap,
			// `streamingBehavior: "steer"` preserves the typed-message queueing
			// semantics instead of throwing AgentBusyError.
			await this.#promptSteer(text, images, imageLinks);
		}
		this.ctx.editor.addToHistory(text);
	}

	/**
	 * Run `!`/`!!` bash and `$`/`$$` python input; false when `text` is neither or carries no command.
	 * Shell-style variables such as `$HOME` are normal prose unless a space follows the sigil.
	 */
	async #runShellShortcut(text: string): Promise<boolean> {
		if (text.startsWith("!")) {
			const isExcluded = text.startsWith("!!");
			const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
			if (command) {
				if (this.ctx.session.isBashRunning) {
					this.ctx.showWarning("A bash command is already running. Press Esc to cancel it first.");
					this.ctx.editor.setText(text);
					return true;
				}
				this.ctx.editor.addToHistory(text);
				await this.ctx.handleBashCommand(command, isExcluded);
				this.ctx.isBashMode = false;
				this.ctx.updateEditorBorderColor();
				return true;
			}
		}
		const pythonCommand = parsePythonCommandInput(text);
		if (!pythonCommand?.code) return false;
		if (this.ctx.session.isEvalRunning) {
			this.ctx.showWarning("A Python execution is already running. Press Esc to cancel it first.");
			this.ctx.editor.setText(text);
			return true;
		}
		this.ctx.editor.addToHistory(text);
		await this.ctx.handlePythonCommand(pythonCommand.code, pythonCommand.isExcluded);
		this.ctx.isPythonMode = false;
		this.ctx.updateEditorBorderColor();
		return true;
	}

	#clearEditorImages(): void {
		this.ctx.editor.imageLinks = undefined;
		this.ctx.editor.pendingImages = [];
		this.ctx.editor.pendingImageLinks = [];
	}

	/** Puts a submission that did not go out back in the editor: its text, and its images with their links. */
	#restoreDraft(
		text: string,
		images: readonly ImageContent[] | undefined,
		imageLinks: readonly (string | undefined)[] | undefined,
	): void {
		this.ctx.editor.setText(text);
		if (!images) return;
		this.ctx.editor.pendingImages = [...images];
		this.ctx.editor.pendingImageLinks = imageLinks ? [...imageLinks] : images.map(() => undefined);
		this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
	}

	/** Copies of the editor's pending images and their links; links are undefined without images. */
	#pendingDraftImages(): Pick<SubmittedInput, "images" | "imageLinks"> {
		const images = nonEmptyCopy(this.ctx.editor.pendingImages);
		return { images, imageLinks: images && nonEmptyCopy(this.ctx.editor.pendingImageLinks) };
	}

	/**
	 * Prompts `session` as a local submission. A dispatch that fails (model or API-key validation, a queue
	 * rejection) puts the text and images back in the editor, so an image-only or text and image draft can be
	 * retried, and shows the error.
	 */
	async #promptLocally(
		session: AgentSession,
		{ text, images, imageLinks }: SubmittedInput,
		streamingBehavior: "steer" | "followUp" | undefined,
	): Promise<void> {
		try {
			await this.ctx.withLocalSubmission(text, () => session.prompt(text, { streamingBehavior, images }), {
				imageCount: images?.length ?? 0,
			});
		} catch (error) {
			this.#restoreDraft(text, images, imageLinks);
			this.ctx.showError(errorMessage(error));
		}
	}

	/**
	 * Prompt the session with steer behavior, clearing the editor's images first. The local-submission
	 * signature lets the queued message's eventual delivery (a user-role `message_start` event) leave a
	 * draft typed since intact (#783). A failed dispatch hands the text and images back to an empty editor
	 * so they can be retried.
	 */
	async #promptSteer(
		text: string,
		inputImages: ImageContent[] | undefined,
		imageLinks: (string | undefined)[] | undefined,
	): Promise<void> {
		this.#clearEditorImages();
		const images = nonEmptyCopy(inputImages);
		try {
			await this.ctx.withLocalSubmission(
				text,
				() => this.ctx.session.prompt(text, { streamingBehavior: "steer", images }),
				{ imageCount: images?.length ?? 0 },
			);
		} catch (error) {
			// A draft typed since the dispatch stays; only an empty editor takes the submission back.
			if (!this.ctx.editor.getText()) this.#restoreDraft(text, images, imageLinks);
			this.ctx.showError(errorMessage(error));
		}
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.ui.requestRender();
	}

	/**
	 * Auto-generate a session title while the session is still unnamed. Greetings,
	 * acknowledgements and empty input carry no task, so they are skipped
	 * deterministically (no model invoked, no download-progress UI) and the session
	 * stays unnamed — the next user message gets a fresh chance, so titling defers
	 * past "hi" instead of latching onto it.
	 */
	#autoTitle(text: string): void {
		if (this.ctx.sessionManager.getSessionName() || autoTitleDisabled() || isLowSignalTitleInput(text)) return;
		showTinyTitleDownloadRow(this.ctx, this.ctx.settings.get("providers.tinyModel"));
		generateSessionTitle(
			text,
			this.ctx.session.modelRegistry,
			this.ctx.settings,
			this.ctx.session.sessionId,
			this.ctx.session.model,
			provider => this.ctx.session.agent.metadataForProvider(provider),
			this.ctx.session.titleSystemPrompt,
			providerText => this.ctx.session.obfuscateProviderText(providerText),
			this.ctx.session.sideComplete,
		)
			.then(async title => {
				// Re-check: a concurrent attempt for an earlier message may have
				// already named the session. Don't clobber it. Terminal title and
				// accent updates fire from the onSessionNameChanged listener.
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

	/** Submit editor text to the focused agent session (chat-only focus policy). */
	async #submitToFocusedSession(text: string, streamingBehavior: "steer" | "followUp"): Promise<void> {
		const target = this.ctx.viewSession;
		const { images, imageLinks } = this.#pendingDraftImages();
		if (!text && !images) {
			await this.#abortForQueuedMessages(target);
			return;
		}
		if (text && (text.startsWith("/") || text.startsWith("!") || parsePythonCommandInput(text))) {
			this.ctx.showStatus("Commands run in the main session — press ←← to return first");
			return; // editor text not cleared: Editor does not auto-clear on submit
		}
		this.ctx.editor.clearDraft(text);
		// prompt() handles idle (new turn) and streaming (queues per streamingBehavior).
		await this.#promptLocally(target, { text, images, imageLinks }, streamingBehavior);
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.ui.requestRender();
	}

	handleCtrlC(): void {
		// Sync-flush the session JSONL so in-flight writes survive a hard exit.
		// The TUI consumes Ctrl+C as a key event in raw mode, so postmortem's
		// process-level SIGINT handler never fires. shutdown() awaits its own
		// async flush — this sync pass is a superset that also covers the
		// first-press case and the hard-abort path below.
		try {
			this.ctx.sessionManager.flushSync();
		} catch (err) {
			logger.warn("session-manager sync flush on Ctrl+C failed", {
				error: errorMessage(err),
			});
		}

		// Hard-abort: a Ctrl+C arriving while shutdown() is already running
		// means the user has waited long enough for whatever teardown step is
		// stuck (typically an extension's session_shutdown handler hanging on
		// IPC). The 2s session_shutdown cap (see runner.ts) already bounds the
		// common case; this is the defense-in-depth ladder for everything
		// else. See issue #2600.
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
		// Editor text (if any) is snapshotted at the start of shutdown() and
		// persisted as a draft for the next resume. Empty text is also fine —
		// shutdown clears any stale sidecar in that case.
		void this.ctx.shutdown();
	}

	handleCtrlZ(): void {
		// Job-control suspend is POSIX-only: on Windows `process.kill(_, "SIGSTOP")`
		// throws `TypeError: Unknown signal: SIGSTOP` and takes the whole agent down
		// via an uncaught exception (issue #2036, originally for SIGTSTP — same
		// shape for SIGSTOP). No-op on platforms that cannot suspend.
		if (process.platform === "win32") {
			this.ctx.showStatus("Suspend (Ctrl+Z) is not supported on this platform");
			return;
		}

		// Capture the listener so we can detach it if the signal never fires;
		// otherwise a failed suspend would leave a stale SIGCONT handler that
		// fires on the next unrelated continue and tries to re-`start()` an
		// already-running TUI.
		const onResume = (): void => {
			this.ctx.ui.start();
			this.ctx.ui.requestRender(true);
		};
		process.once("SIGCONT", onResume);

		// Stop the TUI (restore terminal to normal mode) before sending the
		// signal so the parent shell sees a sane terminal state.
		this.ctx.ui.stop();

		try {
			// SIGSTOP — not SIGTSTP — to the foreground process group (pid=0).
			//
			// SIGTSTP: brush-core (the embedded shell behind every bash tool call)
			// installs a tokio SIGTSTP listener on `Process::wait` to detect when
			// its children have been stopped (`natives/vendor/brush-core/src/sys/
			// unix/signal.rs::tstp_signal_listener` → `tokio::signal::unix::
			// signal(SIGTSTP)`). Per tokio's documented contract, the first call
			// for a given SignalKind permanently replaces the kernel-default
			// handler for the lifetime of the process. So once the user has
			// issued even one bash command — e.g. `/usr/bin/true` — SIGTSTP no
			// longer stops veyyon: tokio swallows it and the TUI ends up torn down
			// while the process keeps running with no live terminal (issue
			// [#3461]). SIGSTOP cannot be caught, blocked, or ignored, so the
			// kernel stops the process regardless of installed handlers.
			//
			// pid=0 (foreground process group, not just our PID): veyyon is not
			// always the shell's direct child. Package-manager launchers (`npx`,
			// `pnpm exec`, `bunx`, …) wait on the real CLI from a parent shim
			// that shares veyyon's process group, and a `veyyon … | tee log` style
			// pipeline puts a sibling foreground job member in the same group
			// too. The shell sees the job as stopped only when its direct
			// child / pipeline leader is stopped, so suspending only our PID
			// leaves wrappers and pipeline peers running and the terminal
			// hung — exactly the failure shape we're fixing. Stopping the whole
			// group keeps the shell's job-control view consistent. Long-lived
			// children that must survive the suspend (Linux/other POSIX MCP stdio
			// servers via the platform-specific `detached: true` spawn in
			// `mcp/transports/stdio.ts`, every brush external command via brush's
			// per-child `setsid` in `natives/vendor/brush-core/src/commands.rs`) are
			// their own sessions, so pgid=0 does not reach them.
			process.kill(0, "SIGSTOP");
		} catch (err) {
			// The runtime refused the signal (e.g. seccomp filter blocks SIGSTOP
			// delivery to the process group). Tear the resume hook down and
			// bring the TUI back so the user is not stranded on a frozen prompt.
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

	/**
	 * Dispatch a `/skill:<name> [args]` invocation through `promptCustomMessage`
	 * using the supplied `streamingBehavior`. Returns false when the text is not
	 * a registered skill command and leaves the editor state untouched. Registered
	 * skills consume the full composer draft (text plus pending images) before
	 * dispatch; if dispatch rejects, the draft is restored so the user can retry.
	 */
	async #invokeSkillCommand(
		text: string,
		streamingBehavior: "steer" | "followUp",
		images?: ImageContent[],
		imageLinks?: (string | undefined)[],
	): Promise<boolean> {
		if (!isKnownSkillCommand(this.ctx, text)) return false;
		const draftImages = nonEmptyCopy(images);
		const draftImageLinks = draftImages && nonEmptyCopy(imageLinks);

		this.ctx.editor.clearDraft(text);
		try {
			const handled = await invokeSkillCommandFromText(this.ctx, text, streamingBehavior, {
				images: draftImages,
				propagateErrors: true,
			});
			if (!handled) {
				this.#restoreDraft(text, draftImages, draftImageLinks);
				return false;
			}
			return true;
		} catch (error) {
			this.#restoreDraft(text, draftImages, draftImageLinks);
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

	/** Queue `/queue` input behind an active turn, or start it immediately when idle. */
	async handleQueueCommand(text: string): Promise<void> {
		await this.#queueForYield(text, this.#pendingDraftImages());
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
		// Enter empties the composer before the submission arrives, so a batch it sent is handed back as
		// the `=>` queue it was; Ctrl+Enter leaves the line in place, and that line is handed back as typed.
		const draft = this.ctx.editor.getText() || (splitMessages.length > 0 ? requeuedDraft(splitMessages) : "");
		const images = nonEmptyCopy(options.images);
		const imageLinks = options.imageLinks ? [...options.imageLinks] : images?.map(() => undefined);
		this.ctx.editor.clearDraft(options.historyText);

		if (this.ctx.session.isCompacting) {
			this.#queueForCompaction(messages, images);
			return;
		}

		const startImmediately = !this.ctx.session.isStreaming && this.ctx.session.queuedMessageCount === 0;
		const sent = await this.#sendQueued({ messages, images, imageLinks, draft, startImmediately });
		this.ctx.updatePendingMessagesDisplay();
		if (sent === messages.length) this.ctx.showStatus(queuedStatus(sent, startImmediately));
		this.ctx.ui.requestRender();
	}

	/** Queues `messages` to send once compaction ends, the images riding on the first. */
	#queueForCompaction(messages: readonly string[], images: ImageContent[] | undefined): void {
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
	}

	/**
	 * Sends a queued batch in order and returns how many messages went out. When the session was idle the first
	 * message starts a turn. A failure puts what did not go out back in the editor: the batch's draft with its
	 * images when nothing went out, else the rest as an `=>` queue.
	 */
	async #sendQueued({ messages, images, imageLinks, draft, startImmediately }: QueuedBatch): Promise<number> {
		let sent = 0;
		try {
			if (startImmediately && this.ctx.onInputCallback) {
				const submission = this.ctx.startPendingSubmission({
					text: messages[0] ?? "",
					images,
					imageLinks,
					streamingBehavior: "followUp",
				});
				this.ctx.onInputCallback(submission);
				sent = 1;
			}
			for (; sent < messages.length; sent++) {
				const message = messages[sent] ?? "";
				const sentImages = sent === 0 ? images : undefined;
				const startsTurn = startImmediately && sent === 0;
				await this.ctx.withLocalSubmission(
					message,
					async () => {
						if (startsTurn)
							await this.ctx.session.prompt(message, { images: sentImages, streamingBehavior: "followUp" });
						else await this.ctx.session.followUp(message, sentImages);
					},
					{ imageCount: sentImages?.length ?? 0 },
				);
			}
		} catch (error) {
			if (sent === 0) this.#restoreDraft(draft, images, imageLinks);
			else this.ctx.editor.setText(requeuedDraft(messages.slice(sent)));
			this.ctx.showError(errorMessage(error));
		}
		return sent;
	}

	/**
	 * Runs a builtin slash command in `text`. Returns `undefined` when the command consumed the
	 * submission, else the text to send as the prompt: the remainder a command such as `/loop 10
	 * fix bug` hands back, or `text` untouched when it is not a builtin. Either way the line as
	 * typed is what Up Arrow recalls, unless it is a sensitive command.
	 */
	async #consumeBuiltinSlashCommand(text: string): Promise<string | undefined> {
		if (!text) return text;
		const slashResult = await dispatchBuiltinSlashCommand(text, { ctx: this.ctx });
		if (slashResult === true) {
			if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
			return undefined;
		}
		if (typeof slashResult === "string") {
			if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
			return slashResult;
		}
		return text;
	}

	/** Send editor text as a follow-up message (queued behind current stream). */
	async handleFollowUp(): Promise<void> {
		let text = normalizeSubmittedPrompt(this.ctx.editor.getExpandedText());
		const { images, imageLinks } = this.#pendingDraftImages();
		if (!text && !images) return;

		// Focused agent session: follow-ups go to it; non-chat input is gated.
		if (this.ctx.focusedAgentId) {
			await this.#submitToFocusedSession(text, "followUp");
			return;
		}

		// Compaction first: while compacting, free text gets queued via
		// `queueCompactionMessage`, and `/skill:*` rides the same queue so a
		// skill typed during compaction is not lost or short-circuited through
		// `promptCustomMessage`. The compaction-resume path re-parses the
		// queued text into a user-attributed skill invocation before delivery.
		if (this.ctx.session.isCompacting) {
			this.ctx.queueCompactionMessage(text, "followUp", images);
			return;
		}

		const rewritten = await this.#consumeBuiltinSlashCommand(text);
		if (rewritten === undefined) return;
		text = rewritten;

		// Skill commands invoke through the custom-message path regardless of
		// which keybinding submitted them. Enter routes them as `steer`;
		// Ctrl+Enter (this handler) routes them as `followUp`.
		if (text && (await this.#invokeSkillCommand(text, "followUp", images, imageLinks))) return;

		// Streaming: queue behind the current turn. Idle: submit normally.
		const streaming = this.ctx.session.isStreaming;
		this.ctx.editor.clearDraft(text);
		await this.#promptLocally(this.ctx.session, { text, images, imageLinks }, streaming ? "followUp" : undefined);
		if (!streaming) return;
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.ui.requestRender();
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		this.ctx.locallySubmittedUserSignatures.clear();
		// On Esc (abort) drop non-user internal steers so the post-abort drain can't
		// auto-resume; plain Alt+Up dequeue preserves them for the continuing stream.
		const { steering, followUp } = this.ctx.session.clearQueue({ forInterrupt: options?.abort });
		// Messages typed while compacting live in `compactionQueuedMessages`, not the
		// agent queue `clearQueue()` drains — but the pending bar shows the same
		// "Alt+Up to edit" hint for them (ui-helpers `updatePendingMessagesDisplay`).
		// Drain them here too so the dequeue restores every message the hint
		// advertises; otherwise a skill/text queued during compaction is stranded and
		// Alt+Up reports "No queued messages to restore".
		const compactionQueued = this.ctx.compactionQueuedMessages;
		this.ctx.compactionQueuedMessages = [];
		const allQueued = [
			...steering,
			...compactionQueued.filter(e => e.mode === "steer").map(e => ({ text: e.text, images: e.images })),
			...followUp,
			...compactionQueued.filter(e => e.mode === "followUp").map(e => ({ text: e.text, images: e.images })),
		];
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
		// Image markers are positional: `[Image #N]` ↔ `pendingImages[N-1]`. Each
		// queued message numbered its markers against its own local image list
		// (1..K). Because we prepend the queued text but append the queued images
		// to `pendingImages`, any existing draft images (M of them) — plus images
		// already pulled in by earlier queued messages — shift the slot index that
		// every marker must point to. Bumping each message's markers by the
		// running offset keeps the merged text aligned with the merged
		// `pendingImages` order; draft markers stay valid because draft images
		// keep their original positions.
		const queuedImages = allQueued.flatMap(e => e.images ?? []);
		let queuedText: string;
		if (queuedImages.length > 0) {
			const parts: string[] = [];
			let imageOffset = this.ctx.editor.pendingImages.length;
			for (const entry of allQueued) {
				parts.push(shiftImageMarkers(entry.text, imageOffset));
				if (entry.images && entry.images.length > 0) imageOffset += entry.images.length;
			}
			queuedText = parts.join("\n\n");
		} else {
			queuedText = allQueued.map(e => e.text).join("\n\n");
		}
		const currentText = options?.currentText ?? this.ctx.editor.getText();
		const combinedText = [queuedText, currentText].filter(t => t.trim()).join("\n\n");
		this.ctx.editor.setText(combinedText);
		// Hand queued images back to the pending-image buffer (links are
		// re-materialized lazily; the restored text already carries the
		// renumbered `[Image #N, WxH]` markers).
		if (queuedImages.length > 0) {
			this.ctx.editor.pendingImages.push(...queuedImages);
			this.ctx.editor.pendingImageLinks.push(...queuedImages.map(() => undefined));
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
		const dims = await imageDimensions(imageData);
		const label = dims ? `[Image #${imageNum}, ${dims.width}x${dims.height}]` : `[Image #${imageNum}]`;
		this.ctx.editor.insertText(`${label} `);
		this.ctx.ui.requestRender();
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
				// Keep the normalized image, but say so: the user enabled
				// autoResize and an unresized image can blow the token budget.
				logger.warn("image auto-resize failed; attaching the original unresized image", {
					mimeType: imageData.mimeType,
					error: errorMessage(error),
				});
			}
		}
		await this.#insertPendingImage(imageData);
		return true;
	}

	/**
	 * Win+Shift+S on Windows 11 leaves the screenshot bitmap on the clipboard
	 * while the terminal pastes a transient packaged-app TempState path
	 * (…\MicrosoftWindows.Client.Core_*\TempState\…) that is already gone — or
	 * never materialized — by the time we read it. Whenever a pasted image path
	 * can't be turned into an image locally, those clipboard bytes are the real
	 * payload, so prefer them before degrading to a text paste.
	 *
	 * Skipped over SSH: the clipboard read would hit the remote host, not the
	 * terminal that holds the screenshot. Returns true when the clipboard owned
	 * the outcome (image attached, or an unsupported-format status surfaced), so
	 * the caller stops without emitting its own degraded diagnostic.
	 */
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
			// False means "there was no image to paste", and the caller then treats the keypress as an
			// ordinary text paste. A clipboard with no image, and a clipboard we could not read, both leave
			// the user's paste working; raising here would break paste entirely on a headless clipboard.
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
			if (image) {
				await this.#normalizeAndInsertPastedImage(
					{ type: "image", data: image.data, mimeType: image.mimeType },
					`Unsupported pasted image format: ${image.mimeType}`,
				);
				return;
			}
			// Path resolved but is not a readable image (e.g. a zero-byte or
			// locked transient screenshot file). Prefer the clipboard bytes.
			if (!(await this.#tryPasteClipboardImage()))
				this.#pastePathAsText(path, "Pasted path is not a supported image");
		} catch (error) {
			await this.#recoverImagePathPaste(path, error);
		}
	}

	/** Answers a pasted image path that failed to load: too large, missing on this filesystem, or unreadable. */
	async #recoverImagePathPaste(path: string, error: unknown): Promise<void> {
		if (error instanceof ImageInputTooLargeError) {
			this.#pastePathAsText(path, error.message);
			return;
		}
		// #2375: the bracketed paste forwarded by a local terminal carries a path on the
		// *local* filesystem. The bytes may still be on the clipboard (Win+Shift+S), so
		// try those before giving up, for a missing path as for any other read failure.
		if (await this.#tryPasteClipboardImage()) return;
		if (isEnoent(error)) this.ctx.showStatus(missingImagePathStatus(path));
		else this.#pastePathAsText(path, "Failed to read pasted image path");
	}

	/** Pastes `path` into the editor as text and shows why it did not attach as an image. */
	#pastePathAsText(path: string, status: string): void {
		this.ctx.editor.pasteText(path);
		this.ctx.ui.requestRender();
		this.ctx.showStatus(status);
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
			// #3506: macOS Finder `Cmd+C` puts only a `public.file-url`
			// representation on the pasteboard. `pbpaste` (the backing call
			// for `readText` on Darwin) only surfaces plain text / RTF / EPS,
			// so it returns empty for file-url-only pasteboards — the smart
			// text fallback below would dead-end with "Clipboard is empty".
			// Reach the file URL directly via AppleScript and route every
			// image-shaped path through {@link handleImagePathPaste}, matching
			// the bracketed-paste handler in `CustomEditor.handleInput` which
			// iterates every extracted image path. Multi-image Finder
			// selections must not silently drop after the first attach.
			// `readMacFileUrls` returns an empty list off Darwin, so the
			// check is free on every other platform.
			const fileUrls = (await this.clipboard.readMacFileUrls?.()) ?? [];
			let attachedFromFileUrls = false;
			for (const url of fileUrls) {
				const candidate = extractImagePathFromText(url);
				if (!candidate) continue;
				await this.handleImagePathPaste(candidate);
				attachedFromFileUrls = true;
			}
			if (attachedFromFileUrls) return true;
			// Smart paste (#1628): no image on the clipboard — fall back to
			// pasting its text so the same chord covers both payload kinds.
			// Hosts that pre-empt the terminal's own paste (VS Code's
			// integrated terminal, Win+V clipboard history) deliver only
			// this keypress, so a miss here must not dead-end.
			const text = await this.clipboard.readText();
			if (!text) {
				this.ctx.showStatus("Clipboard is empty");
				return false;
			}
			// #3506: when the clipboard text is an explicit image file path,
			// route through {@link handleImagePathPaste} so the image is
			// loaded and attached instead of pasting the path as literal
			// text. Covers terminals that paste the Finder file path as
			// plain text rather than as a `public.file-url` (most macOS
			// terminals do this for image clipboards).
			const imagePath = extractImagePathFromText(text);
			if (imagePath) {
				await this.handleImagePathPaste(imagePath);
				return true;
			}
			// Route to the focused component when it accepts pastes (modal
			// Input prompts), matching the enhanced-paste text path (#2127).
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

	/**
	 * Editor `onLargePaste` hook: gate a marker-sized paste behind the large-paste menu. Returns
	 * `true` to intercept (the editor skips its default `[Paste]` marker) once the paste reaches the
	 * configured `paste.largeMenuThreshold` line count; otherwise `false` for default collapse-to-marker
	 * behavior. The async menu is fired and forgotten — the editor only needs the synchronous verdict.
	 */
	handleLargePaste(text: string, lineCount: number): boolean {
		const threshold = this.ctx.settings.get("paste.largeMenuThreshold");
		if (!(threshold > 0) || lineCount < threshold) return false;
		void this.presentLargePasteMenu(text, lineCount);
		return true;
	}

	/**
	 * Present the large-paste menu and apply the chosen action: wrap in `<attachment>` tags (collapsed
	 * to a `[Paste]` marker that expands on submit), save the text to a file and reference its path so
	 * the agent can `read` it on demand, or paste inline. Cancelling (Esc) falls back to the default
	 * inline paste marker, so the pasted content is never lost.
	 */
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
				// Esc / cancel: keep the original behavior — collapse to an inline paste marker.
				this.ctx.editor.insertPaste(text);
				break;
		}
		this.ctx.ui.requestRender();
	}

	/**
	 * Save a large paste to the session's `local://` store and insert a clean `local://attachment-N`
	 * reference into the editor so the agent can `read` it on demand — instead of inlining the text or
	 * leaking a raw temp path. Falls back to an inline paste marker when the write fails, so the
	 * content is never lost.
	 */
	async #attachPasteAsFile(text: string, lineCount: number): Promise<void> {
		try {
			// Mirror the exact mapping the read tool's local:// resolver uses so a later
			// `read local://attachment-N` lands on the file written here.
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

	/** Copy the current editor line to the system clipboard. */
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

	/** Copy current prompt text to system clipboard. */
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
			// The status line already reports the resolved model + thinking level, so
			// the cycle status is just a status-line-style chip track (active role
			// filled), matching the plan-approval model slider. It renders into its
			// own anchored container above the editor (cleared+rebuilt each cycle),
			// so it updates in place instead of stacking duplicates in the scrollback.
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
		// Remember it, the same way the thinking-block toggle does. Without this the
		// choice lasted only until the session ended, so a reader who wants the full
		// form of every tool call had to re-make it every time.
		this.ctx.settings.set("display.toolOutputExpanded", expanded);
		for (const child of this.ctx.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		// Toggling expansion mutates every block, but on ED3-risk terminals the
		// transcript freezes a snapshot of each block once it scrolls past the live
		// region (committed native scrollback is immutable there). A plain repaint
		// replays those stale snapshots, so the toggle appears to do nothing above
		// the live block. resetDisplay() invalidates the snapshots and forces a
		// full clear + replay — the keyboard-accessible resize-reset equivalent —
		// which is the only path that re-emits the whole transcript at its new
		// heights.
		this.ctx.ui.resetDisplay();
	}

	toggleThinkingBlockVisibility(): void {
		// When thinking is "off" and the session has not produced reasoning
		// content, thinking blocks stay auto-hidden; the toggle would only corrupt
		// the persisted preference. OpenAI-compatible servers can stream reasoning
		// without advertising model support, so observed thinking content unlocks
		// the display toggle.
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
			this.ctx.streamingComponent.updateContent(toAssistantMessageView(this.ctx.streamingMessage));
		}

		// Every block now carries the new flag, but on ED3-risk terminals the
		// blocks that scrolled past the live region are frozen snapshots in
		// committed scrollback — a plain repaint replays them stale, so scrolling
		// up still shows the old thinking expanded. resetDisplay() retires those
		// snapshots (it invalidates every block) and forces a full clear + replay
		// of the whole transcript, matching setToolsExpanded()'s redraw.
		this.ctx.ui.resetDisplay();

		this.ctx.showStatus(`Thinking blocks: ${this.ctx.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	async #openEditorTerminalHandle(): Promise<fs.FileHandle | null> {
		const terminalPath = getEditorTerminalPath();
		if (!terminalPath) {
			return null;
		}
		try {
			return await fs.open(terminalPath, "r+");
		} catch {
			// No controlling terminal to hand the external editor. Null is the documented "not available"
			// answer the caller already handles by falling back to the in-app editor, which is visible to
			// the user in a way a log line would not be.
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

/** Probe pixel dimensions for the marker label (`[Image #N, WxH]`). Returns undefined when the
 *  header can't be decoded, so the caller falls back to a bare `[Image #N]`. */
async function imageDimensions(image: ImageContent): Promise<{ width: number; height: number } | undefined> {
	try {
		const { width, height } = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
		if (width && height) return { width, height };
	} catch {
		// Unknown/corrupt header — fall back to a bare label.
	}
	return undefined;
}

function getEditorTerminalPath(): string | null {
	if (process.platform === "win32") {
		return null;
	}
	return "/dev/tty";
}
