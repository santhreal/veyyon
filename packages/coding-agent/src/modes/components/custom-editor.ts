import type { ImageContent } from "@veyyon/ai";
import { canonicalKeyId, Editor, type KeyId, parseKey, parseKittySequence } from "@veyyon/tui";
import { BracketedPasteHandler } from "@veyyon/tui/bracketed-paste";
import { isSettingsInitialized, settings } from "../../config/settings-instance";
import { imageReferenceHyperlink, PLACEHOLDER_REGEX, renderPlaceholders } from "../image-references";
import { hasMagicKeyword, highlightMagicKeywords } from "../magic-keywords";
import { isQueuedMessageList, parseQueueShorthand, QUEUE_LIST_MARKER_RE } from "../queue-input";
import { fgOrPlain, theme } from "../theme/theme";
import type { ConfigurableEditorAction } from "./custom-editor-helpers";
import {
	buildMatchKeys,
	DEFAULT_ACTION_KEYS,
	extractImagePastePathsFromText,
	gapsAreMechanical,
	SPACE_HOLD_MECHANICAL_RUN,
	SPACE_HOLD_RELEASE_MS,
} from "./custom-editor-helpers";

export {
	extractBracketedImagePastePaths,
	extractBracketedPastePaths,
	extractImagePathFromText,
	extractPastePathsFromText,
	SPACE_REPEAT_MAX_GAP_MS,
} from "./custom-editor-helpers";
export { SPACE_HOLD_MECHANICAL_RUN, SPACE_HOLD_RELEASE_MS };

export class CustomEditor extends Editor {
	imageLinks?: readonly (string | undefined)[];

	pendingImages: ImageContent[] = [];
	pendingImageLinks: (string | undefined)[] = [];

	clearDraft(historyText?: string): void {
		if (historyText !== undefined) this.addToHistory(historyText);
		this.setText("");
		this.imageLinks = undefined;
		this.pendingImages = [];
		this.pendingImageLinks = [];
	}

	override atomicTokenPattern = PLACEHOLDER_REGEX;

	static readonly SHIMMER_FRAME_MS = 70;
	static readonly SHIMMER_PERIOD_MS = 1800;

	#shimmerTimer: Timer | undefined;
	#requestShimmerRepaint: (() => void) | undefined;
	#queueDecorationText: string | undefined;
	#queueShorthandActive = false;
	#queueListActive = false;

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

	magicKeywordsEnabledOverride: boolean | undefined;

	#shimmerEnabled(): boolean {
		if (this.magicKeywordsEnabledOverride !== undefined) return this.magicKeywordsEnabledOverride;
		return isSettingsInitialized() ? settings.get("magicKeywords.enabled") : true;
	}

	setShimmerRepaintHandler(handler: (() => void) | undefined): void {
		this.#requestShimmerRepaint = handler;
		if (!handler && this.#shimmerTimer) {
			clearTimeout(this.#shimmerTimer);
			this.#shimmerTimer = undefined;
		}
	}

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
	onBashBackground?: () => boolean;
	onSelectModelTemporary?: () => void;
	onCopyPrompt?: () => void;
	onPasteImage?: () => Promise<boolean>;
	onPasteImagePath?: (path: string) => void | Promise<void>;
	onPasteTextRaw?: () => void;
	onDequeue?: () => void;
	onRetry?: () => void;
	onCapsLock?: () => void;
	onLeftAtStart?: () => void;

	onSpaceHoldStart?: () => void;
	onSpaceHoldEnd?: () => void;
	sttHoldEnabled?: () => boolean;

	#customKeyHandlers = new Map<KeyId, () => void>();
	#customMatchKeys = new Map<string, () => void>();
	#pasteHandler = new BracketedPasteHandler();
	#pasteInFlight = 0;
	#pendingInput: string[] = [];
	#spaceRunInserted = 0;
	#mechanicalRun = 0;
	#prevSpaceGap: number | undefined;
	#lastSpaceAt = Number.NEGATIVE_INFINITY;
	#spaceHoldActive = false;
	#spaceHoldTimer: NodeJS.Timeout | undefined;
	#actionKeys = new Map<ConfigurableEditorAction, KeyId[]>(
		Object.entries(DEFAULT_ACTION_KEYS).map(([action, keys]) => [action as ConfigurableEditorAction, keys.slice()]),
	);
	#actionMatchKeys = new Map<ConfigurableEditorAction, Set<string>>(
		Object.entries(DEFAULT_ACTION_KEYS).map(([action, keys]) => [
			action as ConfigurableEditorAction,
			buildMatchKeys(keys),
		]),
	);
	#actionCallbacks = this.#buildActionCallbacks();

	#buildActionCallbacks(): Map<string, () => unknown> {
		const table = new Map<string, () => unknown>();
		const register = (action: ConfigurableEditorAction, cb: () => unknown) => {
			for (const key of this.#actionMatchKeys.get(action) ?? []) table.set(key, cb);
		};
		register("app.clipboard.pasteImage", () => this.onPasteImage && void this.onPasteImage());
		register("app.clipboard.pasteTextRaw", () => this.onPasteTextRaw?.());
		register("app.editor.external", () => this.onExternalEditor?.());
		register("app.model.selectTemporary", () => this.onSelectModelTemporary?.());
		register("app.display.reset", () => this.onDisplayReset?.());
		register("app.bash.background", () => (this.onBashBackground ? this.onBashBackground() : undefined));
		register("app.suspend", () => this.onSuspend?.());
		register("app.thinking.toggle", () => this.onToggleThinking?.());
		register("app.model.select", () => this.onSelectModel?.());
		register("app.history.search", () => this.onHistorySearch?.());
		register("app.tools.expand", () => this.onExpandTools?.());
		register("app.model.cycleBackward", () => this.onCycleModelBackward?.());
		register("app.model.cycleForward", () => this.onCycleModelForward?.());
		register("app.thinking.cycle", () => this.onCycleThinkingLevel?.());
		register("app.interrupt", () => (this.onEscape && !this.isShowingAutocomplete() ? this.onEscape() : undefined));
		register("app.clear", () => this.onClear?.());
		register("app.exit", () => this.onExit?.());
		register("app.message.dequeue", () => this.onDequeue?.());
		register("app.clipboard.copyPrompt", () => this.onCopyPrompt?.());
		return table;
	}

	setActionKeys(action: ConfigurableEditorAction, keys: KeyId[]): void {
		this.#actionKeys.set(action, keys.slice());
		this.#rebuildActionMatchKeys(action);
	}

	#rebuildActionMatchKeys(action: ConfigurableEditorAction): void {
		this.#actionMatchKeys.set(action, buildMatchKeys(this.#actionKeys.get(action) ?? []));
		this.#actionCallbacks = this.#buildActionCallbacks();
	}

	#rebuildCustomMatchKeys(): void {
		this.#customMatchKeys.clear();
		for (const [keyId, handler] of this.#customKeyHandlers) {
			for (const alias of buildMatchKeys([keyId])) {
				if (!this.#customMatchKeys.has(alias)) this.#customMatchKeys.set(alias, handler);
			}
		}
	}

	#matchesAction(canonical: string | undefined, action: ConfigurableEditorAction): boolean {
		return canonical !== undefined && (this.#actionMatchKeys.get(action)?.has(canonical) ?? false);
	}

	setCustomKeyHandler(key: KeyId, handler: () => void): void {
		this.#customKeyHandlers.set(key, handler);
		this.#rebuildCustomMatchKeys();
	}

	removeCustomKeyHandler(key: KeyId): void {
		this.#customKeyHandlers.delete(key);
		this.#rebuildCustomMatchKeys();
	}

	clearCustomKeyHandlers(): void {
		this.#customKeyHandlers.clear();
		this.#rebuildCustomMatchKeys();
	}

	#spaceHoldGestureEnabled(): boolean {
		return this.onSpaceHoldStart !== undefined && (this.sttHoldEnabled?.() ?? false) && !this.isShowingAutocomplete();
	}

	#handleSpaceHold(data: string, canonical: string | undefined): boolean {
		const isSpace = canonical === "space";
		if (this.#spaceHoldActive) {
			if (isSpace) {
				this.#armSpaceHoldReleaseTimer();
				return true;
			}
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
			this.#mechanicalRun = 0;
			super.handleInput(data);
			this.#spaceRunInserted++;
			return true;
		}
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

	#onPasteSettled = (): void => {
		this.#pasteInFlight--;
		if (this.#pasteInFlight > 0) return;
		const drained = this.#pendingInput.splice(0);
		for (const chunk of drained) this.handleInput(chunk);
	};

	#trackAsyncPaste(promise: Promise<unknown>): void {
		this.#pasteInFlight++;
		void promise.then(this.#onPasteSettled, this.#onPasteSettled);
	}

	handleInput(data: string): void {
		if (this.#pasteInFlight > 0) {
			this.#pendingInput.push(data);
			return;
		}
		const hadBareQueuePrefix = this.getText() === "->" || this.getText() === "=>";
		const kittyParsed = parseKittySequence(data);
		if (kittyParsed && (kittyParsed.modifier & 64) !== 0 && this.onCapsLock) {
			this.onCapsLock();
			return;
		}

		const paste = this.#pasteHandler.process(data);
		if (paste.handled) {
			if (paste.prefix) super.handleInput(paste.prefix);
			if (paste.pasteContent === undefined) return; // still buffering — wait for end marker
			const content = paste.pasteContent;
			const remaining = paste.remaining;
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
			const drained = this.#pendingInput.splice(0);
			for (const chunk of drained) this.handleInput(chunk);
			return;
		}

		const parsedKey = parseKey(data);
		const canonical = parsedKey !== undefined ? canonicalKeyId(parsedKey) : undefined;

		if (canonical === "left" && this.onLeftAtStart && this.getText().trim() === "") {
			this.onLeftAtStart();
			return;
		}

		if (this.#handleSpaceHold(data, canonical)) return;

		if (canonical !== undefined) {
			const callback = this.#actionCallbacks.get(canonical);
			if (callback !== undefined) {
				const result = callback();
				if (result !== false) return;
			}

			if (this.#matchesAction(canonical, "app.retry") && this.onRetry) {
				const customHandler = this.#customMatchKeys.get(canonical);
				if (customHandler) {
					customHandler();
					return;
				}
				this.onRetry();
				return;
			}

			const handler = this.#customMatchKeys.get(canonical);
			if (handler) {
				handler();
				return;
			}
		}

		super.handleInput(data);
		const cursor = this.getCursor();
		if (
			!hadBareQueuePrefix &&
			(this.getText() === "->" || this.getText() === "=>") &&
			cursor.line === 0 &&
			cursor.col === 2
		) {
			this.insertText("\n");
		}
	}
}
