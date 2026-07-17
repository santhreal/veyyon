/**
 * Paste lane for the interactive input controller: clipboard image/text
 * pastes, pasted image-path resolution (incl. the Win+Shift+S and macOS
 * Finder clipboard fallbacks), enhanced bracketed paste, and the large-paste
 * menu with its `local://attachment-N` file store.
 */
import * as path from "node:path";
import type { ImageContent } from "@veyyon/pi-ai";
import { isEnoent, logger, sanitizeText } from "@veyyon/pi-utils";
import { settings } from "../../config/settings";
import { resolveLocalRoot } from "../../internal-urls";
import { extractImagePathFromText } from "../../modes/components/custom-editor";
import { materializeImageReferenceLinks } from "../../modes/image-references";
import type { InteractiveModeContext } from "../../modes/types";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type {
	readImageFromClipboard,
	readMacFileUrlsFromClipboard,
	readTextFromClipboard,
} from "../../utils/clipboard";
import { EnhancedPasteController } from "../../utils/enhanced-paste";
import { ensureSupportedImageInput, ImageInputTooLargeError, loadImageInput } from "../../utils/image-loading";
import { resizeImage } from "../../utils/image-resize";

/** Minimal contract for any component that can receive a paste payload directly. */
interface PasteTarget {
	pasteText(text: string): void;
}

export function hasPasteText(value: unknown): value is PasteTarget {
	return typeof value === "object" && value !== null && typeof (value as PasteTarget).pasteText === "function";
}

/** Wrap pasted text in `<attachment>` tags so the model treats it as one quoted block. */
function wrapPasteInAttachmentBlock(content: string): string {
	return `<attachment>\n${content}\n</attachment>`;
}

/** Injectable clipboard reads so tests can drive paste flows without a real clipboard. */
export type PasteClipboard = {
	readImage: typeof readImageFromClipboard;
	readText: typeof readTextFromClipboard;
	readMacFileUrls?: typeof readMacFileUrlsFromClipboard;
};

export class PasteController {
	constructor(
		private ctx: InteractiveModeContext,
		private clipboard: PasteClipboard,
	) {}

	#enhancedPaste?: EnhancedPasteController;
	// Sequential index for `local://attachment-N` references created by large-paste and
	// pasted-file attachments. Seeded from 0 and bumped past existing attachment files.
	#attachmentCounter = 0;

	setupEnhancedPaste(): void {
		if (this.#enhancedPaste) return;

		this.#enhancedPaste = new EnhancedPasteController({
			write: data => this.ctx.ui.terminal.write(data),
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
				await this.normalizeAndInsertPastedImage(image, `Unsupported pasted image format: ${image.mimeType}`);
			},
			showStatus: message => this.ctx.showStatus(message),
		});
		this.ctx.ui.addInputListener(data => (this.#enhancedPaste?.handleInput(data) ? { consume: true } : undefined));
		this.ctx.ui.addStartListener(() => this.#enhancedPaste?.enable());
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

	/** Probe pixel dimensions for the marker label (`[Image #N, WxH]`). Returns undefined when the
	 *  header can't be decoded, so the caller falls back to a bare `[Image #N]`. */
	async #imageDimensions(image: ImageContent): Promise<{ width: number; height: number } | undefined> {
		try {
			const { width, height } = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
			if (width && height) return { width, height };
		} catch {
			// Unknown/corrupt header — fall back to a bare label.
		}
		return undefined;
	}

	async normalizeAndInsertPastedImage(image: ImageContent, unsupportedMessage: string): Promise<boolean> {
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
					error: error instanceof Error ? error.message : String(error),
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
			await this.normalizeAndInsertPastedImage(
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
				// Path resolved but is not a readable image (e.g. a zero-byte or
				// locked transient screenshot file). Prefer the clipboard bytes.
				if (await this.#tryPasteClipboardImage()) return;
				this.ctx.editor.pasteText(path);
				this.ctx.ui.requestRender();
				this.ctx.showStatus("Pasted path is not a supported image");
				return;
			}
			await this.normalizeAndInsertPastedImage(
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
				// #2375: the bracketed paste forwarded by a local terminal carries a
				// path on the *local* filesystem. The bytes may still be on the
				// clipboard (Win+Shift+S), so try those before giving up.
				if (await this.#tryPasteClipboardImage()) return;
				// Over SSH the clipboard lives on the remote host, so the path is
				// genuinely unreachable; pasting it as text would look like the
				// image was attached when nothing was sent. Surface an SSH-aware
				// diagnostic instead. The pasted path is untrusted terminal input —
				// strip control/ANSI/newlines, collapse home to `~`, and bound the
				// displayed length before splicing it into the status string.
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
				return await this.normalizeAndInsertPastedImage(
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
			logger.warn("large-paste menu failed", { error: error instanceof Error ? error.message : String(error) });
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
				error: error instanceof Error ? error.message : String(error),
			});
			this.ctx.editor.insertPaste(text);
			this.ctx.showError("Failed to save paste to a file — pasted inline instead");
		}
	}
}
