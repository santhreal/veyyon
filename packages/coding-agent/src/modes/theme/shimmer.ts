import { clamp01 } from "@veyyon/utils";
import { isSettingsInitialized, settings } from "../../config/settings";
import type { Theme, ThemeColor } from "./theme";

// ─── Animation velocity ──────────────────────────────────────────────────────
// Band/head travel speed in border cells per second. Driving position by a fixed
// velocity — instead of dividing a fixed sweep duration by the (length-derived)
// period — makes smoothness independent of message length: at the loader's
// default 30fps redraw cadence the band advances ≤1 cell per frame for any
// string, so it never visibly steps. Sweep/round-trip durations now scale with
// length. Keep ≤ the animated redraw fps (loader RENDER_INTERVAL_MS = 1000/30).
const SHIMMER_SPEED_CELLS_PER_S = 30;

// ─── Classic sweep tunables ──────────────────────────────────────────────────
const CLASSIC_PADDING = 10;
const CLASSIC_BAND_HALF_WIDTH = 6;

// ─── KITT scanner tunables ───────────────────────────────────────────────────
const KITT_HEAD_HALF = 0.6;
const KITT_TRAIL_LEN = 7;

// ─── Comet tunables (living "streaming" motion) ──────────────────────────────
// A single bright head runs left → right with an exponential luminance trail
// behind it and nothing ahead — a directional "text is being written" feel,
// distinct from the symmetric classic bump. Head speed is its own knob so the
// stream comet can read faster than the ambient classic sweep.
const COMET_SPEED_CELLS_PER_S = 26;
const COMET_TRAIL_LEN = 8;
const COMET_LEAD_PAD = 8;

// ─── Living-mode motion timings ──────────────────────────────────────────────
// Breath periods (ms) for the two unison-pulse motions. Ponder (thinking) can
// dim toward the floor and carries a faint per-char ripple so it reads as
// "reasoning"; await (your turn) holds a high floor and never goes dark so the
// line reads as present and waiting rather than working.
const PONDER_PERIOD_MS = 850;
const PONDER_RIPPLE_PERIOD_MS = 560;
// Drift (idle / resting): a slow luminance wave travels ALONG the line like a
// calm tide, instead of the whole rule breathing in unison. This is the state
// the user stares at most, so at rest the horizon must still visibly move — the
// crest crosses the TIER_HIGH threshold (lighting the silver `text` token) and
// the trough drops below TIER_MID (back to `dim`), so a band of light glides
// across a mostly-dim rule. DRIFT_WAVELENGTH sets how many crests share the line
// at once (smaller = longer, calmer swell); DRIFT_PERIOD_MS how long one crest
// takes to cross a cell.
const DRIFT_PERIOD_MS = 2600;
const DRIFT_WAVELENGTH = 0.42;
const DRIFT_FLOOR = 0.1;
const AWAIT_PERIOD_MS = 1050;
const AWAIT_FLOOR = 0.4;
// Done "wipe": one head passes across in WIPE_SWEEP_MS, then the line settles
// lit and still at WIPE_SETTLE.
const WIPE_SWEEP_MS = 650;
const WIPE_SETTLE = 0.8;
// Error "blink": two sharp full-line pulses, then settle so the banner beneath
// carries the detail. BLINK_PERIOD_MS is one on/off cycle; BLINK_ON_MS the lit
// slice of it; the pulses stop after BLINK_SETTLE_MS.
const BLINK_PERIOD_MS = 640;
const BLINK_ON_MS = 190;
const BLINK_SETTLE_MS = 1300;
const BLINK_SETTLE = 0.55;
const BLINK_OFF = 0.22;

// ─── Tier thresholds ─────────────────────────────────────────────────────────
const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

// ─── Raw ANSI codes ──────────────────────────────────────────────────────────
const FG_RESET = "\x1b[39m";
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";

type ShimmerTheme = Pick<Theme, "bold" | "fg" | "getFgAnsi">;
type ShimmerMode = "classic" | "kitt" | "living" | "disabled";

/**
 * What the agent is doing right now. In `living` mode the working line's
 * motion *and* color are chosen from this — a signal you read without reading
 * the words. States map to real lifecycle transitions the agent already emits
 * (see event-controller wiring); `idle` is the resting fallback.
 */
export type ShimmerActivity = "idle" | "thinking" | "streaming" | "tool" | "ask" | "done" | "error";

/**
 * Motion character of a living state. These are genuinely different shapes,
 * not one sweep recolored:
 *  - `drift`   a slow luminance wave glides along the line (idle / resting)
 *  - `ponder`  slow unison breath with a faint per-char ripple (reasoning)
 *  - `comet`   a bright head runs forward with an exponential trail (writing)
 *  - `scan`    a head ping-pongs across the line (a tool executing) — reuses KITT
 *  - `await`   a steady green breath, high floor, going nowhere (your turn)
 *  - `wipe`    a single pass, then the line settles lit and still (done)
 *  - `blink`   two sharp full-line pulses, then settle (error)
 */
type ActivityMotion = "drift" | "ponder" | "comet" | "scan" | "await" | "wipe" | "blink";

interface ActivityProfile {
	motion: ActivityMotion;
	/**
	 * Palette for this state. Tiers reference {@link ThemeColor} tokens — never
	 * literal hexes — so the active theme (and any rebrand) owns every hue. The
	 * motion is the signal; the token is how the theme colors that signal.
	 */
	palette: ShimmerPalette;
}

/** State → (motion, theme-token palette). One definitional home for the mapping. */
export const ACTIVITY_PROFILES: Record<ShimmerActivity, ActivityProfile> = {
	idle: { motion: "drift", palette: { low: "dim", mid: "muted", high: "text", bold: true } },
	thinking: { motion: "ponder", palette: { low: "dim", mid: "thinkingText", high: "thinkingText", bold: true } },
	streaming: { motion: "comet", palette: { low: "dim", mid: "accent", high: "accent", bold: true } },
	tool: { motion: "scan", palette: { low: "dim", mid: "toolTitle", high: "toolTitle", bold: true } },
	ask: { motion: "await", palette: { low: "dim", mid: "success", high: "success", bold: true } },
	done: { motion: "wipe", palette: { low: "dim", mid: "success", high: "success", bold: true } },
	error: { motion: "blink", palette: { low: "dim", mid: "error", high: "error", bold: true } },
};

/**
 * The theme-color token an activity paints its brightest tier with — the single
 * source for "what hue does <state> read as". A static surface that wants to
 * agree with the living motion (e.g. the ask/elicitation dialog tinting its
 * question the same green the `ask` breath uses) reads it from here instead of
 * hardcoding a second copy of the token, so a rebrand still owns the one hue.
 */
export function activityColorToken(state: ShimmerActivity): ThemeColor {
	const high = ACTIVITY_PROFILES[state].palette.high;
	return typeof high === "string" ? high : "text";
}

/**
 * The ANSI foreground open sequence for the current living activity's color, or
 * `undefined` when shimmer is not in `living` mode. A surface that paints its
 * own glyph beside the shimmering message — the working spinner — reads this so
 * the spinner shares the message's living hue and the whole line moves as one
 * state, instead of the spinner staying a fixed brand accent while the text
 * turns green/red. Returns the open code only; the caller appends the glyph and
 * its own reset. The living-mode decision stays here (ONE owner of `resolveMode`).
 */
export function livingSpinnerColor(theme: ShimmerTheme): string | undefined {
	if (resolveMode() !== "living") return undefined;
	return resolveTierAnsi(theme, activityColorToken(currentActivity));
}

// ─── Living activity runtime signal ──────────────────────────────────────────
// The current activity and the wall-clock instant it began. `since` anchors the
// one-shot motions (wipe, blink) so they play from the transition, not from an
// arbitrary phase. Module-global to match how `resolveMode` reads global
// settings; the event loop flips it via `setShimmerActivity` at each lifecycle
// transition and `shimmerSegments` reads it every frame.
let currentActivity: ShimmerActivity = "idle";
let activitySince = 0;

/**
 * Signal what the agent is now doing. No-op if unchanged, so repeat calls from a
 * chatty event stream do not restart the one-shot motions. Records the
 * transition instant used by `wipe`/`blink`.
 */
export function setShimmerActivity(next: ShimmerActivity): void {
	if (next === currentActivity) return;
	currentActivity = next;
	activitySince = Date.now();
}

/** The current living activity. */
export function getShimmerActivity(): ShimmerActivity {
	return currentActivity;
}

/** The motion character bound to a state. Exposed for tests and callers. */
export function motionForActivity(state: ShimmerActivity): ActivityMotion {
	return ACTIVITY_PROFILES[state].motion;
}

type ShimmerPaletteTier = ThemeColor | { ansi: string };

function resolveTierAnsi(theme: ShimmerTheme, tier: ShimmerPaletteTier): string {
	return typeof tier === "string" ? theme.getFgAnsi(tier) : tier.ansi;
}

/** Three-tier color stack a shimmer character cycles through as the band sweeps. */
export interface ShimmerPalette {
	/** Color for chars outside / at the edge of the band (intensity < ~0.22). */
	low: ShimmerPaletteTier;
	/** Color for chars approaching the crest (~0.22 ≤ intensity < ~0.65). */
	mid: ShimmerPaletteTier;
	/** Color at the band's crest (intensity ≥ ~0.65). */
	high: ShimmerPaletteTier;
	/** Whether to bold the crest tier. Default `false`. */
	bold?: boolean;
}

/** One run of text that shares a palette inside a larger shimmer sweep. */
export interface ShimmerSegment {
	text: string;
	palette?: ShimmerPalette;
}

export const DEFAULT_SHIMMER_PALETTE: ShimmerPalette = {
	low: "dim",
	mid: "muted",
	high: "accent",
	bold: true,
};

// ─── Palette compilation cache ───────────────────────────────────────────────
// Resolving ANSI codes for every character was the dominant per-frame cost.
// We resolve once per (theme, palette) pair into ready-to-concat prefix/suffix
// strings, then coalesce same-tier runs at render time so each frame emits a
// handful of escape sequences instead of one per code point.
//
// The cache is stashed as a Symbol-keyed slot directly on the palette object
// — no module-level sidecar — and invalidates when the active Theme changes.
interface TierSeq {
	open: string;
	close: string;
}
interface CompiledPalette {
	low: TierSeq;
	mid: TierSeq;
	high: TierSeq;
}

const kCompiledFor = Symbol("shimmer.compiledFor");
const kCompiled = Symbol("shimmer.compiled");
interface PaletteCache {
	[kCompiledFor]?: ShimmerTheme;
	[kCompiled]?: CompiledPalette;
}

function compile(theme: ShimmerTheme, palette: ShimmerPalette): CompiledPalette {
	const p = palette as ShimmerPalette & PaletteCache;
	const cached = p[kCompiled];
	if (cached && p[kCompiledFor] === theme) return cached;
	const lowOpen = resolveTierAnsi(theme, palette.low);
	const midOpen = resolveTierAnsi(theme, palette.mid);
	const highColorOpen = resolveTierAnsi(theme, palette.high);
	const highOpen = palette.bold ? `${BOLD_OPEN}${highColorOpen}` : highColorOpen;
	const highClose = palette.bold ? `${BOLD_CLOSE}${FG_RESET}` : FG_RESET;
	const out: CompiledPalette = {
		low: { open: lowOpen, close: FG_RESET },
		mid: { open: midOpen, close: FG_RESET },
		high: { open: highOpen, close: highClose },
	};
	p[kCompiledFor] = theme;
	p[kCompiled] = out;
	return out;
}

// ─── Intensity profiles ──────────────────────────────────────────────────────
/** Smooth cosine bump sweeping left → right with edge padding. */
function classicIntensity(time: number, index: number, length: number): number {
	const period = length + CLASSIC_PADDING * 2;
	// Fixed-velocity, un-floored band position: advancing at a constant
	// cells/second (not period / fixed-sweep) keeps the per-frame step ≤1 cell at
	// the default cadence for any length, so long messages are no steppier.
	const pos = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
	const dist = Math.abs(index + CLASSIC_PADDING - pos);
	if (dist >= CLASSIC_BAND_HALF_WIDTH) return 0;
	return 0.5 * (1 + Math.cos((Math.PI * dist) / CLASSIC_BAND_HALF_WIDTH));
}

/**
 * Knight Rider K.I.T.T. scanner: a single bright head ping-pongs across the
 * bar with a quadratic-decay trail behind it. No leading glow — LEDs don't
 * predict the future.
 */
function kittIntensity(time: number, index: number, length: number): number {
	const range = length - 1;
	if (range <= 0) return 1;
	// Fixed head velocity: a triangle ping-pong over a 2*range round trip at a
	// constant cells/second, so the bright head advances ≤1 cell per frame at the
	// default cadence regardless of bar length. Round-trip duration scales with length.
	const cycleCells = 2 * range;
	const sweep = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % cycleCells;
	const goingRight = sweep < range;
	const head = goingRight ? sweep : cycleCells - sweep;
	const delta = index - head;
	const abs = delta < 0 ? -delta : delta;
	if (abs <= KITT_HEAD_HALF) return 1;
	// Only chars *behind* the head light up — direction-dependent.
	const behind = goingRight ? -delta : delta;
	if (behind <= KITT_HEAD_HALF) return 0;
	const t = (behind - KITT_HEAD_HALF) / KITT_TRAIL_LEN;
	if (t >= 1) return 0;
	const f = 1 - t;
	return f * f;
}

/**
 * Drift (idle / resting): a single slow luminance wave travels along the line.
 * Unlike ponder's unison breath, each cell peaks at a different moment, so a
 * band of light visibly glides across the horizon — the rule reads as alive and
 * calm rather than a flat rest. Never fully dark (DRIFT_FLOOR) so the horizon is
 * always present.
 */
function driftIntensity(time: number, index: number, _length: number): number {
	const phase = (time / DRIFT_PERIOD_MS) * Math.PI * 2 - index * DRIFT_WAVELENGTH;
	const wave = 0.5 * (1 + Math.sin(phase));
	return clamp01(DRIFT_FLOOR + (1 - DRIFT_FLOOR) * wave);
}

/**
 * Ponder (thinking): a slow unison breath plus a faint per-char ripple.
 * The whole line rises and falls together — going nowhere, because nothing is
 * streaming yet — while the ripple keeps it from looking frozen.
 */
function ponderIntensity(time: number, index: number, _length: number): number {
	const breath = 0.5 * (1 + Math.sin((time / PONDER_PERIOD_MS) * Math.PI * 2 - Math.PI / 2));
	const ripple = 0.16 * Math.sin((time / PONDER_RIPPLE_PERIOD_MS) * Math.PI * 2 - index * 0.32);
	return clamp01(0.22 + 0.5 * breath + ripple);
}

/**
 * Comet (streaming): a bright head runs left → right, an exponential trail
 * fading behind it, nothing ahead. Directional — it reads as text pouring out.
 */
function cometIntensity(time: number, index: number, length: number): number {
	const period = length + COMET_LEAD_PAD * 2;
	const head = (((time / 1000) * COMET_SPEED_CELLS_PER_S) % period) - COMET_LEAD_PAD;
	const delta = head - index; // >0: behind the head (lit trail); <0: ahead (dark)
	if (delta < -0.9) return 0;
	if (delta < 0.6) return 1; // the head itself
	const v = Math.exp(-delta / COMET_TRAIL_LEN);
	return v < 0.06 ? 0 : v;
}

/**
 * Await (your turn): a steady green breath with a high floor. It never goes
 * dark and it never travels — the stillness is the signal that the sweep has
 * stopped and the agent is waiting on you.
 */
function awaitIntensity(time: number, _index: number, _length: number): number {
	const breath = 0.5 * (1 + Math.sin((time / AWAIT_PERIOD_MS) * Math.PI * 2));
	return AWAIT_FLOOR + (1 - AWAIT_FLOOR) * breath;
}

/**
 * Wipe (done): one head passes across the line, lighting each cell as it
 * arrives; once it has passed, cells stay settled and lit. `elapsed` is time
 * since the state began, so the pass plays once from the transition.
 */
function wipeIntensity(elapsed: number, index: number, length: number): number {
	const progress = elapsed / WIPE_SWEEP_MS;
	if (progress >= 1) return WIPE_SETTLE;
	const head = progress * length;
	const delta = head - index;
	if (delta < 0) return 0; // not reached yet
	return delta < 2 ? 1 : WIPE_SETTLE; // bright at the head, settled behind
}

/**
 * Blink (error): two sharp full-line pulses, then settle so the error banner
 * beneath carries the detail. `elapsed` is time since the state began.
 */
function blinkIntensity(elapsed: number, _index: number, _length: number): number {
	if (elapsed >= BLINK_SETTLE_MS) return BLINK_SETTLE;
	return elapsed % BLINK_PERIOD_MS < BLINK_ON_MS ? 1 : BLINK_OFF;
}

/**
 * Intensity for a living state at `time` (wall clock, ms) for the character at
 * `index` of a `length`-cell line, given the state began at `since`. Pure and
 * deterministic in its inputs — the test suite pins each motion here.
 */
export function livingIntensity(
	state: ShimmerActivity,
	time: number,
	since: number,
	index: number,
	length: number,
): number {
	switch (motionForActivity(state)) {
		case "drift":
			return driftIntensity(time, index, length);
		case "ponder":
			return ponderIntensity(time, index, length);
		case "comet":
			return cometIntensity(time, index, length);
		case "scan":
			return kittIntensity(time, index, length);
		case "await":
			return awaitIntensity(time, index, length);
		case "wipe":
			return wipeIntensity(time - since, index, length);
		case "blink":
			return blinkIntensity(time - since, index, length);
	}
}

type Tier = "low" | "mid" | "high";

function tierFor(intensity: number): Tier {
	if (intensity >= TIER_HIGH) return "high";
	if (intensity >= TIER_MID) return "mid";
	return "low";
}

function resolveMode(): ShimmerMode {
	if (!isSettingsInitialized()) return "classic";
	return settings.get("display.shimmer");
}

/** Whether shimmer animations are active (any mode other than `disabled`). */
export function shimmerEnabled(): boolean {
	return resolveMode() !== "disabled";
}

/**
 * Apply a shimmer sweep across one or more segments, treating them as a
 * single continuous string for band positioning. Each segment can supply
 * its own palette so the gradient stays in lockstep while the colors
 * differ.
 *
 * Performance shape (per call, dominant cost):
 *   - One `Date.now()` read.
 *   - One `compile()` lookup per segment (Symbol-keyed cache slot, hot path
 *     skipped after first frame).
 *   - One ANSI open/close pair per **run of same-tier chars**, not per char.
 *   - No per-char allocations beyond the run buffer.
 */
export function shimmerSegments(segments: readonly ShimmerSegment[], theme: ShimmerTheme): string {
	const mode = resolveMode();

	// Pre-scan: total code-point count (positions the band) and resolved palette.
	// The per-segment string is kept verbatim — iterating UTF-16 units with a
	// surrogate-pair guard produces the same code points as `Array.from(text)`
	// at zero per-frame allocation (previously the #1 hotspot at ~10% of profiled
	// CPU during streaming — the working message is shimmered every animation
	// frame at 30fps and `Array.from` reallocated the code-point array each tick).
	let total = 0;
	const perSeg: { text: string; palette: ShimmerPalette }[] = [];
	for (const seg of segments) {
		total += countCodePoints(seg.text);
		perSeg.push({ text: seg.text, palette: seg.palette ?? DEFAULT_SHIMMER_PALETTE });
	}
	if (total === 0) return "";

	// Disabled: no animation, no per-char work. Paint each segment in its mid
	// tier so the working line stays legible without movement.
	if (mode === "disabled") {
		let out = "";
		for (const { text, palette } of perSeg) {
			const seq = compile(theme, palette).mid;
			out += `${seq.open}${text}${seq.close}`;
		}
		return out;
	}

	const time = Date.now();
	const intensityFn = mode === "kitt" ? kittIntensity : classicIntensity;

	// Living mode overrides both motion and palette from the current activity:
	// every cell is painted with the state's theme-token palette (never the
	// per-segment session-accent palette), and the intensity comes from the
	// state's motion. Compile the state palette once and reuse it for all
	// segments so the whole working line reads as one activity color.
	const livingCompiled = mode === "living" ? compile(theme, ACTIVITY_PROFILES[currentActivity].palette) : undefined;

	// Fast-path window: outside `[bandLo, bandHi]` the intensity is guaranteed
	// zero (tier "low"), so we can skip `intensityFn` + `tierFor` entirely for
	// the prefix/suffix of every segment. On the typical ~60-char working
	// message the classic band spans ~12 cells, so ~80% of the per-char loop
	// disappears — the intensity call and the tier compare were the residual
	// per-frame cost after #4353 removed the allocation hotspot (issue #4377).
	// Living motions (breath/wipe/blink) touch every cell, so there is no window
	// to skip; comet/scan still evaluate cheaply over the ~60-cell working line.
	const { lo: bandLo, hi: bandHi } = mode === "living" ? { lo: 0, hi: total - 1 } : activeBand(mode, time, total);

	let out = "";
	let index = 0;
	for (const { text, palette } of perSeg) {
		const compiled = livingCompiled ?? compile(theme, palette);
		let runTier: Tier | null = null;
		let runStart = 0;
		let runEnd = 0;
		let i = 0;
		while (i < text.length) {
			// Detect a surrogate pair so a single code point (e.g. an emoji) stays
			// atomic; the band position is measured in code points, not UTF-16 units.
			const c = text.charCodeAt(i);
			let step = 1;
			if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
				const c2 = text.charCodeAt(i + 1);
				if (c2 >= 0xdc00 && c2 <= 0xdfff) step = 2;
			}
			const tier: Tier =
				mode === "living"
					? tierFor(livingIntensity(currentActivity, time, activitySince, index, total))
					: index < bandLo || index > bandHi
						? "low"
						: tierFor(intensityFn(time, index, total));
			if (tier !== runTier) {
				if (runTier !== null && runEnd > runStart) {
					const seq = compiled[runTier];
					out += `${seq.open}${text.slice(runStart, runEnd)}${seq.close}`;
				}
				runTier = tier;
				runStart = i;
			}
			runEnd = i + step;
			index++;
			i += step;
		}
		if (runTier !== null && runEnd > runStart) {
			const seq = compiled[runTier];
			out += `${seq.open}${text.slice(runStart, runEnd)}${seq.close}`;
		}
	}
	return out;
}

/**
 * Sweep window (code-point indices) outside which the intensity is guaranteed
 * zero for `mode` at `time` over `total` cells. Widening the window is safe —
 * the per-char intensity call still runs inside the window and reports 0 for
 * off-band code points — but narrower windows skip more of the per-char loop.
 */
function activeBand(mode: "classic" | "kitt", time: number, total: number): { lo: number; hi: number } {
	if (mode === "classic") {
		const period = total + CLASSIC_PADDING * 2;
		const pos = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
		return {
			lo: pos - CLASSIC_PADDING - CLASSIC_BAND_HALF_WIDTH,
			hi: pos - CLASSIC_PADDING + CLASSIC_BAND_HALF_WIDTH,
		};
	}
	const range = total - 1;
	if (range <= 0) return { lo: 0, hi: total };
	const cycleCells = 2 * range;
	const sweep = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % cycleCells;
	const goingRight = sweep < range;
	const head = goingRight ? sweep : cycleCells - sweep;
	// The trail always lies behind the head for the current direction — chars
	// ahead of the head are dark. See {@link kittIntensity} for the exact rule.
	return goingRight
		? { lo: head - KITT_HEAD_HALF - KITT_TRAIL_LEN, hi: head + KITT_HEAD_HALF }
		: { lo: head - KITT_HEAD_HALF, hi: head + KITT_HEAD_HALF + KITT_TRAIL_LEN };
}

function countCodePoints(text: string): number {
	let n = 0;
	let i = 0;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
			const c2 = text.charCodeAt(i + 1);
			if (c2 >= 0xdc00 && c2 <= 0xdfff) {
				i += 2;
				n++;
				continue;
			}
		}
		i++;
		n++;
	}
	return n;
}

export function shimmerText(text: string, theme: ShimmerTheme, palette?: ShimmerPalette): string {
	return shimmerSegments([{ text, palette }], theme);
}

// ─── Lava — the molten warm-arc motion ───────────────────────────────────────
// The design system's rule: motion is a signal, and the warm arc is "the one
// live thing". Lava paints a LIVE warm-arc glyph (the selection cursor ❯, the
// selected match's hit character, the filter caret, the working spinner's
// repaint) with a slow heat cycle flowing deep-ember → ember → gold → back.
// It is a hue ramp over time built from THEME TOKENS (borderAccent = ember,
// matchHighlight = gold), never literal hexes, so a rebrand still owns every
// color. GLYPHS AND TEXT ONLY: painting any motion onto a bare rule shatters
// it (shipped once, user-rejected, locked out by the composer-hairline suite).

/** One full heat cycle. Slow enough to read as molten, not blinking. */
const LAVA_PERIOD_MS = 5500;
/** Phase advance per cell so adjacent glyphs flow rather than pulse in unison. */
const LAVA_CELL_PHASE = 0.09;
/** How far the trough dips below the ember stop toward black (deep ember). */
const LAVA_DEEP_FACTOR = 0.45;

type LavaTheme = Pick<Theme, "getColorHex" | "fg">;

function hexChannel(hex: string, i: number): number {
	return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
}

function mixHex(a: string, b: string, t: number): [number, number, number] {
	return [0, 1, 2].map(i => Math.round(hexChannel(a, i) + (hexChannel(b, i) - hexChannel(a, i)) * t)) as [
		number,
		number,
		number,
	];
}

/**
 * The molten color at phase `p` (0..1): a triangle wave through the heat ramp
 * deep-ember (trough) → ember → gold (crest) → ember → deep-ember. Returns
 * r/g/b so callers can emit one 24-bit sequence.
 */
function lavaRgbAt(theme: LavaTheme, p: number): [number, number, number] {
	const ember = theme.getColorHex("borderAccent");
	const gold = theme.getColorHex("matchHighlight");
	// Triangle: 0→1→0 across the cycle, so the heat rises and falls smoothly —
	// trough (phase 0) is deep ember, crest (phase 0.5) is gold.
	const f = p - Math.floor(p);
	const clamped = 1 - Math.abs(2 * f - 1);
	if (clamped < 0.5) {
		// deep ember → ember: scale ember toward black by the deep factor.
		const k = clamped / 0.5;
		const deep = mixHex("#000000", ember, 1 - LAVA_DEEP_FACTOR);
		const deepHex = `#${deep.map(c => c.toString(16).padStart(2, "0")).join("")}`;
		return mixHex(deepHex, ember, k);
	}
	// ember → gold
	return mixHex(ember, gold, (clamped - 0.5) / 0.5);
}

/**
 * 24-bit foreground open sequence for a molten glyph at time `now`, offset by
 * `cell` so neighbouring glyphs flow. Truecolor only: on a non-truecolor
 * terminal the caller gets `undefined` and paints the glyph static ember via
 * `theme.fg("borderAccent", …)` — a loud, documented degrade (no animation
 * hardware, no animation), never a different color.
 */
export function lavaAnsi(theme: LavaTheme, trueColor: boolean, now = Date.now(), cell = 0): string | undefined {
	if (!trueColor) return undefined;
	const p = now / LAVA_PERIOD_MS + cell * LAVA_CELL_PHASE;
	const [r, g, b] = lavaRgbAt(theme, p);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Paint a short run of text molten, per-cell phase-offset so the heat flows
 * along it. Meant for a glyph or a few characters (a cursor, a hit char, a
 * caret) — long prose keeps its own motions (sweep/ponder), lava is the warm
 * arc's accent, not a body style.
 */
export function lavaText(text: string, theme: LavaTheme, trueColor: boolean, now = Date.now()): string {
	if (!trueColor) return theme.fg("borderAccent", text);
	let out = "";
	let cell = 0;
	for (const ch of text) {
		out += `${lavaAnsi(theme, true, now, cell)}${ch}`;
		cell++;
	}
	return `${out}${FG_RESET}`;
}

/** Exposed for the lava test suite: period and the exact crest/trough stops. */
export const LAVA_TUNING = {
	periodMs: LAVA_PERIOD_MS,
	cellPhase: LAVA_CELL_PHASE,
	deepFactor: LAVA_DEEP_FACTOR,
} as const;
