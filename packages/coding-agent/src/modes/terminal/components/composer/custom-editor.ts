import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import type { ImageContent } from "@veyyon/ai";
// Leaves, not the `@veyyon/tui` and `@veyyon/utils` barrels: the editor is on the launch path, and
// each barrel re-exports its whole package.
import { Editor } from "@veyyon/tui/components/editor";
import { BracketedPasteHandler, PASTE_END, PASTE_START } from "@veyyon/utils/bracketed-paste";
import { addKeyAliases, canonicalKeyId } from "@veyyon/utils/keybindings";
import { type KeyId, parseKey, parseKittySequence } from "@veyyon/utils/keys";
import { replaceTabs } from "@veyyon/utils/tab-width";
import { hasUriScheme } from "@veyyon/utils/url";
import { truncateToWidth } from "@veyyon/utils/width";
import type { Attachment, CompletionState, ComposerMode, ComposerState, SubmitEvent } from "@veyyon/wire/presentation";
// The leaf table, not the loader: this file needs the shipped chords, not yaml.
import { KEYBINDINGS } from "../../../../config/keybinding-defs";
import type { AppKeybinding } from "../../../../config/keybindings";
// The slot leaf, not the 94-module store: this file reads values, it does not fill them.
import { isSettingsInitialized, settings } from "../../../../config/settings-instance";
import {
	cursorToOffset,
	offsetToCursor,
	resolveComposerMode,
	toComposerState,
} from "../../../../presentation/composer-builder";
import { fgOrPlain, theme } from "../../../../theme/theme-binding";
import { hasMagicKeyword, highlightMagicKeywords } from "../../../keywords/magic-keywords";
import { imageReferenceHyperlink, PLACEHOLDER_REGEX, renderPlaceholders } from "../../image-reference-markers";
import { isQueuedMessageList, parseQueueShorthand, QUEUE_LIST_MARKER_RE } from "../../queue-input";

/**
 * The actions this editor matches keys for, as a value so the defaults can be
 * derived from it rather than restated beside it.
 *
 * `satisfies readonly AppKeybinding[]` keeps the compile-time guarantee the old
 * `Extract<...>` union gave: a name that is not a real app binding is an error
 * here, not a row that silently matches nothing.
 */
export const CONFIGURABLE_EDITOR_ACTIONS = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.display.reset",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.model.selectTemporary",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.history.search",
	"app.message.dequeue",
	"app.retry",
	"app.clipboard.pasteImage",
	"app.clipboard.pasteTextRaw",
	"app.clipboard.copyPrompt",
	"app.bash.background",
] as const satisfies readonly AppKeybinding[];

export type ConfigurableEditorAction = (typeof CONFIGURABLE_EDITOR_ACTIONS)[number];

/**
 * The subset of configurable editor actions that are captured and deferred
 * during early startup (postpaint first frame until interactive mode is initialized).
 */
export const DEFERRED_EDITOR_ACTIONS = [
	"app.model.select",
	"app.model.selectTemporary",
] as const satisfies readonly ConfigurableEditorAction[];

export type DeferredEditorAction = (typeof DEFERRED_EDITOR_ACTIONS)[number];

/**
 * The shipped chord for each action this editor matches, read from the one table.
 *
 * These are the FALLBACK values, used until the host calls `setActionKeys` with
 * whatever the user's `keybindings.yml` resolved to. They used to be a hand-written
 * copy of twenty rows, which is exactly the shape that drifts: the copy pinned
 * `app.clipboard.pasteImage` to `ctrl+v` alone, so on Windows and macOS its
 * `alt+v` / `super+v` fallbacks were missing here and present everywhere else, and
 * an editor mounted before the host injected keys silently matched the wrong set.
 *
 * `config/keybinding-defs.ts` is the leaf that holds the table, so reading it here
 * costs the TUI types and nothing else. `KEYBINDINGS` covers the `tui.*` ids too;
 * only the ids in {@link ConfigurableEditorAction} are picked out, so an action
 * this editor does not handle cannot arrive by accident.
 */
const DEFAULT_ACTION_MATCH_KEYS: ReadonlyMap<ConfigurableEditorAction, ReadonlySet<string>> = new Map(
	CONFIGURABLE_EDITOR_ACTIONS.map(action => {
		const keys = KEYBINDINGS[action].defaultKeys;
		return [action, buildMatchKeys(typeof keys === "string" ? [keys] : keys)];
	}),
);

function buildMatchKeys(keys: readonly KeyId[]): Set<string> {
	const matchKeys = new Set<string>();
	for (const key of keys) {
		addKeyAliases(matchKeys, key);
	}
	return matchKeys;
}

const BRACKETED_IMAGE_PATH_REGEX = /\.(?:png|jpe?g|gif|webp)$/i;
const SHELL_ESCAPED_PATH_CHAR_REGEX = /\\([\\\s'"()[\]{}&;<>|?*!$`])/g;
const FILE_URI_REGEX = /^file:\/\//i;
const WINDOWS_DRIVE_PATH_REGEX = /^[a-z]:[\\/]/i;
/**
 * Whole-string anchor for paths that are unambiguously absolute. Restricts the
 * "treat the entire clipboard text as one path" branch of
 * {@link extractImagePathFromText} to inputs that start with a clearly-anchored
 * filesystem prefix, so prose containing a path-shaped fragment (e.g.
 * "see /tmp/x.png") never hijacks the smart fallback.
 */
const ABSOLUTE_PATH_PREFIX_REGEX = /^(?:\/|~\/|file:\/\/|\\\\|[A-Za-z]:[\\/])/;

/** Max gap (ms) between two spaces for the later one to count as OS key auto-repeat rather than a
 *  deliberate press. OS auto-repeat is fast; a deliberate tap (even a fast one) is slower. */
export const SPACE_REPEAT_MAX_GAP_MS = 120;
/** Two consecutive inter-space gaps are "mechanical" (machine-driven auto-repeat) when both are
 *  within {@link SPACE_REPEAT_MAX_GAP_MS} and differ by no more than this — an absolute jitter floor
 *  or, for slower repeat rates, {@link SPACE_REPEAT_JITTER_RATIO} of the smaller gap. OS key-repeat
 *  is metronomic; a human smashing the bar is fast but irregular, so its deltas never stay this
 *  steady. */
export const SPACE_REPEAT_JITTER_MS = 18;
export const SPACE_REPEAT_JITTER_RATIO = 0.35;
/** Consecutive mechanical (fast + steady) deltas that confirm the space bar is held and start
 *  recording. Needs a sustained metronomic cadence, so jittery smashing and deliberate taps never
 *  reach it. */
export const SPACE_HOLD_MECHANICAL_RUN = 2;
/** Idle gap (ms) after the last repeated space that counts as the space bar being released, ending
 *  the push-to-talk recording. Must comfortably exceed the OS key-repeat interval. */
export const SPACE_HOLD_RELEASE_MS = 250;

/** Whether two consecutive inter-space gaps look machine-driven: both within the auto-repeat band
 *  and steady enough (small absolute or proportional difference). OS key-repeat is metronomic, so
 *  its successive deltas match closely; human smashing is fast but irregular and deliberate taps are
 *  too slow, so neither passes. */
function gapsAreMechanical(gap: number, prevGap: number): boolean {
	if (gap > SPACE_REPEAT_MAX_GAP_MS || prevGap > SPACE_REPEAT_MAX_GAP_MS) return false;
	const tolerance = Math.max(SPACE_REPEAT_JITTER_MS, Math.min(gap, prevGap) * SPACE_REPEAT_JITTER_RATIO);
	return Math.abs(gap - prevGap) <= tolerance;
}

function isPastedPathSeparator(char: string | undefined): boolean {
	return char === undefined || char === " " || char === "\t" || char === "\r" || char === "\n";
}

function normalizePastedPath(path: string): string {
	const trimmed = path.trim();
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	const unquoted =
		trimmed.length > 1 && (first === '"' || first === "'") && last === first ? trimmed.slice(1, -1) : trimmed;
	// `file://` URL → local filesystem path. Mirrors Codex's
	// `normalize_pasted_path` (codex-rs/tui/src/clipboard_paste.rs) so a
	// pasteboard whose text representation is a `file:///Users/…/img.png`
	// URL — common when terminals forward the macOS pasteboard's
	// `public.file-url` representation — loads as the file itself rather
	// than failing in `loadImageInput` with a literal-`file://` path.
	if (FILE_URI_REGEX.test(unquoted)) {
		try {
			return fileURLToPath(unquoted);
		} catch {
			// Malformed file URL: drop through to the shell-unescape branch
			// so the caller can still reject it as a non-explicit path.
		}
	}
	return unquoted.replace(SHELL_ESCAPED_PATH_CHAR_REGEX, "$1");
}

function isExplicitPastedPath(path: string): boolean {
	if (WINDOWS_DRIVE_PATH_REGEX.test(path) || FILE_URI_REGEX.test(path)) return true;
	if (hasUriScheme(path)) return false;
	return path.includes("/") || path.includes("\\");
}

function isImagePath(path: string): boolean {
	return BRACKETED_IMAGE_PATH_REGEX.test(path);
}

function splitPastedPathSegments(payload: string): string[] | undefined {
	const segments: string[] = [];
	let segment = "";
	let quote: string | undefined;
	let escaped = false;

	for (let i = 0; i < payload.length; i++) {
		const char = payload[i];
		if (escaped) {
			segment += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			segment += char;
			escaped = true;
			continue;
		}
		if (quote) {
			segment += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			segment += char;
			quote = char;
			continue;
		}
		if (isPastedPathSeparator(char)) {
			if (segment) {
				segments.push(segment);
				segment = "";
			}
			continue;
		}
		segment += char;
	}

	if (escaped || quote) return undefined;
	if (segment) segments.push(segment);
	return segments.length > 0 ? segments : undefined;
}

/**
 * Extract whitespace/quoted-separated path-like segments from `payload`.
 * Shared backend of {@link extractBracketedPastePaths} and {@link extractPastePathsFromText}.
 * Returns the segments only when EVERY segment looks like an explicit path
 * (`/`, `\`, drive letter, or `file://`); otherwise undefined so the caller
 * falls back to a plain text paste.
 */
function extractExplicitPathSegments(payload: string): string[] | undefined {
	const pasted = payload.trim();
	if (!pasted) return undefined;

	const segments = splitPastedPathSegments(pasted);
	if (!segments) return undefined;

	const paths: string[] = [];
	for (const segment of segments) {
		const path = normalizePastedPath(segment);
		if (!path || !isExplicitPastedPath(path)) return undefined;
		paths.push(path);
	}
	return paths;
}

/**
 * Extract image-or-other file paths from plain (un-bracketed) clipboard text.
 * Mirrors {@link extractBracketedPastePaths} for terminals/handlers that
 * already stripped the `\x1b[200~`…`\x1b[201~` markers (e.g. clipboard text
 * read directly via `pbpaste`/PowerShell).
 */
export function extractPastePathsFromText(text: string): string[] | undefined {
	return extractExplicitPathSegments(text);
}

export function extractBracketedPastePaths(data: string): string[] | undefined {
	if (!data.startsWith(PASTE_START)) return undefined;
	const endIndex = data.indexOf(PASTE_END, PASTE_START.length);
	if (endIndex === -1 || endIndex + PASTE_END.length !== data.length) return undefined;
	return extractExplicitPathSegments(data.slice(PASTE_START.length, endIndex));
}

export function extractBracketedImagePastePaths(data: string): string[] | undefined {
	const paths = extractBracketedPastePaths(data);
	return paths?.every(isImagePath) ? paths : undefined;
}

/**
 * Same shape as {@link extractBracketedImagePastePaths} but operates on a
 * payload that has already been stripped of the `\x1b[200~` / `\x1b[201~`
 * markers — used by the assembled-paste router in {@link CustomEditor.handleInput}
 * so split bracketed pastes get the same image-path detection as single-chunk ones.
 */
export function extractImagePastePathsFromText(text: string): string[] | undefined {
	const paths = extractPastePathsFromText(text);
	return paths?.every(isImagePath) ? paths : undefined;
}

export function extractBracketedImagePastePath(data: string): string | undefined {
	const paths = extractBracketedImagePastePaths(data);
	return paths?.length === 1 ? paths[0] : undefined;
}

/**
 * Return a single image file path when `text` is exactly one explicit path
 * pointing at a supported image extension (`.png`, `.jpg`/`.jpeg`, `.gif`,
 * `.webp`). Used by the keybind-driven clipboard image paste path so a
 * clipboard whose only payload is an image file (e.g. Finder `Cmd+C` on
 * macOS) attaches the image instead of pasting the path as literal text.
 *
 * Two-stage detection:
 *
 * 1. Splitter pass (shared with the bracketed-paste handler) — handles
 *    quoted paths, shell-escaped spaces, and unambiguous single tokens.
 *    Returns the single image path when it parses cleanly; explicitly
 *    returns `undefined` when the splitter found multiple segments (so
 *    ambiguous multi-path clipboard text like `/tmp/a.png /tmp/b.png`
 *    still falls through to the text fallback instead of being mis-loaded
 *    as one giant path).
 * 2. Whole-text-as-path pass — only reached when the splitter failed
 *    (every segment must look like an explicit path; an unescaped space in
 *    a real path breaks that). Restricted to inputs anchored by
 *    {@link ABSOLUTE_PATH_PREFIX_REGEX} so prose containing a path-shaped
 *    fragment ("see /tmp/x.png") never hijacks the smart fallback. This
 *    is what recovers macOS screenshot filenames like
 *    `/Users/me/Desktop/Screenshot 2026-06-25 at 1.23.45 PM.png`.
 */
export function extractImagePathFromText(text: string): string | undefined {
	const paths = extractPastePathsFromText(text);
	if (paths?.length === 1 && isImagePath(paths[0])) return paths[0];
	if (paths !== undefined) return undefined;
	const trimmed = text.trim();
	if (!trimmed || /[\r\n]/.test(trimmed) || !ABSOLUTE_PATH_PREFIX_REGEX.test(trimmed)) return undefined;
	const wholePath = normalizePastedPath(trimmed);
	if (wholePath && isExplicitPastedPath(wholePath) && isImagePath(wholePath)) {
		return wholePath;
	}
	return undefined;
}
export interface EarlySubmission {
	readonly text: string;
	readonly images?: ImageContent[];
	readonly imageLinks?: (string | undefined)[];
	readonly attachments?: readonly Attachment[];
}

const EMPTY_ATTACHMENTS: readonly Attachment[] = [];

type EditorActionHandler = (() => unknown) | undefined;

/** One row of the shortcut table: true when the key was consumed. */
type EditorActionDispatch = (editor: CustomEditor, canonical: string) => boolean;

/** Calls `handler` with the editor as receiver, as `editor.onX()` would; false when no handler is bound. */
function fireEditorAction(editor: CustomEditor, handler: EditorActionHandler): boolean {
	if (!handler) return false;
	handler.call(editor);
	return true;
}

/**
 * Custom editor that handles configurable app-level shortcuts for coding-agent.
 */
export class CustomEditor extends Editor {
	#earlySubmissions: EarlySubmission[] = [];
	#earlyActions: DeferredEditorAction[] = [];
	#locked = false;
	#awaitingApproval = false;
	#mode: ComposerMode | undefined;
	#queueOnSubmit = false;
	#hint: string | undefined;
	#placeholder: string | undefined;
	#attachments: readonly Attachment[] = EMPTY_ATTACHMENTS;
	#completion: CompletionState | undefined;
	#submitting = false;
	onComposerChange?: (state: ComposerState) => void;
	onComposerSubmit?: (event: SubmitEvent) => void;
	#capturingEarlySubmissions = false;
	#draftInputRevision = 0;
	#submissionDraftScope: AsyncLocalStorage<number> | undefined;

	/** Delayed submissions may finish after another draft has been entered. */
	withPreservedDraft<T>(action: () => T): T {
		this.#submissionDraftScope ??= new AsyncLocalStorage<number>();
		const revision = this.getText() || this.pendingImages.length > 0 ? -1 : this.#draftInputRevision;
		return this.#submissionDraftScope.run(revision, action);
	}

	#isNewerDraft(): boolean {
		const revision = this.#submissionDraftScope?.getStore();
		return revision !== undefined && revision !== this.#draftInputRevision;
	}

	override setText(text: string): void {
		if (!this.#isNewerDraft()) super.setText(text);
	}

	takeEarlySubmissions(): EarlySubmission[] {
		this.#capturingEarlySubmissions = false;
		return this.#earlySubmissions.splice(0);
	}

	takeEarlyActions(): DeferredEditorAction[] {
		return this.#earlyActions.splice(0);
	}
	beginEarlySubmissions(): void {
		this.#capturingEarlySubmissions = true;
		this.onSubmit = text => {
			if (!text && this.pendingImages.length === 0 && this.#attachments.length === 0) return;
			const atts = this.attachments;
			this.#earlySubmissions.push({
				text,
				images: this.pendingImages.length > 0 ? this.pendingImages.slice() : undefined,
				imageLinks: this.pendingImageLinks.length > 0 ? this.pendingImageLinks.slice() : undefined,
				attachments: atts.length > 0 ? atts.slice() : undefined,
			});
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
			this.#attachments = EMPTY_ATTACHMENTS;
			if (!this.#submitting) {
				this.onComposerSubmit?.({
					type: "submit",
					text,
					attachments: atts,
				});
			}
		};
	}

	hasEarlySubmissions(): boolean {
		return this.#earlySubmissions.length > 0;
	}

	hasEarlyActions(): boolean {
		return this.#earlyActions.length > 0;
	}

	adoptEarlySubmissions(previous: CustomEditor): boolean {
		if (!previous.#capturingEarlySubmissions) return false;
		this.#earlySubmissions.push(...previous.takeEarlySubmissions());
		this.#earlyActions.push(...previous.takeEarlyActions());
		this.beginEarlySubmissions();
		return true;
	}
	#imageLinks: readonly (string | undefined)[] | undefined;
	get imageLinks(): readonly (string | undefined)[] | undefined {
		return this.#imageLinks;
	}
	set imageLinks(value: readonly (string | undefined)[] | undefined) {
		if (!this.#isNewerDraft()) this.#imageLinks = value;
	}

	/** Draft images pasted into the composer, consumed on submit. Co-located with
	 *  {@link imageLinks} so every piece of draft-image state lives on the editor. */
	#pendingImages: ImageContent[] = [];
	get pendingImages(): ImageContent[] {
		return this.#pendingImages;
	}
	set pendingImages(value: ImageContent[]) {
		if (!this.#isNewerDraft()) this.#pendingImages = value;
	}
	/** Per-image source links (file:// targets) parallel to {@link pendingImages};
	 *  `undefined` entries are images without a backing reference yet. */
	#pendingImageLinks: (string | undefined)[] = [];
	get pendingImageLinks(): (string | undefined)[] {
		return this.#pendingImageLinks;
	}
	set pendingImageLinks(value: (string | undefined)[]) {
		if (!this.#isNewerDraft()) this.#pendingImageLinks = value;
	}

	/** Clear the composer draft: optionally commit `historyText` to history, then
	 *  reset the editor text and all pending draft-image state. The shared tail of
	 *  every "message submitted" path; pass no argument for a plain discard. */
	clearDraft(historyText?: string): void {
		if (historyText !== undefined) this.addToHistory(historyText);
		if (this.#isNewerDraft()) return;
		this.setText("");
		this.imageLinks = undefined;
		this.pendingImages = [];
		this.pendingImageLinks = [];
		this.#attachments = EMPTY_ATTACHMENTS;
	}

	/** Attachments currently staged on the editor (combining explicit attachments and pending images). */
	get attachments(): readonly Attachment[] {
		if (this.#attachments.length === 0 && this.pendingImages.length === 0 && this.pendingImageLinks.length === 0) {
			return EMPTY_ATTACHMENTS;
		}
		const nonImages = this.#attachments.filter(a => a.kind !== "image");
		const explicitImages = this.#attachments.filter(a => a.kind === "image");
		const result: Attachment[] = [...nonImages];

		const totalImages = Math.max(this.pendingImages.length, this.pendingImageLinks.length, explicitImages.length);
		for (let idx = 0; idx < totalImages; idx++) {
			const explicit = explicitImages[idx];
			const img = this.pendingImages[idx];
			const link = this.pendingImageLinks[idx] ?? this.imageLinks?.[idx] ?? explicit?.uri;
			if (explicit) {
				result.push({
					...explicit,
					data: img?.data ?? explicit.data,
					mimeType: img?.mimeType ?? explicit.mimeType,
					uri: link ?? explicit.uri,
				});
			} else {
				const name = link ? link.replace(/^file:\/\//, "") : img?.mimeType ? `image (${img.mimeType})` : "image";
				result.push({
					kind: "image",
					name,
					data: img?.data,
					mimeType: img?.mimeType,
					uri: link,
				});
			}
		}
		return result;
	}
	set attachments(value: readonly Attachment[] | undefined) {
		if (this.#isNewerDraft()) return;
		this.#attachments = value && value.length > 0 ? value.map(a => ({ ...a })) : EMPTY_ATTACHMENTS;
		this.pendingImages = [];
		this.pendingImageLinks = [];
		for (const att of this.#attachments) {
			if (att.kind === "image") {
				if (att.data && att.mimeType) {
					this.pendingImages.push({
						type: "image",
						data: att.data,
						mimeType: att.mimeType,
					});
					this.pendingImageLinks.push(att.uri);
				} else if (att.uri) {
					this.pendingImageLinks.push(att.uri);
				}
			}
		}
	}
	get completion(): CompletionState | undefined {
		const auto = this.getAutocompleteState();
		if (!auto) {
			this.#completion = undefined;
			return undefined;
		}
		if (this.#completion && this.#completion.prefix === auto.prefix) {
			return {
				...this.#completion,
				selectedIndex: auto.selectedIndex,
			};
		}
		return {
			prefix: auto.prefix,
			candidates: auto.items.map(item => ({
				value: item.value,
				label: item.label !== item.value ? item.label : undefined,
				detail: item.description,
			})),
			selectedIndex: auto.selectedIndex,
		};
	}
	set completion(value: CompletionState | undefined) {
		this.#completion = value;
		if (value && value.candidates.length > 0) {
			this.setAutocompleteSuggestions({
				prefix: value.prefix,
				items: value.candidates.map(c => ({
					value: c.value,
					label: c.label ?? c.value,
					description: c.detail,
				})),
				selectedIndex: value.selectedIndex,
			});
		} else {
			this.setAutocompleteSuggestions(undefined);
		}
	}

	get locked(): boolean {
		return this.#locked;
	}
	set locked(value: boolean) {
		this.#locked = value;
		this.#applyFlagMode("disabled", value);
	}

	get awaitingApproval(): boolean {
		return this.#awaitingApproval;
	}
	set awaitingApproval(value: boolean) {
		this.#awaitingApproval = value;
		this.#applyFlagMode("awaiting-approval", value);
	}

	/** Enter `mode` while its flag is set; on clear, leave it only when the composer is still in it. */
	#applyFlagMode(mode: "disabled" | "awaiting-approval", value: boolean): void {
		if (value) {
			this.#mode = mode;
			this.disableSubmit = true;
		} else if (this.#mode === mode) {
			this.#mode = undefined;
			this.disableSubmit = false;
		}
	}

	get mode(): ComposerMode {
		return this.getComposerState().mode;
	}
	set mode(value: ComposerMode | undefined) {
		this.#mode = value;
		this.disableSubmit = value === "disabled" || value === "awaiting-approval";
	}

	get queueOnSubmit(): boolean {
		return this.#queueOnSubmit;
	}
	set queueOnSubmit(value: boolean) {
		this.#queueOnSubmit = value;
	}

	get hint(): string | undefined {
		return this.#hint;
	}
	set hint(value: string | undefined) {
		this.#hint = value;
	}

	/** Return the 0-based UTF-16 character offset of the cursor in the full editor text. */
	getCursorOffset(): number {
		return cursorToOffset(this.getLines(), this.getCursor());
	}

	/** Set the cursor position to a 0-based UTF-16 character offset in the full text. */
	setCursorOffset(offset: number): void {
		this.setCursor(offsetToCursor(this.getLines(), offset));
	}

	/**
	 * Build a snapshot of the current ComposerState from the editor's live buffer and session facts.
	 */
	getComposerState(): ComposerState {
		const text = this.getText();
		const cursorOffset = this.getCursorOffset();
		const attachments = this.attachments;
		const completion = this.completion;
		const mode =
			this.#mode ??
			resolveComposerMode({
				text,
				cursorOffset,
				attachments,
				completion,
				busy: this.#queueOnSubmit,
				awaitingApproval: this.#awaitingApproval,
				locked: this.#locked || this.disableSubmit,
				hint: this.#hint,
			});
		const state = toComposerState({
			text,
			cursorOffset,
			attachments,
			completion,
			busy: this.#queueOnSubmit,
			awaitingApproval: this.#awaitingApproval || mode === "awaiting-approval",
			locked: this.#locked || mode === "disabled",
			hint: this.#hint,
			mode,
		});
		if (this.#placeholder !== undefined) {
			state.placeholder = this.#placeholder;
		}
		state.mode = mode;
		return state;
	}

	/**
	 * Apply a complete ComposerState snapshot into the editor buffer and state flags.
	 */
	setComposerState(state: ComposerState): void {
		if (this.#isNewerDraft()) return;
		this.#mode = state.mode;
		this.#locked = state.mode === "disabled";
		this.#awaitingApproval = state.mode === "awaiting-approval";
		this.disableSubmit = state.mode === "disabled" || state.mode === "awaiting-approval";
		this.#placeholder = state.placeholder;
		this.setPlaceholder(state.placeholder !== "" ? state.placeholder : undefined);
		this.#queueOnSubmit = state.queueOnSubmit;
		this.#hint = state.hint;
		this.attachments = state.attachments;
		if (this.attachments.every(a => a.kind !== "image")) {
			this.#imageLinks = undefined;
		}

		if (state.text !== this.getText()) {
			super.setText(state.text);
		}
		if (state.cursorOffset !== undefined && state.cursorOffset !== this.getCursorOffset()) {
			this.setCursorOffset(state.cursorOffset);
		}
		this.completion = state.completion;
	}

	override render(width: number): readonly string[] {
		const baseRows = super.render(width);
		const fileAtts = this.attachments.filter(att => att.kind === "file");
		const hint = this.#hint;
		const queue = this.#queueOnSubmit;
		if (fileAtts.length === 0 && hint === undefined && !queue) {
			return baseRows;
		}
		const usable = Math.max(0, Math.trunc(width));
		if (usable === 0) {
			return baseRows;
		}
		const extraRows: string[] = [];
		for (const att of fileAtts) {
			const sanitizedName = replaceTabs(att.name).replace(/[\r\n\x00-\x1f\x7f]/g, " ");
			extraRows.push(fgOrPlain("dim", truncateToWidth(`  + ${sanitizedName}`, usable)));
		}
		if (queue) {
			extraRows.push(fgOrPlain("dim", truncateToWidth("  a turn is running; enter queues this message", usable)));
		}
		if (hint !== undefined && hint !== "") {
			const sanitizedHint = replaceTabs(hint).replace(/[\r\n\x00-\x1f\x7f]/g, " ");
			extraRows.push(fgOrPlain("dim", truncateToWidth(`  ${sanitizedHint}`, usable)));
		}
		return [...baseRows, ...extraRows];
	}

	override submit(): void {
		if (this.disableSubmit || this.mode === "disabled" || this.mode === "awaiting-approval") {
			return;
		}
		if (!this.onSubmit && !this.onComposerSubmit) {
			return;
		}
		const text = this.getText();
		const atts = this.attachments;
		const hasImages = this.pendingImages.length > 0;
		if (!text.trim() && atts.length === 0 && !hasImages) {
			return;
		}
		if (this.#submitting) return;
		this.#submitting = true;
		try {
			if (this.onSubmit) {
				super.submit();
			} else {
				this.clearDraft(text);
			}
			this.onComposerSubmit?.({
				type: "submit",
				text,
				attachments: atts,
			});
		} finally {
			this.#submitting = false;
		}
	}

	/** Treat image/paste markers as indivisible: a stray backspace deletes the whole token
	 *  instead of corrupting `[Paste #1, +30 lines]` into plain text. */
	override atomicTokenPattern = PLACEHOLDER_REGEX;

	/** Magic-keyword shimmer cadence — drives one editor repaint every 70 ms while
	 *  a keyword is on screen and the prompt is focused. ~14 frames/s is smooth
	 *  without flooding the renderer. */
	static readonly SHIMMER_FRAME_MS = 70;
	/** Time for the gradient to sweep one full cycle across each keyword. */
	static readonly SHIMMER_PERIOD_MS = 1800;

	/** Per-render scratch flag: did any layout line in this render contain a magic
	 *  keyword that should shimmer? Reset by {@link #scheduleShimmerIfNeeded} each
	 *  time a frame is queued. */
	#shimmerTimer: Timer | undefined;
	/** Repaint hook the host wires once at construction. Called from the shimmer
	 *  timer to request the next animation frame. Undefined when nobody is
	 *  listening (tests, headless callers); the timer chain still self-cleans. */
	#requestShimmerRepaint: (() => void) | undefined;
	#queueDecorationText: string | undefined;
	#queueShorthandActive = false;
	#queueListActive = false;

	/** Decorate magic keywords, attachments, and the queue-composer header/list markers.
	 *  Queue shorthand reserves its first logical line as a dim `Queueing` label; sequential
	 *  item markers use the accent color so separate follow-ups remain visible while composing. */
	decorateText = (text: string): string => {
		const editorText = this.getText();
		const animated = this.focused && this.#shimmerEnabled() && hasMagicKeyword(editorText);
		const phase = animated ? (Date.now() % CustomEditor.SHIMMER_PERIOD_MS) / CustomEditor.SHIMMER_PERIOD_MS : 0;
		if (animated) this.#scheduleShimmerFrame();
		if (this.#queueDecorationText !== editorText) {
			this.#queueDecorationText = editorText;
			const queueBody = parseQueueShorthand(editorText);
			this.#queueShorthandActive = queueBody !== undefined;
			this.#queueListActive = queueBody !== undefined && isQueuedMessageList(queueBody);
		}
		return renderPlaceholders(text, {
			renderText: value => {
				const highlighted = highlightMagicKeywords(value, undefined, phase);
				if (this.#queueShorthandActive && (value.startsWith("->") || value.startsWith("=>"))) {
					const icon = typeof theme === "undefined" ? ">" : theme.nav.selected;
					return `${fgOrPlain("dim", `Queueing ${icon}`)}${highlighted.slice(2)}`;
				}
				if (this.#queueListActive) {
					const markerMatch = QUEUE_LIST_MARKER_RE.exec(value);
					if (markerMatch) {
						const indent = markerMatch[1] ?? "";
						const markerEnd = markerMatch[0].length;
						return `${indent}${fgOrPlain("accent", value.slice(indent.length, markerEnd))}${highlighted.slice(markerEnd)}`;
					}
				}
				return highlighted;
			},
			renderReference: (value, kind, index) =>
				kind === "image"
					? imageReferenceHyperlink(value, index, this.imageLinks, label =>
							fgOrPlain("accent", label, `\x1b[1m\x1b[4m${label}\x1b[24m\x1b[22m`),
						)
					: fgOrPlain("accent", value, `\x1b[1m${value}\x1b[22m`),
		});
	};

	/** Optional test/host override for the magic-keyword shimmer gate. When
	 *  defined, takes precedence over the global `magicKeywords.enabled` setting,
	 *  letting tests assert the gating behaviour without mutating the
	 *  process-wide Settings singleton (which races with parallel test files —
	 *  see issue #2582). Production wires this through the host's Settings
	 *  reader and updates it on the relevant setting change. */
	magicKeywordsEnabledOverride: boolean | undefined;

	/** Whether the shimmer should advance this frame. Defaults to "on" before
	 *  settings have initialised (tests, early boot) so the animation does not
	 *  silently disappear during a race; settings disabling the feature wins
	 *  once they are loaded. An explicit `magicKeywordsEnabledOverride` overrides
	 *  both paths. */
	#shimmerEnabled(): boolean {
		if (this.magicKeywordsEnabledOverride !== undefined) return this.magicKeywordsEnabledOverride;
		return isSettingsInitialized() ? settings.get("magicKeywords.enabled") : true;
	}

	/** Bind the host's render request callback. Idempotent — the host wires this
	 *  once after construction (and again after `setEditorComponent` swaps the
	 *  editor). Passing `undefined` clears any pending frame. */
	setShimmerRepaintHandler(handler: (() => void) | undefined): void {
		this.#requestShimmerRepaint = handler;
		if (!handler && this.#shimmerTimer) {
			clearTimeout(this.#shimmerTimer);
			this.#shimmerTimer = undefined;
		}
	}

	/** Schedule one shimmer frame if none is already pending. The next render
	 *  decides whether to schedule another, so the chain stops by itself when
	 *  `focused` flips off or the keyword leaves the buffer. */
	#scheduleShimmerFrame(): void {
		if (this.#shimmerTimer || !this.#requestShimmerRepaint) return;
		this.#shimmerTimer = setTimeout(() => {
			this.#shimmerTimer = undefined;
			this.#requestShimmerRepaint?.();
		}, CustomEditor.SHIMMER_FRAME_MS);
		this.#shimmerTimer.unref?.();
	}
	onEscape?: () => void;
	onClear?: () => void;
	onExit?: () => void;
	onDisplayReset?: () => void;
	onCycleThinkingLevel?: () => void;
	onCycleModelForward?: () => void;
	onCycleModelBackward?: () => void;
	onSelectModel?: () => void;
	onExpandTools?: () => void;
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onHistorySearch?: () => void;
	onSuspend?: () => void;
	/** Manual "background the running foreground command". Returns whether a
	 *  foreground wait consumed the key; on false the key falls through to its
	 *  editor meaning (ctrl+b is also readline cursor-left). */
	onBashBackground?: () => boolean;
	onSelectModelTemporary?: () => void;
	/** Called when the configured copy-prompt shortcut is pressed. */
	onCopyPrompt?: () => void;
	/** Called when the configured image-paste shortcut is pressed. */
	onPasteImage?: () => Promise<boolean>;
	/** Called when a bracketed paste contains one or more image-file paths. */
	onPasteImagePath?: (path: string) => void | Promise<void>;
	/** Called when the configured raw text-paste shortcut is pressed. */
	onPasteTextRaw?: () => void;
	/** Called when the configured dequeue shortcut is pressed. */
	onDequeue?: () => void;
	/** Called when the configured retry shortcut is pressed. */
	onRetry?: () => void;
	/** Called when Caps Lock is pressed. */
	onCapsLock?: () => void;
	/** Called when left-arrow is pressed while the editor is empty (cursor necessarily at start). */
	onLeftAtStart?: () => void;

	/** Fired when a sustained space-bar hold is recognized — the push-to-talk STT start. The
	 *  optimistically-typed spaces have already been deleted by the time this runs. */
	onSpaceHoldStart?: () => void;
	/** Fired when the held space bar is released (detected as an idle gap with no further repeated
	 *  spaces) — the push-to-talk STT stop. */
	onSpaceHoldEnd?: () => void;
	/** Gate for the space-hold gesture. Returns false to keep the space bar inserting spaces
	 *  normally; wired to `stt.enabled` so disabling STT restores plain space behavior. */
	sttHoldEnabled?: () => boolean;

	/** Custom key handlers from extensions and non-built-in app actions. */
	#customKeyHandlers = new Map<KeyId, () => void>();
	#customMatchKeys = new Map<string, () => void>();
	/** Bracketed-paste assembler that runs ahead of the inherited handler so terminals which
	 *  deliver `\x1b[200~` and `\x1b[201~` in separate stdin chunks still resolve to a single
	 *  assembled payload here; the empty-paste / image-path branches must see the full content,
	 *  not the raw single-chunk byte sequence. */
	#pasteHandler = new BracketedPasteHandler();
	/** Number of async pastes (clipboard-image reads / image-path attachments) currently in flight.
	 *  While > 0, `handleInput` queues subsequent keystrokes into {@link #pendingInput} instead of
	 *  dispatching them so a trailing `Enter` after `Cmd+V` can't submit before the image lands on
	 *  `pendingImages` (Codex PR #3602 review). */
	#pasteInFlight = 0;
	/** Input chunks deferred behind an in-flight paste, drained in FIFO order once the paste
	 *  count returns to zero. */
	#pendingInput: string[] = [];
	/** Spaces actually inserted in the current run; tracked back out when a hold is recognized. */
	#spaceRunInserted = 0;
	/** Consecutive "mechanical" deltas (fast + steady); a sustained run of these confirms a held bar. */
	#mechanicalRun = 0;
	/** Inter-space gap (ms) of the previous space pair, compared against the next to judge steadiness. */
	#prevSpaceGap: number | undefined;
	/** Monotonic timestamp (ms) of the last space, to measure the gap to the next one. */
	#lastSpaceAt = Number.NEGATIVE_INFINITY;
	/** True while a recognized space-hold push-to-talk recording is in progress. */
	#spaceHoldActive = false;
	/** Idle timer that fires `onSpaceHoldEnd` once repeated spaces stop arriving. */
	#spaceHoldTimer: NodeJS.Timeout | undefined;
	#actionMatchKeys = new Map(DEFAULT_ACTION_MATCH_KEYS);

	setActionKeys(action: ConfigurableEditorAction, keys: KeyId[]): void {
		this.#actionMatchKeys.set(action, buildMatchKeys(keys));
	}

	applyKeybindings(keybindings: { getKeys(action: AppKeybinding): KeyId[] }): void {
		for (const action of CONFIGURABLE_EDITOR_ACTIONS) {
			this.setActionKeys(action, keybindings.getKeys(action));
		}
	}

	#rebuildCustomMatchKeys(): void {
		this.#customMatchKeys.clear();
		for (const [keyId, handler] of this.#customKeyHandlers) {
			for (const alias of buildMatchKeys([keyId])) {
				// Preserve current iteration behavior: the first registered handler for colliding aliases wins.
				if (!this.#customMatchKeys.has(alias)) this.#customMatchKeys.set(alias, handler);
			}
		}
	}

	#matchesAction(canonical: string | undefined, action: ConfigurableEditorAction): boolean {
		return canonical !== undefined && (this.#actionMatchKeys.get(action)?.has(canonical) ?? false);
	}

	/** Pushes a deferred action while early submissions are being captured; otherwise fires its handler. */
	static #deferOrFire(editor: CustomEditor, action: DeferredEditorAction, handler: EditorActionHandler): boolean {
		if (editor.#capturingEarlySubmissions) {
			editor.#earlyActions.push(action);
			return true;
		}
		return fireEditorAction(editor, handler);
	}

	/**
	 * The app-level shortcuts this editor intercepts before the key reaches the
	 * base editor, in precedence order: the first matching row that reports the
	 * key consumed ends dispatch, a row that reports `false` lets later rows and
	 * then the editor's own meaning see the key. Backward model cycling sits
	 * before forward; retry sits after copy-prompt and yields to an extension
	 * handler bound to the same chord, so adding the default Alt+R binding does
	 * not steal existing shortcuts such as app.plan.toggle or extension commands.
	 * `custom-editor-keybindings.test.ts` sweeps every configurable action
	 * through this table.
	 */
	static readonly #ACTION_DISPATCH: ReadonlyArray<readonly [ConfigurableEditorAction, EditorActionDispatch]> = [
		// Image paste is async: fires and handles its own result.
		["app.clipboard.pasteImage", editor => fireEditorAction(editor, editor.onPasteImage)],
		["app.clipboard.pasteTextRaw", editor => fireEditorAction(editor, editor.onPasteTextRaw)],
		["app.editor.external", editor => fireEditorAction(editor, editor.onExternalEditor)],
		[
			"app.model.selectTemporary",
			editor => CustomEditor.#deferOrFire(editor, "app.model.selectTemporary", editor.onSelectModelTemporary),
		],
		["app.display.reset", editor => fireEditorAction(editor, editor.onDisplayReset)],
		// Manual bash backgrounding — CONDITIONAL consumption: the handler
		// returns false when no foreground command is waiting, and the key
		// falls through to its editor meaning (ctrl+b = readline cursor-left).
		["app.bash.background", editor => editor.onBashBackground?.() === true],
		["app.suspend", editor => fireEditorAction(editor, editor.onSuspend)],
		["app.thinking.toggle", editor => fireEditorAction(editor, editor.onToggleThinking)],
		["app.model.select", editor => CustomEditor.#deferOrFire(editor, "app.model.select", editor.onSelectModel)],
		["app.history.search", editor => fireEditorAction(editor, editor.onHistorySearch)],
		["app.tools.expand", editor => fireEditorAction(editor, editor.onExpandTools)],
		["app.model.cycleBackward", editor => fireEditorAction(editor, editor.onCycleModelBackward)],
		["app.model.cycleForward", editor => fireEditorAction(editor, editor.onCycleModelForward)],
		["app.thinking.cycle", editor => fireEditorAction(editor, editor.onCycleThinkingLevel)],
		// When the autocomplete popup is visible, ESC's first job is to dismiss
		// the popup — let super.handleInput() route it to #cancelAutocomplete().
		// The user can press ESC again afterward to fire the global interrupt
		// handler. This matches the standard TUI/IDE pattern and prevents a
		// single ESC from both closing an @ completion and aborting an active
		// agent run (#1655).
		["app.interrupt", editor => !editor.isShowingAutocomplete() && fireEditorAction(editor, editor.onEscape)],
		["app.clear", editor => fireEditorAction(editor, editor.onClear)],
		// Always consumed so the chord never reaches the parent handler; firing
		// onExit is the controller's chance to snapshot the text as a draft.
		[
			"app.exit",
			editor => {
				editor.onExit?.();
				return true;
			},
		],
		["app.message.dequeue", editor => fireEditorAction(editor, editor.onDequeue)],
		["app.clipboard.copyPrompt", editor => fireEditorAction(editor, editor.onCopyPrompt)],
		[
			"app.retry",
			(editor, canonical) => {
				if (!editor.onRetry) return false;
				const extensionHandler = editor.#customMatchKeys.get(canonical);
				if (extensionHandler) extensionHandler();
				else editor.onRetry();
				return true;
			},
		],
	];

	/**
	 * Register a custom key handler. Extensions use this for shortcuts.
	 */
	setCustomKeyHandler(key: KeyId, handler: () => void): void {
		this.#customKeyHandlers.set(key, handler);
		this.#rebuildCustomMatchKeys();
	}

	/**
	 * Remove a custom key handler.
	 */
	removeCustomKeyHandler(key: KeyId): void {
		this.#customKeyHandlers.delete(key);
		this.#rebuildCustomMatchKeys();
	}

	/**
	 * Clear all custom key handlers.
	 */
	clearCustomKeyHandlers(): void {
		this.#customKeyHandlers.clear();
		this.#rebuildCustomMatchKeys();
	}

	#spaceHoldGestureEnabled(): boolean {
		return this.onSpaceHoldStart !== undefined && (this.sttHoldEnabled?.() ?? false) && !this.isShowingAutocomplete();
	}

	/** Drive the space-hold push-to-talk state machine. Returns true when the gesture consumed the
	 *  input so it must not reach normal editing. A held space bar emits OS auto-repeat: a *steady*
	 *  stream of spaces at a fixed fast interval. We watch the inter-space deltas and only recognize a
	 *  hold once {@link SPACE_HOLD_MECHANICAL_RUN} consecutive deltas are "mechanical" — both
	 *  auto-repeat-fast and near-identical (see {@link gapsAreMechanical}). Smashing the bar is fast
	 *  but jittery and deliberate taps are too slow, so neither escalates and both keep typing real
	 *  spaces; the few spaces typed before a real hold is recognized are tracked back out. */
	#handleSpaceHold(data: string, canonical: string | undefined): boolean {
		const isSpace = canonical === "space";
		if (this.#spaceHoldActive) {
			if (isSpace) {
				// Auto-repeat while held: swallow it and keep the release timer alive.
				this.#armSpaceHoldReleaseTimer();
				return true;
			}
			// Any non-space means the bar was released — stop recording, then let the key through.
			this.#endSpaceHold();
			return false;
		}
		if (!isSpace) {
			this.#resetSpaceRun();
			return false;
		}
		if (!this.#spaceHoldGestureEnabled()) return false;
		const now = performance.now();
		const gap = now - this.#lastSpaceAt;
		const prevGap = this.#prevSpaceGap;
		this.#lastSpaceAt = now;
		this.#prevSpaceGap = gap;
		if (prevGap === undefined || !gapsAreMechanical(gap, prevGap)) {
			// First space, a deliberate tap, or jittery smashing: not a steady machine cadence yet, so
			// type a real space and reset the mechanical run.
			this.#mechanicalRun = 0;
			super.handleInput(data);
			this.#spaceRunInserted++;
			return true;
		}
		// Steady fast repeat: swallow it. Once the cadence has held for SPACE_HOLD_MECHANICAL_RUN
		// deltas it's a held bar — track back the few pre-burst spaces already typed and start.
		if (++this.#mechanicalRun >= SPACE_HOLD_MECHANICAL_RUN) {
			this.deleteBeforeCursor(this.#spaceRunInserted);
			this.#resetSpaceRun();
			this.#beginSpaceHold();
		}
		return true;
	}

	#resetSpaceRun(): void {
		this.#spaceRunInserted = 0;
		this.#mechanicalRun = 0;
		this.#prevSpaceGap = undefined;
		this.#lastSpaceAt = Number.NEGATIVE_INFINITY;
	}

	#beginSpaceHold(): void {
		this.#spaceHoldActive = true;
		this.#armSpaceHoldReleaseTimer();
		this.onSpaceHoldStart?.();
	}

	#armSpaceHoldReleaseTimer(): void {
		if (this.#spaceHoldTimer) clearTimeout(this.#spaceHoldTimer);
		this.#spaceHoldTimer = setTimeout(() => {
			this.#spaceHoldTimer = undefined;
			this.#endSpaceHold();
		}, SPACE_HOLD_RELEASE_MS);
		this.#spaceHoldTimer.unref?.();
	}

	#endSpaceHold(): void {
		if (!this.#spaceHoldActive) return;
		this.#spaceHoldActive = false;
		this.#resetSpaceRun();
		if (this.#spaceHoldTimer) {
			clearTimeout(this.#spaceHoldTimer);
			this.#spaceHoldTimer = undefined;
		}
		this.onSpaceHoldEnd?.();
	}

	/** Decrement {@link #pasteInFlight} once an async paste settles and, when the count returns
	 *  to zero, drain {@link #pendingInput} through `handleInput` so requeueing still works if a
	 *  drained chunk triggers another async paste. Bound member so it can be passed straight to
	 *  `Promise.then(callback, callback)`. */
	#onPasteSettled = (): void => {
		this.#pasteInFlight--;
		if (this.#pasteInFlight > 0) return;
		const drained = this.#pendingInput.splice(0);
		for (const chunk of drained) this.handleInput(chunk);
	};

	/** Track `promise` as an in-flight paste so subsequent `handleInput` calls queue behind it,
	 *  then drain the queue once it settles. Codex PR #3602 review: without this, a trailing
	 *  keystroke (Enter most painfully) in the same stdin read processes synchronously while the
	 *  clipboard read is still pending — submit fires with the text but `pendingImages` is still
	 *  empty and the image lands on the *next* draft instead. */
	#trackAsyncPaste(promise: Promise<unknown>): void {
		this.#pasteInFlight++;
		void promise.then(this.#onPasteSettled, this.#onPasteSettled);
	}

	handleInput(data: string): void {
		this.#draftInputRevision++;
		// Serialize behind any in-flight async paste so a trailing Enter / follow-up key can't
		// submit before the clipboard image reaches `pendingImages` (Codex PR #3602 review).
		if (this.#pasteInFlight > 0) {
			this.#pendingInput.push(data);
			return;
		}

		const initialLines = this.getLines();
		const hadBareQueuePrefix = initialLines.length === 1 && (initialLines[0] === "->" || initialLines[0] === "=>");
		const kittyParsed = parseKittySequence(data);
		if (kittyParsed && (kittyParsed.modifier & 64) !== 0 && this.onCapsLock) {
			// Caps Lock is modifier bit 64
			this.onCapsLock();
			return;
		}

		// Bracketed-paste assembly. Some terminals fragment the start marker,
		// the payload, and the end marker across separate stdin chunks
		// (Windows Terminal under heavy load, certain SSH muxes, …); the
		// inherited handler then sees a zero-length payload and silently
		// drops it through the normal text-insert path. Running our own
		// `BracketedPasteHandler` ahead of `super.handleInput` lets us route
		// the assembled content regardless of chunk boundaries:
		//  - empty payload → `onPasteImage` (#3601: `Cmd+V`/`Ctrl+V` on an
		//    image-only macOS pasteboard the terminal stripped to `""` first);
		//  - explicit image-file paths → `onPasteImagePath` (#3506);
		//  - anything else → the base editor's `pasteText` so `[Paste #N]`
		//    markers, autocomplete, and undo state stay intact.
		const paste = this.#pasteHandler.process(data);
		if (paste.handled) {
			// Bytes that shared this read but preceded the start marker are ordinary typing, not
			// paste content — the handler splits them off as `prefix` for exactly that reason. They
			// were typed before the paste, so they are applied before it. They go through `super`
			// rather than `this` because while a paste is still buffering, re-entering our own
			// handler would append them to the payload being assembled instead of inserting them.
			if (paste.prefix) super.handleInput(paste.prefix);
			if (paste.pasteContent === undefined) return; // still buffering — wait for end marker
			const content = paste.pasteContent;
			const remaining = paste.remaining;
			// Queue any trailing bytes from the same read (typically a follow-up keystroke such as
			// Enter that the user pressed right after Cmd+V) so they only fire *after* the paste
			// completes — fixes the race where submit runs against an empty `pendingImages`.
			if (remaining.length > 0) this.#pendingInput.push(remaining);
			if (content.length === 0 && this.onPasteImage) {
				this.#trackAsyncPaste(Promise.resolve(this.onPasteImage()));
				return;
			}
			const imagePaths = extractImagePastePathsFromText(content);
			if (imagePaths && this.onPasteImagePath) {
				this.#trackAsyncPaste(
					(async () => {
						for (const p of imagePaths) await this.onPasteImagePath?.(p);
					})(),
				);
				return;
			}
			this.pasteText(content);
			// No async paste was started; drain the queued trailing bytes ourselves.
			const drained = this.#pendingInput.splice(0);
			for (const chunk of drained) this.handleInput(chunk);
			return;
		}

		const parsedKey = parseKey(data);
		const canonical = parsedKey !== undefined ? canonicalKeyId(parsedKey) : undefined;

		// Left-arrow on an empty editor: surface for the agent-hub double-tap
		// gesture. Plain "left" only — modified arrows and any in-text cursor
		// movement fall through to normal handling.
		if (canonical === "left" && this.onLeftAtStart && this.getText().trim() === "") {
			this.onLeftAtStart();
			return;
		}

		// Space-hold push-to-talk: a sustained space bar starts/stops STT instead of typing spaces.
		if (this.#handleSpaceHold(data, canonical)) return;

		if (canonical !== undefined) {
			for (const [action, dispatch] of CustomEditor.#ACTION_DISPATCH) {
				if (this.#matchesAction(canonical, action) && dispatch(this, canonical)) return;
			}

			// Check custom key handlers (extensions)
			const handler = this.#customMatchKeys.get(canonical);
			if (handler) {
				handler();
				return;
			}
		}

		// Pass to parent for normal handling
		super.handleInput(data);
		const cursor = this.getCursor();
		if (!hadBareQueuePrefix && cursor.line === 0 && cursor.col === 2) {
			const currentLines = this.getLines();
			if (currentLines.length === 1 && (currentLines[0] === "->" || currentLines[0] === "=>")) {
				this.insertText("\n");
			}
		}
		if (this.onComposerChange) {
			this.onComposerChange(this.getComposerState());
		}
	}
}
