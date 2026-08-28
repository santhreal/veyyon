/**
 * Why a client did not draw a picture it was given.
 *
 * The vocabulary is shared rather than owned by a renderer: the session states
 * the reason to the model, and a front end draws the placeholder that stands in
 * for the picture. Both have to name the same four causes, and a session that
 * cannot import a renderer — a headless run, a browser client, a graphical
 * front end — still has to say which one applies.
 */

/**
 * The vocabulary as a value, so a check can sweep it. A union alone cannot be
 * enumerated at run time, and the failure that costs is a fifth cause added with
 * one of the two surfaces left without a sentence for it.
 */
export const IMAGE_FALLBACK_REASONS = ["no-protocol", "images-off", "over-budget", "unsupported-format"] as const;

export type ImageFallbackReason = (typeof IMAGE_FALLBACK_REASONS)[number];
