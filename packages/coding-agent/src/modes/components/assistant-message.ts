import type { AssistantMessage, ImageContent } from "@veyyon/ai";
import {
	blendHex,
	Container,
	getImageDimensions,
	Image,
	type ImageBudget,
	ImageProtocol,
	imageFallback,
	Markdown,
	Spacer,
	TERMINAL,
	Text,
} from "@veyyon/tui";
import { formatNumber } from "@veyyon/utils";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import chalk from "chalk";
import type { AssistantThinkingRenderer } from "../../extensibility/extensions/types";
import { getMarkdownTheme } from "../../modes/theme/markdown-theme";
import { theme } from "../../modes/theme/theme";
import { getPreviewLines, resolveImageOptions, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { canonicalizeMessage, formatThinkingForDisplay, hasDisplayableThinking } from "../../utils/thinking-display";
import { resolveAssistantErrorPresentation } from "../utils/transcript-render-helpers";
import { type CacheInvalidation, CacheInvalidationMarkerComponent } from "./cache-invalidation-marker";
import { paintHotTail, shimmerPhase } from "./follow";

const MAX_TRANSCRIPT_ERROR_LINES = 8;

const CODE_FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

type ThinkingContentBlock = Extract<AssistantMessage["content"][number], { type: "thinking" }>;
type DisplayThinkingContentBlock = ThinkingContentBlock & { rawThinking?: string };

function resolveThinkingDisplay(block: ThinkingContentBlock, proseOnly: boolean): { text: string; visible: boolean } {
	const rawThinking = (block as DisplayThinkingContentBlock).rawThinking;
	const formatted = rawThinking !== undefined ? block.thinking : formatThinkingForDisplay(block.thinking, proseOnly);
	return {
		text: formatted.trim(),
		visible: hasDisplayableThinking(rawThinking ?? block.thinking, formatted),
	};
}

function containsMermaidFence(text: string): boolean {
	let fence: string | null = null;
	const lines = text.split("\n");
	for (let li = 0; li < lines.length; li++) {
		const line = lines[li]!;
		const fenceMatch = CODE_FENCE_LINE.exec(line);
		if (fence !== null) {
			if (
				fenceMatch &&
				fenceMatch[2]!.trim() === "" &&
				fenceMatch[1]![0] === fence[0] &&
				fenceMatch[1]!.length >= fence.length
			) {
				fence = null;
			}
			continue;
		}
		if (fenceMatch) {
			if (/^mermaid\b/.test(fenceMatch[2]!.trim())) return true;
			fence = fenceMatch[1]!;
		}
	}
	return false;
}

function thinkingPulseFrames(): readonly string[] {
	return theme.getSpinnerFrames("thinking");
}
const THINKING_DOTS_FRAME_MS_MIN = 70;
const THINKING_DOTS_FRAME_MS_MAX = 230;

const SHIMMER_TICK_MS = 1000 / 30;

const SPEED_WINDOW_MS = 3000;
const SPEED_MAX = 200;

class SpeedTracker {
	#observations: Array<{ time: number; rate: number }> = [];

	#prune(now: number): void {
		const threshold = now - SPEED_WINDOW_MS;
		while (this.#observations.length > 0 && this.#observations[0]!.time < threshold) {
			this.#observations.shift();
		}
	}

	observe(rate: number, now = performance.now()): void {
		if (!Number.isFinite(rate) || rate < 0) return;
		this.#observations.push({ time: now, rate: Math.min(rate, SPEED_MAX) });
		this.#prune(now);
	}

	getSpeed(now = performance.now()): number {
		this.#prune(now);
		if (this.#observations.length === 0) return 0;
		let sum = 0;
		for (let oi = 0; oi < this.#observations.length; oi++) sum += this.#observations[oi]!.rate;
		return sum / this.#observations.length;
	}

	reset(): void {
		this.#observations = [];
	}
}

const sharedSpeedTracker = new SpeedTracker();

export function resetThinkingSpeedTracker(): void {
	sharedSpeedTracker.reset();
}

export class AssistantMessageComponent extends Container {
	#contentContainer: Container;
	#markerSlot: Container;
	#lastMessage?: AssistantMessage;
	#toolImagesByCallId = new Map<string, ImageContent[]>();
	#convertedKittyImages = new Map<string, ImageContent>();
	#kittyConversionsInFlight = new Set<string>();
	#transcriptBlockFinalized: boolean;
	#containsMermaidSource = false;
	#errorPinned = false;
	#blockVersion = 0;
	#lastUpdateTransient = false;
	#lastRenderWidth = 0;
	#fastPathKey: string | undefined;
	#fastPathItems:
		| Array<{ md: Markdown; contentIndex: number; blockType: "text" | "thinking"; lastText: string }>
		| undefined;
	#thinkingDots: Text | undefined;
	#thinkingLabel: Text | undefined;
	#thinkingDotsTimer: NodeJS.Timeout | undefined;
	#thinkingDotsFrame = 0;
	#trailActive = false;
	#shimmerTimer: NodeJS.Timeout | undefined;
	#lastTokenCount: number | undefined;
	#lastTokenTime = 0;
	#thinkingTokens = 0;
	#thinkingRateLive = false;

	constructor(
		message?: AssistantMessage,
		private hideThinkingBlock = false,
		private readonly onImageUpdate?: () => void,
		private readonly thinkingRenderers: readonly AssistantThinkingRenderer[] = [],
		private readonly imageBudget?: ImageBudget,
		private proseOnlyThinking = true,
		private readonly requestSelfRender?: () => void,
	) {
		super();
		this.#transcriptBlockFinalized = message !== undefined;

		this.#markerSlot = new Container();
		this.addChild(this.#markerSlot);

		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	setCacheInvalidation(info: CacheInvalidation | undefined): void {
		this.#markerSlot.clear();
		if (info) {
			this.#markerSlot.addChild(new CacheInvalidationMarkerComponent(info));
		}
		this.#blockVersion++;
	}

	override invalidate(): void {
		super.invalidate();
		this.#fastPathKey = undefined;
		this.#fastPathItems = undefined;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	override render(width: number): readonly string[] {
		this.#lastRenderWidth = width;
		const rows = super.render(width);
		if (this.#trailActive) {
			const phase = shimmerPhase(performance.now());
			for (let i = rows.length - 1; i >= 0; i--) {
				const row = rows[i]!;
				if (stripAnsi(row).trim().length > 0) {
					const painted = rows.slice();
					painted[i] = paintHotTail(row, theme, TERMINAL.trueColor, "thinkingText", phase);
					return painted;
				}
			}
		}
		return rows;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
	}

	setProseOnlyThinking(proseOnly: boolean): void {
		this.proseOnlyThinking = proseOnly;
	}

	override dispose(): void {
		this.#stopThinkingAnimation();
		this.#stopShimmer();
		super.dispose();
	}

	#shouldAnimateThinking(message: AssistantMessage): boolean {
		if (!this.hideThinkingBlock || this.#transcriptBlockFinalized) return false;
		let tail: "text" | "thinking" | undefined;
		const blocks = message.content;
		for (let ci = 0; ci < blocks.length; ci++) {
			const content = blocks[ci]!;
			if (content.type === "toolCall") return false;
			if (content.type === "text" && canonicalizeMessage(content.text)) tail = "text";
			else if (content.type === "thinking" && canonicalizeMessage(content.thinking)) tail = "thinking";
		}
		return tail === "thinking";
	}

	#thinkingDotsLabel(): string {
		const frames = thinkingPulseFrames();
		const glyph = frames[this.#thinkingDotsFrame % frames.length] ?? "…";
		const coloredGlyph = theme.fg("thinkingText", glyph);
		const thinkingLabel = theme.fg("muted", " Thinking");
		const rate = Math.min(SPEED_MAX, sharedSpeedTracker.getSpeed());
		if (!this.#thinkingRateLive || rate < 0.05) return coloredGlyph + thinkingLabel;
		const totalSpan = this.#thinkingTokens > 0 ? theme.fg("dim", ` · ${formatNumber(this.#thinkingTokens)}`) : "";
		const ratio = Math.sqrt(rate / SPEED_MAX);
		const hex = blendHex(theme.getColorHex("dim"), theme.getAccentColorHex(), ratio);
		const rateText = ` · ${rate.toFixed(1)} toks/s`;
		const rateSpan = theme.getColorMode() === "truecolor" ? chalk.hex(hex)(rateText) : theme.fg("muted", rateText);
		return coloredGlyph + thinkingLabel + totalSpan + rateSpan;
	}

	#startThinkingAnimation(): void {
		if (this.#thinkingDotsTimer) return;
		this.#scheduleThinkingFrame();
	}

	#thinkingDotsFrameDelay(): number {
		const frameCount = thinkingPulseFrames().length;
		const phase = (1 - Math.cos((2 * Math.PI * this.#thinkingDotsFrame) / frameCount)) / 2;
		return THINKING_DOTS_FRAME_MS_MIN + (THINKING_DOTS_FRAME_MS_MAX - THINKING_DOTS_FRAME_MS_MIN) * phase;
	}

	#scheduleThinkingFrame(): void {
		if (thinkingPulseFrames().length <= 1) return;
		this.#thinkingDotsTimer = setTimeout(() => this.#advanceThinkingDots(), this.#thinkingDotsFrameDelay());
		this.#thinkingDotsTimer.unref?.();
	}

	#advanceThinkingDots(): void {
		this.#thinkingDotsTimer = undefined;
		if (!this.#thinkingDots) {
			this.#stopThinkingAnimation();
			return;
		}
		this.#thinkingDotsFrame = (this.#thinkingDotsFrame + 1) % thinkingPulseFrames().length;
		if (this.#thinkingDots.setText(this.#thinkingDotsLabel())) {
			this.onImageUpdate?.();
		}
		this.#scheduleThinkingFrame();
	}

	#stopThinkingAnimation(): void {
		if (this.#thinkingDotsTimer) {
			clearTimeout(this.#thinkingDotsTimer);
			this.#thinkingDotsTimer = undefined;
		}
		this.#thinkingDotsFrame = 0;
	}

	#syncShimmer(): void {
		if (this.#trailActive && TERMINAL.trueColor) this.#startShimmer();
		else this.#stopShimmer();
	}

	#startShimmer(): void {
		if (this.#shimmerTimer) return;
		const repaint = this.requestSelfRender ?? this.onImageUpdate;
		this.#shimmerTimer = setInterval(() => repaint?.(), SHIMMER_TICK_MS);
		this.#shimmerTimer.unref?.();
	}

	#stopShimmer(): void {
		if (!this.#shimmerTimer) return;
		clearInterval(this.#shimmerTimer);
		this.#shimmerTimer = undefined;
	}

	setErrorPinned(pinned: boolean): void {
		if (this.#errorPinned === pinned) return;
		this.#errorPinned = pinned;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#transcriptBlockFinalized;
	}

	getTranscriptBlockSettledRows(): number {
		if (this.#transcriptBlockFinalized || !this.#lastUpdateTransient) return 0;
		if (this.#containsMermaidSource) return 0;
		if (this.#markerSlot.children.length > 0) return 0;
		const items = this.#fastPathItems;
		const width = this.#lastRenderWidth;
		if (!items || items.length === 0 || width <= 0) return 0;
		const streaming = items[items.length - 1]!.md;
		let itemIndex = 0;
		let settled = 0;
		const children = this.#contentContainer.children;
		for (let ci = 0; ci < children.length; ci++) {
			const child = children[ci]!;
			if (child === streaming) return settled + streaming.getLastRenderSettledRows();
			if (itemIndex < items.length - 1 && items[itemIndex]!.md === child) {
				itemIndex++;
				settled += child.render(width).length;
				continue;
			}
			if (child instanceof Spacer) {
				settled += child.render(width).length;
				continue;
			}
			if (child === this.#thinkingLabel) {
				settled += child.render(width).length;
				continue;
			}
			return settled;
		}
		return settled;
	}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}

	markTranscriptBlockFinalized(): void {
		this.#transcriptBlockFinalized = true;
		this.#stopThinkingAnimation();
		this.#trailActive = false;
		this.#stopShimmer();
		if (this.#thinkingDots) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			if (this.#lastMessage) this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	applyRetryRecovery(retryRecovery: AssistantMessage["retryRecovery"]): void {
		if (!this.#lastMessage || !retryRecovery) return;
		this.setErrorPinned(false);
		this.updateContent({ ...this.#lastMessage, retryRecovery });
	}

	messagePersistenceKey(): string | undefined {
		if (!this.#lastMessage) return undefined;
		return `assistant:${this.#lastMessage.timestamp}:${this.#lastMessage.provider}:${this.#lastMessage.model}:${this.#lastMessage.responseId ?? ""}:${this.#lastMessage.stopReason}`;
	}

	#appendErrorBlock(message: string): void {
		const lines = getPreviewLines(message, MAX_TRANSCRIPT_ERROR_LINES, TRUNCATE_LENGTHS.LINE);
		if (lines.length === 0) lines.push("Unknown error");
		this.#contentContainer.addChild(new Text(theme.fg("error", `Error: ${lines[0]}`), 1, 0));
		for (const line of lines.slice(1)) {
			this.#contentContainer.addChild(new Text(theme.fg("error", `  ${line}`), 1, 0));
		}
	}

	setToolResultImages(toolCallId: string, images: ImageContent[]): void {
		if (!toolCallId) return;
		const validImages = images.filter(img => img.type === "image" && img.data && img.mimeType);
		for (const key of this.#convertedKittyImages.keys()) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#convertedKittyImages.delete(key);
			}
		}
		for (const key of this.#kittyConversionsInFlight) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#kittyConversionsInFlight.delete(key);
			}
		}
		if (validImages.length === 0) {
			this.#toolImagesByCallId.delete(toolCallId);
		} else {
			this.#toolImagesByCallId.set(toolCallId, validImages);
			this.#convertToolImagesForKitty(toolCallId, validImages);
		}
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	#convertToolImagesForKitty(toolCallId: string, images: ImageContent[]): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (let index = 0; index < images.length; index++) {
			const image = images[index];
			if (!image || image.mimeType === "image/png") continue;
			const key = `${toolCallId}:${index}`;
			if (this.#convertedKittyImages.has(key) || this.#kittyConversionsInFlight.has(key)) continue;
			this.#kittyConversionsInFlight.add(key);
			new Bun.Image(Buffer.from(image.data, "base64"))
				.png()
				.toBase64()
				.then(data => {
					this.#kittyConversionsInFlight.delete(key);
					this.#convertedKittyImages.set(key, {
						type: "image",
						data,
						mimeType: "image/png",
					});
					if (this.#lastMessage) {
						this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
					}
					this.onImageUpdate?.();
				})
				.catch(() => {
					this.#kittyConversionsInFlight.delete(key);
				});
		}
	}

	#renderToolImages(): void {
		const imageEntries: { image: ImageContent; key: string }[] = [];
		for (const [toolCallId, images] of this.#toolImagesByCallId.entries()) {
			for (let ii = 0; ii < images.length; ii++) {
				imageEntries.push({ image: images[ii]!, key: `${toolCallId}:${ii}` });
			}
		}
		if (imageEntries.length === 0) return;

		this.#contentContainer.addChild(new Spacer(1));
		for (let ei = 0; ei < imageEntries.length; ei++) {
			const { image, key } = imageEntries[ei]!;
			const displayImage =
				TERMINAL.imageProtocol === ImageProtocol.Kitty && image.mimeType !== "image/png"
					? this.#convertedKittyImages.get(key)
					: image;
			if (TERMINAL.imageProtocol && displayImage) {
				this.#contentContainer.addChild(
					new Image(
						displayImage.data,
						displayImage.mimeType,
						{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
						{ ...resolveImageOptions(), budget: this.imageBudget, imageKey: key },
					),
				);
				continue;
			}
			const dims = image.data ? (getImageDimensions(image.data, image.mimeType) ?? undefined) : undefined;
			const placeholder = imageFallback({
				mimeType: image.mimeType,
				dimensions: dims,
				reason: TERMINAL.imageProtocol ? "images-off" : "no-protocol",
			});
			this.#contentContainer.addChild(new Text(theme.fg("toolOutput", placeholder), 1, 0));
		}
	}

	#appendThinkingExtensions(contentIndex: number, thinkingIndex: number, text: string): void {
		for (let ri = 0; ri < this.thinkingRenderers.length; ri++) {
			const renderer = this.thinkingRenderers[ri]!;
			try {
				const component = renderer(
					{
						contentIndex,
						thinkingIndex,
						text,
						requestRender: () => this.onImageUpdate?.(),
					},
					theme,
				);
				if (component) {
					this.#contentContainer.addChild(component);
				}
			} catch {}
		}
	}

	#computeShapeKey(message: AssistantMessage): string {
		const parts: string[] = [`htb:${this.hideThinkingBlock ? 1 : 0}|pot:${this.proseOnlyThinking ? 1 : 0}`];
		const blocks = message.content;
		for (let ci = 0; ci < blocks.length; ci++) {
			const content = blocks[ci]!;
			if (content.type === "text") {
				parts.push(canonicalizeMessage(content.text) ? "T1" : "T0");
			} else if (content.type === "thinking") {
				const display = resolveThinkingDisplay(content, this.proseOnlyThinking);
				if (!display.visible) parts.push("K0");
				else if (this.hideThinkingBlock) parts.push("KH");
				else parts.push("KV");
			} else {
				parts.push(`O:${content.type}`);
			}
		}
		return parts.join("|");
	}

	#canFastPath(message: AssistantMessage): boolean {
		const blocks = message.content;
		for (let ci = 0; ci < blocks.length; ci++) {
			if (blocks[ci]!.type === "toolCall") return false;
		}
		if (this.#toolImagesByCallId.size > 0) return false;
		const errorPresentation = resolveAssistantErrorPresentation(message);
		if (errorPresentation.kind === "compact-recovered") return false;
		if (errorPresentation.kind === "full" && !(message.stopReason === "error" && this.#errorPinned)) {
			return false;
		}
		if (this.thinkingRenderers.length > 0 && this.#fastPathItems) {
			for (let fi = 0; fi < this.#fastPathItems.length; fi++) {
				const item = this.#fastPathItems[fi]!;
				if (item.blockType === "thinking") {
					const content = message.content[item.contentIndex];
					if (content?.type === "thinking") {
						const display = resolveThinkingDisplay(content, this.proseOnlyThinking);
						if (display.text !== item.lastText) return false;
					}
				}
			}
		}
		return true;
	}

	#tryFastPathUpdate(message: AssistantMessage, opts?: { transient?: boolean }): boolean {
		if (!this.#fastPathKey || !this.#fastPathItems) return false;
		if (!this.#canFastPath(message)) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			return false;
		}
		if (this.#computeShapeKey(message) !== this.#fastPathKey) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			return false;
		}
		const transient = opts?.transient === true;
		this.#applyItemTransience(transient);
		for (let i = 0; i < this.#fastPathItems.length; i++) {
			const item = this.#fastPathItems[i]!;
			const content = message.content[item.contentIndex];
			if (!content) {
				this.#fastPathKey = undefined;
				this.#fastPathItems = undefined;
				return false;
			}
			let newText: string;
			if (item.blockType === "text" && content.type === "text") {
				newText = content.text.trim();
			} else if (item.blockType === "thinking" && content.type === "thinking") {
				newText = resolveThinkingDisplay(content, this.proseOnlyThinking).text;
			} else {
				this.#fastPathKey = undefined;
				this.#fastPathItems = undefined;
				return false;
			}
			if (newText !== item.lastText) {
				if (i < this.#fastPathItems.length - 1) {
					this.#fastPathKey = undefined;
					this.#fastPathItems = undefined;
					return false;
				}
				item.md.setText(newText);
				item.lastText = newText;
			}
		}
		if (this.#thinkingDots) {
			if (this.#thinkingDots.setText(this.#thinkingDotsLabel())) {
				this.onImageUpdate?.();
			}
		}
		return true;
	}

	#shouldPaintTrail(message: AssistantMessage): boolean {
		if (!this.#lastUpdateTransient || this.#transcriptBlockFinalized) return false;
		for (let ci = 0; ci < message.content.length; ci++) {
			if (message.content[ci]!.type === "toolCall") return false;
		}
		return true;
	}

	updateContent(message: AssistantMessage, opts?: { transient?: boolean }): void {
		this.#blockVersion++;
		this.#lastMessage = message;
		this.#lastUpdateTransient = opts?.transient === true;
		this.#trailActive = this.#shouldPaintTrail(message);
		this.#syncShimmer();

		const isThinkingNow = this.#lastUpdateTransient && this.#shouldAnimateThinking(message);
		if (isThinkingNow) {
			const currentTokens = message.usage.reasoningTokens ?? message.usage.output;
			this.#thinkingTokens = currentTokens;
			const now = performance.now();
			if (this.#lastTokenCount !== undefined) {
				const tokenDelta = currentTokens - this.#lastTokenCount;
				const elapsedMs = now - this.#lastTokenTime;
				if (tokenDelta > 0 && elapsedMs > 0) {
					if (!this.#thinkingRateLive) sharedSpeedTracker.reset();
					sharedSpeedTracker.observe((tokenDelta / elapsedMs) * 1000, now);
					this.#thinkingRateLive = true;
				}
			}
			this.#lastTokenCount = currentTokens;
			this.#lastTokenTime = now;
		} else {
			this.#lastTokenCount = undefined;
			this.#thinkingTokens = 0;
			this.#thinkingRateLive = false;
		}

		let containsMermaid = false;
		for (let ci = 0; ci < message.content.length; ci++) {
			const content = message.content[ci]!;
			if (content.type === "text") {
				if (containsMermaidFence(content.text)) {
					containsMermaid = true;
					break;
				}
			} else if (content.type === "thinking" && !this.hideThinkingBlock) {
				const display = resolveThinkingDisplay(content, this.proseOnlyThinking);
				if (display.visible && containsMermaidFence(display.text)) {
					containsMermaid = true;
					break;
				}
			}
		}
		this.#containsMermaidSource = containsMermaid;

		if (this.#tryFastPathUpdate(message, opts)) return;

		this.#contentContainer.clear();
		this.#thinkingDots = undefined;
		this.#thinkingLabel = undefined;

		const shouldCapture = this.#canFastPath(message);
		const captureItems:
			| Array<{ md: Markdown; contentIndex: number; blockType: "text" | "thinking"; lastText: string }>
			| undefined = shouldCapture ? [] : undefined;

		let hasVisibleContent = false;
		for (let vci = 0; vci < message.content.length; vci++) {
			const c = message.content[vci]!;
			if (c.type === "text" && canonicalizeMessage(c.text)) {
				hasVisibleContent = true;
				break;
			}
			if (
				!this.hideThinkingBlock &&
				c.type === "thinking" &&
				resolveThinkingDisplay(c, this.proseOnlyThinking).visible
			) {
				hasVisibleContent = true;
				break;
			}
		}

		let thinkingIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && canonicalizeMessage(content.text)) {
				const trimmed = content.text.trim();
				const md = new Markdown(trimmed, 2, 0, getMarkdownTheme(), {
					color: (text: string) => theme.fg("text", text),
				});
				md.transientRenderCache = this.#lastUpdateTransient;
				this.#contentContainer.addChild(md);
				captureItems?.push({ md, contentIndex: i, blockType: "text", lastText: trimmed });
			} else if (content.type === "thinking" && resolveThinkingDisplay(content, this.proseOnlyThinking).visible) {
				const thinkingText = resolveThinkingDisplay(content, this.proseOnlyThinking).text;
				if (this.hideThinkingBlock) {
					thinkingIndex += 1;
					continue;
				}
				let hasVisibleContentAfter = false;
				for (let k = i + 1; k < message.content.length; k++) {
					const c = message.content[k]!;
					if (
						(c.type === "text" && canonicalizeMessage(c.text)) ||
						(c.type === "thinking" && resolveThinkingDisplay(c, this.proseOnlyThinking).visible)
					) {
						hasVisibleContentAfter = true;
						break;
					}
				}

				if (thinkingIndex === 0) {
					this.#thinkingLabel = new Text(theme.fg("muted", "Thinking"), 2, 0);
					this.#contentContainer.addChild(this.#thinkingLabel);
				}
				const md = new Markdown(thinkingText, 2, 0, getMarkdownTheme(), {
					color: (text: string) => theme.fg("thinkingText", text),
					italic: true,
				});
				md.transientRenderCache = this.#lastUpdateTransient;
				this.#contentContainer.addChild(md);
				captureItems?.push({ md, contentIndex: i, blockType: "thinking", lastText: thinkingText });
				this.#appendThinkingExtensions(i, thinkingIndex, thinkingText);
				thinkingIndex += 1;
				if (hasVisibleContentAfter) {
					this.#contentContainer.addChild(new Spacer(1));
				}
			}
		}

		if (this.#shouldAnimateThinking(message)) {
			if (hasVisibleContent) this.#contentContainer.addChild(new Spacer(1));
			this.#thinkingDots = new Text(this.#thinkingDotsLabel(), 1, 0);
			this.#contentContainer.addChild(this.#thinkingDots);
			this.#startThinkingAnimation();
		} else {
			this.#stopThinkingAnimation();
		}

		this.#renderToolImages();
		const errorPresentation = resolveAssistantErrorPresentation(message);
		if (errorPresentation.kind === "compact-recovered") {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("dim", errorPresentation.text), 1, 0));
		} else if (errorPresentation.kind === "full") {
			if (!(message.stopReason === "error" && this.#errorPinned)) {
				this.#contentContainer.addChild(new Spacer(1));
				if (message.stopReason === "aborted") {
					this.#contentContainer.addChild(new Text(theme.fg("error", errorPresentation.text), 1, 0));
				} else {
					this.#appendErrorBlock(errorPresentation.text);
				}
			}
		}
		if (shouldCapture) {
			this.#fastPathItems = captureItems;
			this.#fastPathKey = this.#computeShapeKey(message);
			this.#applyItemTransience(this.#lastUpdateTransient);
		} else {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
		}
	}

	#applyItemTransience(transient: boolean): void {
		const items = this.#fastPathItems;
		if (!items) return;
		for (let i = 0; i < items.length; i++) {
			items[i]!.md.transientRenderCache = transient && i === items.length - 1;
		}
	}
}
