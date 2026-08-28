/** Whether an image a tool produced reaches the user's screen, and the sentence that states it to the model. */
import type { ImageFallbackReason } from "@veyyon/tui";
import { TERMINAL } from "@veyyon/tui";
import { settingsOrNull } from "../config/settings-instance";

/** What the user's terminal does with an image right now. */
export interface ImageDisplayState {
	/** True when a picture reaches the screen rather than a placeholder row. */
	readonly shown: boolean;
	/** Why it does not, when it does not. */
	readonly reason?: ImageFallbackReason;
	/** How many of the call's pictures the screen never showed, when only some of them were dropped. Absent means every one of them. */
	readonly undrawnCount?: number;
}

/** The live state. Settings are read through the slot, which is empty in a process that never loaded a config; an unset store leaves the default (images */
export function currentImageDisplayState(): ImageDisplayState {
	if (!TERMINAL.imageProtocol) return { shown: false, reason: "no-protocol" };
	if (settingsOrNull()?.get("terminal.showImages") === false) return { shown: false, reason: "images-off" };
	return { shown: true };
}

/** Pictures a tool call's block decided, after the fact, not to draw. The terminal's protocol and `terminal.showImages` are known before the result */
const UNDRAWN_CALL_LIMIT = 64;
const undrawnByCall = new Map<string, Map<number, ImageFallbackReason>>();

/** Record, or clear, what a block did with one image of one tool call. */
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

/** Every image of `toolCallId` a block reported as undrawn, by image index. */
export function undrawnImagesForCall(toolCallId: string | undefined): ReadonlyMap<number, ImageFallbackReason> {
	return (toolCallId ? undrawnByCall.get(toolCallId) : undefined) ?? EMPTY_UNDRAWN;
}

const EMPTY_UNDRAWN: ReadonlyMap<number, ImageFallbackReason> = new Map();

/** Drop every recorded decision. A new session starts with no history of one. */
export function forgetImageDisplays(): void {
	undrawnByCall.clear();
}

/** What the user sees of one tool call's images: the live terminal state, unless the call's own block reported that a picture it was asked to draw never */
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

/** Fixed phrase every notice carries. The scrub that strips images from an outbound request ({@link replaceLlmImagesWithText}) removes the notice with */
const NOTICE_MARKER = "in your context only:";

/** The sentence appended to a tool result that carries images, or `undefined` when the user is looking at the picture and nothing needs saying. */
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

/** True for a text block {@link imageVisibilityNotice} produced. */
export function isImageVisibilityNotice(text: string): boolean {
	return text.includes(NOTICE_MARKER);
}
