/**
 * Whether an image a tool produced reaches the user's screen, and the sentence
 * that states it to the model.
 *
 * A tool result carrying an image used to say `Read image file [image/png]` and
 * nothing else, so a model that had the picture in its own context reported
 * having shown it — "rendered above", with the user looking at a row of text.
 * The terminal decides this, not the tool: a session without a graphics protocol,
 * or with `terminal.showImages` off, replaces every picture with a placeholder
 * row. One owner states it, at the one seam every tool result crosses on its way
 * to the model, so a tool that starts returning images inherits the sentence
 * instead of inventing one.
 */
import type { ImageFallbackReason } from "@veyyon/tui";
import { TERMINAL } from "@veyyon/tui";
import { settingsOrNull } from "../config/settings-instance";

/** What the user's terminal does with an image right now. */
export interface ImageDisplayState {
	/** True when a picture reaches the screen rather than a placeholder row. */
	readonly shown: boolean;
	/** Why it does not, when it does not. */
	readonly reason?: ImageFallbackReason;
}

/**
 * The live state. Settings are read through the slot, which is empty in a
 * process that never loaded a config; an unset store leaves the default (images
 * on) in force, so only the terminal decides.
 */
export function currentImageDisplayState(): ImageDisplayState {
	if (!TERMINAL.imageProtocol) return { shown: false, reason: "no-protocol" };
	if (settingsOrNull()?.get("terminal.showImages") === false) return { shown: false, reason: "images-off" };
	return { shown: true };
}

const REASON_TEXT: Record<ImageFallbackReason, string> = {
	"no-protocol": "this terminal has no image protocol",
	"images-off": "images are turned off (terminal.showImages)",
	"over-budget": "the session's image budget is full",
	"unsupported-format": "this terminal cannot draw this image format",
};

/**
 * The sentence appended to a tool result that carries images, or `undefined`
 * when the user is looking at the picture and nothing needs saying.
 */
export function imageVisibilityNotice(state: ImageDisplayState, imageCount: number): string | undefined {
	if (state.shown || imageCount < 1 || !state.reason) return undefined;
	const subject = imageCount === 1 ? "This image is" : `These ${imageCount} images are`;
	return `${subject} in your context only: ${REASON_TEXT[state.reason]}, so the user sees a placeholder row instead of the picture. Describe what it shows; do not tell the user you displayed it.`;
}
