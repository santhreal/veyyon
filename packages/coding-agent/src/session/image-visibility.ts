import type { ImageFallbackReason } from "@veyyon/tui";
import { TERMINAL } from "@veyyon/tui";
import { settingsOrNull } from "../config/settings-instance";

export interface ImageDisplayState {
	readonly shown: boolean;
	readonly reason?: ImageFallbackReason;
	readonly undrawnCount?: number;
}

function currentImageDisplayState(): ImageDisplayState {
	if (!TERMINAL.imageProtocol) return { shown: false, reason: "no-protocol" };
	if (settingsOrNull()?.get("terminal.showImages") === false) return { shown: false, reason: "images-off" };
	return { shown: true };
}

const UNDRAWN_CALL_LIMIT = 64;
const undrawnByCall = new Map<string, Map<number, ImageFallbackReason>>();

export function recordImageDisplay(toolCallId: string, index: number, fallback: ImageFallbackReason | undefined): void {
	const existing = undrawnByCall.get(toolCallId);
	if (!fallback) {
		existing?.delete(index);
		if (existing?.size === 0) undrawnByCall.delete(toolCallId);
		return;
	}
	if (existing) {
		existing.set(index, fallback);
		return;
	}
	if (undrawnByCall.size >= UNDRAWN_CALL_LIMIT) {
		const oldest = undrawnByCall.keys().next();
		if (!oldest.done) undrawnByCall.delete(oldest.value);
	}
	undrawnByCall.set(toolCallId, new Map([[index, fallback]]));
}

function undrawnImagesForCall(toolCallId: string | undefined): ReadonlyMap<number, ImageFallbackReason> {
	return (toolCallId ? undrawnByCall.get(toolCallId) : undefined) ?? EMPTY_UNDRAWN;
}

const EMPTY_UNDRAWN: ReadonlyMap<number, ImageFallbackReason> = new Map();

export function forgetImageDisplays(): void {
	undrawnByCall.clear();
}

export function imageDisplayStateForCall(toolCallId: string | undefined, imageCount: number): ImageDisplayState {
	const live = currentImageDisplayState();
	if (!live.shown) return live;
	const undrawn = undrawnImagesForCall(toolCallId);
	if (undrawn.size === 0) return live;
	const [reason] = undrawn.values();
	return { shown: false, reason, undrawnCount: Math.min(undrawn.size, imageCount) };
}

const REASON_TEXT: Record<ImageFallbackReason, string> = {
	"no-protocol": "this terminal has no image protocol",
	"images-off": "images are turned off (terminal.showImages)",
	"over-budget": "the session's image budget is full",
	"unsupported-format": "this terminal cannot draw this image format",
};

const NOTICE_MARKER = "in your context only:";

export function imageVisibilityNotice(state: ImageDisplayState, imageCount: number): string | undefined {
	if (state.shown || imageCount < 1 || !state.reason) return undefined;
	const undrawn = state.undrawnCount ?? imageCount;
	const subject =
		undrawn < imageCount
			? `${undrawn} of these ${imageCount} images ${undrawn === 1 ? "is" : "are"}`
			: imageCount === 1
				? "This image is"
				: `These ${imageCount} images are`;
	return `${subject} ${NOTICE_MARKER} ${REASON_TEXT[state.reason]}, so the user sees a placeholder row instead of the picture. Describe what it shows; do not tell the user you displayed it.`;
}

export function isImageVisibilityNotice(text: string): boolean {
	return text.includes(NOTICE_MARKER);
}
