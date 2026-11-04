import { ThinkingLevel } from "@veyyon/agent-core";
import type { ImageContent } from "@veyyon/ai";
import { errorMessage, logger, sanitizeText } from "@veyyon/utils";
import type { AutocompleteProvider, SlashCommand } from "@veyyon/utils/autocomplete";
import { type KeyId, matchesKey } from "@veyyon/utils/keys";
import { EXIT_INTERRUPTED } from "../../../cli/exit-codes";
// The slot leaf, not the 94-module store: this file reads values, it does not fill them.
import { settings } from "../../../config/settings-instance";
import { toAssistantMessageView } from "../../../presentation/transcript-builder";
import type { TuiSlashCommandHostContext } from "../../../slash-commands/types";
import { requestManualBackground } from "../../../tools/shell/bash-foreground-registry";
import {
	copyToClipboard,
	readImageFromClipboard,
	readMacFileUrlsFromClipboard,
	readTextFromClipboard,
} from "../../../utils/clipboard";
import { editInTerminal, getEditorCommand, NO_EDITOR_CONFIGURED } from "../../../utils/external-editor";
import { createPromptActionAutocompleteProvider } from "../autocomplete/prompt-action-autocomplete";
import { renderSegmentTrack } from "../components/chrome/segment-track";
import { CONFIGURABLE_EDITOR_ACTIONS, type DeferredEditorAction } from "../components/composer/custom-editor";
import { AGENT_VIEW_LEFT_TAP_WINDOW_MS } from "../components/dashboard/agent-view-timings";
import { AssistantMessageComponent } from "../components/transcript/assistant-message";
import type { SkillCommandHost } from "../skill-command";
import type { InteractiveModeContext } from "../types";
import { ComposerEscape } from "./composer-escape";
import { type ComposerClipboard, ComposerPaste } from "./composer-paste";
import { PromptSubmission, parsePythonCommandInput } from "./prompt-submission";
import { QueuedSubmissions } from "./queued-submissions";

interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
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
		| "noteComposerChanged"
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
	readonly #paste: ComposerPaste;
	readonly #queue: QueuedSubmissions;
	readonly #submission: PromptSubmission;
	readonly #escape: ComposerEscape;
	#composerKeyListenersInstalled = false;
	// Tap counter for the double-← gesture; reset whenever a quiet gap
	// (>= AGENT_VIEW_LEFT_TAP_WINDOW_MS) starts a fresh sequence. See
	// #detectLeftDoubleTap.
	#leftTapCount = 0;

	constructor(
		private ctx: InputControllerContext,
		/** Injectable clipboard reads so tests can drive paste flows without a real clipboard. */
		clipboard: ComposerClipboard = {
			readImage: readImageFromClipboard,
			readText: readTextFromClipboard,
			readMacFileUrls: readMacFileUrlsFromClipboard,
		},
	) {
		this.#paste = new ComposerPaste(ctx, clipboard);
		this.#queue = new QueuedSubmissions(ctx);
		this.#submission = new PromptSubmission(ctx, this.#queue);
		this.#escape = new ComposerEscape(ctx, this.#queue);
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
		this.ctx.editor.onEscape = () => this.#escape.handleEscape();

		this.ctx.editor.onClear = () => this.handleCtrlC();
		this.ctx.editor.onDisplayReset = () => this.ctx.ui.resetDisplay();
		this.ctx.editor.onExit = () => this.handleCtrlD();
		this.ctx.editor.onSuspend = () => this.handleCtrlZ();
		// Conditional: consumes the key only while a foreground command is
		// waiting; otherwise ctrl+b stays readline cursor-left.
		this.ctx.editor.onBashBackground = () => requestManualBackground();
		this.ctx.editor.onCycleThinkingLevel = () => this.cycleThinkingLevel();
		this.ctx.editor.onCycleModelForward = () => this.cycleModel("forward");
		this.ctx.editor.onCycleModelBackward = () => this.cycleModel("backward");
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

		this.#paste.installEnhancedPaste();

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
			this.ctx.noteComposerChanged();
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

	submit(
		text: string,
		options?: {
			images?: ImageContent[];
			imageLinks?: (string | undefined)[];
		},
	): Promise<void> {
		return this.#submission.submit(text, options);
	}

	/** Send editor text as a follow-up message (queued behind current stream). */
	handleFollowUp(): Promise<void> {
		return this.#submission.handleFollowUp();
	}

	handleRetry(): Promise<void> {
		return this.#submission.handleRetry();
	}

	/** Queue `/queue` input behind an active turn, or start it immediately when idle. */
	handleQueueCommand(text: string): Promise<void> {
		return this.#queue.handleQueueCommand(text);
	}

	handleDequeue(): void {
		this.#queue.handleDequeue();
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		return this.#queue.restoreToEditor(options);
	}

	handleImagePathPaste(path: string): Promise<void> {
		return this.#paste.handleImagePathPaste(path);
	}

	handleImagePaste(): Promise<boolean> {
		return this.#paste.handleImagePaste();
	}

	handleClipboardTextRawPaste(): Promise<void> {
		return this.#paste.handleClipboardTextRawPaste();
	}

	handleLargePaste(text: string, lineCount: number): boolean {
		return this.#paste.handleLargePaste(text, lineCount);
	}

	presentLargePasteMenu(text: string, lineCount: number): Promise<void> {
		return this.#paste.presentLargePasteMenu(text, lineCount);
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
			this.ctx.ui.holdFrameForInput();
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

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<void> {
		if (this.ctx.focusedAgentId) {
			this.ctx.showStatus("Model/thinking apply to the main session — press ←← to return first");
			return;
		}
		try {
			const result = await this.ctx.session.cycleModel(direction);
			if (!result) {
				this.ctx.showStatus("Only one model available");
				return;
			}
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			if (!result.isScoped) {
				this.ctx.showStatus(`Model: ${result.model.provider}/${result.model.id}`);
				return;
			}
			// A scoped cycle (`--models`) is a short list, so it renders as a chip
			// track with the active model filled, in its own anchored container
			// above the editor that is rebuilt each cycle instead of stacking.
			const scoped = this.ctx.session.scopedModels;
			const track = renderSegmentTrack(
				scoped.map(entry => ({ label: entry.model.id })),
				scoped.findIndex(
					entry => entry.model.provider === result.model.provider && entry.model.id === result.model.id,
				),
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
		// blocks already committed to native scrollback hold their old bytes —
		// a plain repaint leaves them stale, so scrolling up still shows the old
		// thinking expanded. resetDisplay() invalidates every block and forces a
		// full clear + replay of the whole transcript, matching
		// setToolsExpanded()'s redraw.
		this.ctx.ui.resetDisplay();

		this.ctx.showStatus(`Thinking blocks: ${this.ctx.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	async openExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning(NO_EDITOR_CONFIGURED);
			return;
		}

		const currentText = this.ctx.editor.getExpandedText?.() ?? this.ctx.editor.getText();
		try {
			const result = await editInTerminal(this.ctx.ui, editorCmd, currentText, { extension: ".veyyon.md" });
			if (result !== null) {
				this.ctx.editor.setText(result);
			}
		} catch (error) {
			this.ctx.showWarning(`Failed to open external editor: ${errorMessage(error)}`);
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
