import { errorMessage, logger } from "@veyyon/utils";
import type { InteractiveModeContext } from "../../modes/types";
import { isSensitiveSlashCommand } from "../../slash-commands/helpers/parse";
import type { TuiSlashCommandHostContext } from "../../slash-commands/types";
import type { SkillCommandHost } from "../skill-command";

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

export interface Expandable {
	setExpanded(expanded: boolean): void;
}

export function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

/** Minimal contract for any component that can receive a paste payload directly. */
export interface PasteTarget {
	pasteText(text: string): void;
}

export function hasPasteText(value: unknown): value is PasteTarget {
	return typeof value === "object" && value !== null && typeof (value as PasteTarget).pasteText === "function";
}

export const SHELL_PROMPT_COMMAND_RE =
	/^(?:\.{0,2}\/|~\/|cd(?:\s|$)|sudo(?:\s|$)|git(?:\s|$)|bun(?:\s|$)|npm(?:\s|$)|pnpm(?:\s|$)|yarn(?:\s|$)|node(?:\s|$)|python\d*(?:\s|$)|cargo(?:\s|$)|go(?:\s|$)|make(?:\s|$)|docker(?:\s|$)|kubectl(?:\s|$))/;
export const SHELL_PROMPT_OPERATOR_RE = /(?:^|\s)(?:&&|\|\||\||2>&1|[<>]{1,2})(?:\s|$)/;
export const VEYYON_STATUS_LINE_RE = /^\s*in:\s+\d+\s+out:\s+\d+(?:\s+cache\s+\S+)?\s+t:\s+\S+\s+tok\/s:\s+\S+/m;

export function looksLikePastedShellPrompt(code: string): boolean {
	const firstLine = code.split("\n", 1)[0]?.trimStart() ?? "";
	return (
		SHELL_PROMPT_COMMAND_RE.test(firstLine) ||
		SHELL_PROMPT_OPERATOR_RE.test(firstLine) ||
		VEYYON_STATUS_LINE_RE.test(code)
	);
}

export function pythonCommandPrefixLength(trimmedText: string): 0 | 1 | 2 {
	if (trimmedText.charCodeAt(0) !== 36 /* $ */) return 0;
	if (trimmedText.charCodeAt(1) === 123 /* { */) return 0;

	const prefixLength = trimmedText.charCodeAt(1) === 36 /* $ */ ? 2 : 1;
	const next = trimmedText.charCodeAt(prefixLength);
	if (Number.isNaN(next)) return prefixLength;
	return next === 32 || next === 9 || next === 10 || next === 13 ? prefixLength : 0;
}

export function parsePythonCommandInput(text: string): { code: string; isExcluded: boolean } | undefined {
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
export function wrapPasteInAttachmentBlock(content: string): string {
	return `<attachment>\n${content}\n</attachment>`;
}

/** Run a teardown abort that must never throw (Esc / Ctrl+C path). A thrown
 *  error is logged at debug instead of silently swallowed, so a failing abort
 *  stays diagnosable without disturbing teardown ordering. */
export function safeAbort(label: string, fn: () => void): void {
	try {
		fn();
	} catch (err) {
		logger.debug(`Failed to abort ${label}`, { error: errorMessage(err) });
	}
}

export const TINY_TITLE_PROGRESS_DONE_TTL_MS = 3_000;
// A cached model fires its file-load events in a short burst and then goes silent
// while onnxruntime builds the session; a genuine download keeps streaming progress
// events for seconds. Only reveal the bar once a still-incomplete event arrives after
// this grace window, so an already-downloaded model never flashes the bar.
export const TINY_TITLE_PROGRESS_REVEAL_DELAY_MS = 1_000;
// Double-tap ← on an empty editor opens the Agent Control Center (and, in a
// focused subagent view, ←← returns to the main session). The upper bound is
// AGENT_VIEW_LEFT_TAP_WINDOW_MS, imported rather than restated: it is the same
// gesture window the agent views were built around, and a second copy of the
// number here is how the two ends of one gesture drift apart. The lower bound
// rejects terminal-synthesized arrow-key bursts: "click to move cursor" /
// pointer features in iTerm2, WezTerm, kitty, and tmux emit several arrow keys
// in a single stdin read (sub-millisecond apart) on a stray click, which used to
// pop the card with no key ever pressed. Three or more rapid taps are likewise
// treated as a burst, not a gesture. A deliberate human double-tap is always
// tens of milliseconds apart.
export const LEFT_DOUBLE_TAP_MIN_GAP_MS = 40;

// How long the second Esc has to arrive for a double-press to read as one gesture.
// Both Esc gestures share it: discarding a draft, and `doubleEscapeAction` on an
// empty composer. Two copies of the number is how one gesture grows two feels.
export const DOUBLE_ESCAPE_WINDOW_MS = 500;

/**
 * The slice of `InteractiveModeContext` the input controller reads (H1-77). It
 * composes the two surfaces it forwards `ctx` to whole — the TUI slash-command
 * host (`executeBuiltinSlashCommand`) and the skill-command host
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
