/**
 * Whether an image a tool produced reaches the user's screen, and the sentence
 * that states it to the model.
 *
 * A tool result carrying an image used to say `Read image file [image/png]` and
 * nothing else, so a model that had the picture in its own context reported
 * having shown it — "rendered above", with the user looking at a row of text.
 * The client decides this, not the tool: a session without a graphics protocol,
 * or with `terminal.showImages` off, replaces every picture with a placeholder
 * row, and a piped or headless run draws nothing at all. One owner states it, at
 * the one seam every tool result crosses on its way to the model, so a tool that
 * starts returning images inherits the sentence instead of inventing one.
 */
import type { ImageFallbackReason } from "@veyyon/utils/image-fallback";
import { settingsOrNull } from "../config/settings-instance";

/**
 * Whether the client on the other end of this session puts a picture on screen.
 *
 * The session cannot answer it. A terminal answers from its graphics protocol, a
 * browser or a desktop window answers yes, and a piped `-p` run answers no
 * because it emits text and never draws. So the front end installs the answer,
 * and an uninstalled probe means no: a session nobody claimed draws nothing,
 * which is exactly what a headless run does.
 */
let clientDrawsImages: (() => boolean) | undefined;

/**
 * Front-end hook: state whether this client draws pictures. Called once, when a
 * front end starts, with the capability it has just resolved.
 */
export function setImageDisplayProbe(probe: (() => boolean) | undefined): void {
	clientDrawsImages = probe;
}

/** What the user's terminal does with an image right now. */
export interface ImageDisplayState {
	/** True when a picture reaches the screen rather than a placeholder row. */
	readonly shown: boolean;
	/** Why it does not, when it does not. */
	readonly reason?: ImageFallbackReason;
	/**
	 * How many of the call's pictures the screen never showed, when only some of
	 * them were dropped. Absent means every one of them.
	 */
	readonly undrawnCount?: number;
}

/**
 * The live state. Settings are read through the slot, which is empty in a
 * process that never loaded a config; an unset store leaves the default (images
 * on) in force, so only the client's own capability decides.
 */
export function currentImageDisplayState(): ImageDisplayState {
	if (clientDrawsImages?.() !== true) return { shown: false, reason: "no-protocol" };
	if (settingsOrNull()?.get("terminal.showImages") === false) return { shown: false, reason: "images-off" };
	return { shown: true };
}

/**
 * Pictures a tool call's block decided, after the fact, not to draw.
 *
 * The terminal's protocol and `terminal.showImages` are known before the result
 * is converted, but two causes are settled later and per image, inside the
 * block: the session's image budget demotes an older picture when a newer one
 * arrives, and a Kitty session cannot convert a payload it does not draw. In
 * both cases the user is looking at a placeholder row while the model was told
 * the picture is on screen — the same false premise as saying nothing at all.
 *
 * Bounded to the most recent calls: a session that reads hundreds of images
 * would otherwise keep one entry per call for the life of the process.
 */
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

/**
 * What the user sees of one tool call's images: the live terminal state, unless
 * the call's own block reported that a picture it was asked to draw never
 * reached the screen.
 */
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
	"over-budget": "the session's image budget is full (tui.maxInlineImages)",
	"unsupported-format": "this terminal cannot draw this image format",
};

/**
 * Fixed phrase every notice carries. The scrub that strips images from an
 * outbound request ({@link replaceLlmImagesWithText}) removes the notice with
 * it, so a request whose pictures are gone does not also carry a sentence about
 * where they are. Building and detecting the notice from one constant keeps the
 * two from drifting apart.
 */
const NOTICE_MARKER = "in your context only:";

/**
 * The sentence appended to a tool result that carries images, or `undefined`
 * when the user is looking at the picture and nothing needs saying.
 */
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
