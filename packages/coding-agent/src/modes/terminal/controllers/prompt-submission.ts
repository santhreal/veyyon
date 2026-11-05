/**
 * What a composer submission becomes: a continue shortcut, a builtin or skill command, `!` bash or `$`
 * python, a collab guest prompt, a steer into a streaming turn, a follow-up, or a new turn. A submission
 * that fails to go out comes back to the editor with its images.
 */
import type { ImageContent } from "@veyyon/ai";
import { errorMessage, logger } from "@veyyon/utils";
import type { CollabGuestLink } from "../../../collab/guest";
// The slot leaf, not the 94-module store: this file reads values, it does not fill them.
import { isSettingsInitialized, settings } from "../../../config/settings-instance";
import { turnControlPrompts } from "../../../prompts/turn-control/rows";
import type { AgentSession } from "../../../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../../../session/messages";
import { dispatchBuiltinSlashCommand } from "../../../slash-commands/dispatch";
import { isSensitiveSlashCommand, normalizeSubmittedPrompt } from "../../../slash-commands/helpers/parse";
import { isLowSignalTitleInput } from "../../../tiny/text";
import { autoTitleDisabled, generateSessionTitle } from "../../../utils/title-generator";
import { expandEmoticons } from "../autocomplete/emoji-autocomplete";
import { materializeImageReferenceLinks } from "../image-references";
import { parseQueueShorthand } from "../queue-input";
import { invokeSkillCommandFromText, isKnownSkillCommand } from "../skill-command";
import type { InputControllerContext } from "./input-controller";
import type { QueuedSubmissions } from "./queued-submissions";
import {
	clearEditorImages,
	nonEmptyCopy,
	pendingDraftImages,
	restoreDraft,
	type SubmittedInput,
} from "./submitted-input";
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

/** The python code in a `$`/`$$` line, or undefined when the line is prose such as `$HOME` or a pasted shell prompt. */
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

/** `text` as submitted: prompt-normalized, with its emoticons expanded unless emoji autocomplete is off. */
function preparedSubmitText(text: string): string {
	const normalized = normalizeSubmittedPrompt(text);
	if (!normalized || (isSettingsInitialized() && !settings.get("emojiAutocomplete"))) return normalized;
	return expandEmoticons(normalized);
}

export class PromptSubmission {
	constructor(
		private readonly ctx: InputControllerContext,
		private readonly queue: QueuedSubmissions,
	) {}

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
		const { images, imageLinks } = options ?? pendingDraftImages(this.ctx.editor);
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
			await this.queue.queue(queueBody, {
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
			clearEditorImages(this.ctx.editor);
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
			restoreDraft(this.ctx.editor, text, images, imageLinks);
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
		clearEditorImages(this.ctx.editor);
		const images = nonEmptyCopy(inputImages);
		try {
			await this.ctx.withLocalSubmission(
				text,
				() => this.ctx.session.prompt(text, { streamingBehavior: "steer", images }),
				{ imageCount: images?.length ?? 0 },
			);
		} catch (error) {
			// A draft typed since the dispatch stays; only an empty editor takes the submission back.
			if (!this.ctx.editor.getText()) restoreDraft(this.ctx.editor, text, images, imageLinks);
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
			this.ctx.session.thinkingLevel,
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
		const { images, imageLinks } = pendingDraftImages(this.ctx.editor);
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
				restoreDraft(this.ctx.editor, text, draftImages, draftImageLinks);
				return false;
			}
			return true;
		} catch (error) {
			restoreDraft(this.ctx.editor, text, draftImages, draftImageLinks);
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
		const { images, imageLinks } = pendingDraftImages(this.ctx.editor);
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
}
