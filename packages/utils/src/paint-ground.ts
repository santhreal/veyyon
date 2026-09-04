/**
 * Painted-ground decision logic: whether the TUI should paint the theme's
 * ground color over the terminal's own background, and the OSC 11 sequences
 * that set/reset the terminal background so the emulator's padding margin
 * matches the painted cell grid.
 *
 * The contract (docs/internal/design.md "Color"): `auto` paints only when the
 * seam would be invisible — the terminal's reported background is already
 * within {@link PAINT_GROUND_AUTO_TOLERANCE} of the theme ground. A terminal
 * that reports a different background (or none at all) keeps its own ground,
 * loudly visible in doctor output rather than silently overridden.
 */

/** Tier A knob (`tui.paintGround`): paint policy for the theme ground. */
export type PaintGroundSetting = "auto" | "always" | "never";

/**
 * Maximum RGB distance (Euclidean, 0–441) between terminal background and
 * theme ground under which `auto` considers painting seamless. 32 admits
 * near-black variations (#000000 vs #0E0E10) while rejecting every themed
 * terminal ground (Dracula #282A36 is ~62 from black).
 */
export const PAINT_GROUND_AUTO_TOLERANCE = 32;

/** Parse `#RRGGBB` into channels; null for anything else (fail closed). */
export function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
	const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
	if (!match) return null;
	const value = parseInt(match[1]!, 16);
	return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

/**
 * Scale an OSC color-reply channel (1–4 hex digits, e.g. `1e1e` in
 * `rgb:1e1e/1e1e/2e2e`) to 8-bit. Terminals report each channel at their own
 * bit depth; the value is a fraction of that channel's maximum.
 */
export function oscChannelTo8Bit(hexChannel: string): number {
	const value = parseInt(hexChannel, 16);
	if (Number.isNaN(value)) return 0;
	const max = 16 ** hexChannel.length - 1;
	return max > 0 ? Math.round((value / max) * 255) : 0;
}

/** Euclidean RGB distance between two `#RRGGBB` colors; Infinity if unparsable. */
export function colorDistance(aHex: string, bHex: string): number {
	const a = parseHexColor(aHex);
	const b = parseHexColor(bHex);
	if (!a || !b) return Number.POSITIVE_INFINITY;
	return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/**
 * Decide whether to paint the theme ground.
 *
 * - `always` → paint unconditionally.
 * - `never` → inherit the terminal ground unconditionally.
 * - `auto` → paint only when the terminal reported its background (OSC 11)
 *   and it already sits within {@link PAINT_GROUND_AUTO_TOLERANCE} of the
 *   theme ground, so painting cannot produce a visible seam against the
 *   emulator's padding margin. No report → inherit (today's behavior).
 */
export function resolvePaintGround(
	setting: PaintGroundSetting,
	themeGroundHex: string,
	terminalBackgroundHex: string | undefined,
): boolean {
	switch (setting) {
		case "always":
			return true;
		case "never":
			return false;
		case "auto":
			if (terminalBackgroundHex === undefined) return false;
			return colorDistance(themeGroundHex, terminalBackgroundHex) <= PAINT_GROUND_AUTO_TOLERANCE;
	}
}

/**
 * What the painted-ground consumer should do this frame.
 *
 * - `{ paint: "#RRGGBB" }` → set the terminal background to that color.
 * - `{ paint: null }` → leave the terminal background alone (reset any paint
 *   this session applied). `unhonoredAlways` is true only when the user asked
 *   for `always` but the theme declares no ground, so the consumer can say so
 *   rather than silently do nothing (Law 10).
 */
export interface PaintGroundPlan {
	paint: string | null;
	unhonoredAlways: boolean;
}

/**
 * Decide the painted-ground action from the policy, the theme's declared ground
 * color, and the terminal's own background.
 *
 * The theme ground is `undefined` when the active theme declares none (a user
 * theme without an `export.pageBg`). Painting then would mean inventing a color,
 * which would recolor the terminal a shade the theme never chose, so this
 * inherits the terminal background instead. `always` is the one case where the
 * user explicitly asked to paint and cannot be honored, so it is flagged for the
 * caller to surface rather than swallow.
 *
 * This is the pure decision; the caller performs the OSC 11 write. It composes
 * {@link resolvePaintGround} so the auto-seam rule lives in exactly one place.
 */
export function planPaintGround(
	setting: PaintGroundSetting,
	themeGroundHex: string | undefined,
	terminalBackgroundHex: string | undefined,
): PaintGroundPlan {
	if (themeGroundHex === undefined) {
		return { paint: null, unhonoredAlways: setting === "always" };
	}
	const shouldPaint = resolvePaintGround(setting, themeGroundHex, terminalBackgroundHex);
	return { paint: shouldPaint ? themeGroundHex : null, unhonoredAlways: false };
}

/** OSC 11 set-background sequence for a `#RRGGBB` color (BEL terminated). */
export function osc11SetBackgroundSequence(hex: string): string | null {
	const rgb = parseHexColor(hex);
	if (!rgb) return null;
	const channel = (v: number) => v.toString(16).padStart(2, "0");
	return `\x1b]11;rgb:${channel(rgb.r)}/${channel(rgb.g)}/${channel(rgb.b)}\x07`;
}

/** OSC 111: reset the terminal background to its configured default. */
export const OSC11_RESET_BACKGROUND_SEQUENCE = "\x1b]111\x07";
