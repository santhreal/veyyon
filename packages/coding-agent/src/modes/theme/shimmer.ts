import { SGR_FG_RESET, SGR_INTENSITY_RESET } from "@veyyon/tui/ansi";
import { CHANNEL_STR } from "@veyyon/tui/motion-paint";
import { clamp01 } from "@veyyon/utils/math";
import { isSettingsInitialized, settings } from "../../config/settings-instance";
import type { Theme, ThemeColor } from "./theme";

const SHIMMER_SPEED_CELLS_PER_S = 30;

const CLASSIC_PADDING = 10;
const CLASSIC_BAND_HALF_WIDTH = 6;

const KITT_HEAD_HALF = 0.6;
const KITT_TRAIL_LEN = 7;

const COMET_SPEED_CELLS_PER_S = 26;
const COMET_TRAIL_LEN = 8;
const COMET_LEAD_PAD = 8;

const PONDER_PERIOD_MS = 850;
const PONDER_RIPPLE_PERIOD_MS = 560;
const DRIFT_PERIOD_MS = 2600;
const DRIFT_WAVELENGTH = 0.42;
const DRIFT_FLOOR = 0.1;
const AWAIT_PERIOD_MS = 1050;
const AWAIT_FLOOR = 0.4;
const WIPE_SWEEP_MS = 650;
const WIPE_SETTLE = 0.8;
const BLINK_PERIOD_MS = 640;
const BLINK_ON_MS = 190;
const BLINK_SETTLE_MS = 1300;
const BLINK_SETTLE = 0.55;
const BLINK_OFF = 0.22;

const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

const BOLD_OPEN = "\x1b[1m";

type ShimmerTheme = Pick<Theme, "bold" | "fg" | "getFgAnsi">;
type ShimmerMode = "classic" | "kitt" | "living" | "disabled";

export type ShimmerActivity = "idle" | "thinking" | "streaming" | "tool" | "ask" | "done" | "error";

type ActivityMotion = "drift" | "ponder" | "comet" | "scan" | "await" | "wipe" | "blink";

interface ActivityProfile {
	motion: ActivityMotion;
	palette: ShimmerPalette;
}

export const ACTIVITY_PROFILES: Record<ShimmerActivity, ActivityProfile> = {
	idle: { motion: "drift", palette: { low: "dim", mid: "muted", high: "text", bold: true } },
	thinking: { motion: "ponder", palette: { low: "dim", mid: "thinkingText", high: "thinkingText", bold: true } },
	streaming: { motion: "comet", palette: { low: "dim", mid: "accent", high: "accent", bold: true } },
	tool: { motion: "scan", palette: { low: "dim", mid: "toolTitle", high: "toolTitle", bold: true } },
	ask: { motion: "await", palette: { low: "dim", mid: "success", high: "success", bold: true } },
	done: { motion: "wipe", palette: { low: "dim", mid: "success", high: "success", bold: true } },
	error: { motion: "blink", palette: { low: "dim", mid: "error", high: "error", bold: true } },
};

export function activityColorToken(state: ShimmerActivity): ThemeColor {
	const high = ACTIVITY_PROFILES[state].palette.high;
	return typeof high === "string" ? high : "text";
}

export function livingSpinnerColor(theme: ShimmerTheme): string | undefined {
	if (resolveMode() !== "living") return undefined;
	return resolveTierAnsi(theme, activityColorToken(currentActivity));
}

let currentActivity: ShimmerActivity = "idle";
let activitySince = 0;

export function setShimmerActivity(next: ShimmerActivity): void {
	if (next === currentActivity) return;
	currentActivity = next;
	activitySince = Date.now();
}

export function getShimmerActivity(): ShimmerActivity {
	return currentActivity;
}

export function motionForActivity(state: ShimmerActivity): ActivityMotion {
	return ACTIVITY_PROFILES[state].motion;
}

type ShimmerPaletteTier = ThemeColor | { ansi: string };

function resolveTierAnsi(theme: ShimmerTheme, tier: ShimmerPaletteTier): string {
	return typeof tier === "string" ? theme.getFgAnsi(tier) : tier.ansi;
}

export interface ShimmerPalette {
	low: ShimmerPaletteTier;
	mid: ShimmerPaletteTier;
	high: ShimmerPaletteTier;
	bold?: boolean;
}

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
	const highClose = palette.bold ? `${SGR_INTENSITY_RESET}${SGR_FG_RESET}` : SGR_FG_RESET;
	const out: CompiledPalette = {
		low: { open: lowOpen, close: SGR_FG_RESET },
		mid: { open: midOpen, close: SGR_FG_RESET },
		high: { open: highOpen, close: highClose },
	};
	p[kCompiledFor] = theme;
	p[kCompiled] = out;
	return out;
}

function classicIntensity(time: number, index: number, length: number): number {
	const period = length + CLASSIC_PADDING * 2;
	const pos = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
	const dist = Math.abs(index + CLASSIC_PADDING - pos);
	if (dist >= CLASSIC_BAND_HALF_WIDTH) return 0;
	return 0.5 * (1 + Math.cos((Math.PI * dist) / CLASSIC_BAND_HALF_WIDTH));
}

function kittIntensity(time: number, index: number, length: number): number {
	const range = length - 1;
	if (range <= 0) return 1;
	const cycleCells = 2 * range;
	const sweep = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % cycleCells;
	const goingRight = sweep < range;
	const head = goingRight ? sweep : cycleCells - sweep;
	const delta = index - head;
	const abs = delta < 0 ? -delta : delta;
	if (abs <= KITT_HEAD_HALF) return 1;
	const behind = goingRight ? -delta : delta;
	if (behind <= KITT_HEAD_HALF) return 0;
	const t = (behind - KITT_HEAD_HALF) / KITT_TRAIL_LEN;
	if (t >= 1) return 0;
	const f = 1 - t;
	return f * f;
}

function driftIntensity(time: number, index: number, _length: number): number {
	const phase = (time / DRIFT_PERIOD_MS) * Math.PI * 2 - index * DRIFT_WAVELENGTH;
	const wave = 0.5 * (1 + Math.sin(phase));
	return clamp01(DRIFT_FLOOR + (1 - DRIFT_FLOOR) * wave);
}

function ponderIntensity(time: number, index: number, _length: number): number {
	const breath = 0.5 * (1 + Math.sin((time / PONDER_PERIOD_MS) * Math.PI * 2 - Math.PI / 2));
	const ripple = 0.16 * Math.sin((time / PONDER_RIPPLE_PERIOD_MS) * Math.PI * 2 - index * 0.32);
	return clamp01(0.22 + 0.5 * breath + ripple);
}

function cometIntensity(time: number, index: number, length: number): number {
	const period = length + COMET_LEAD_PAD * 2;
	const head = (((time / 1000) * COMET_SPEED_CELLS_PER_S) % period) - COMET_LEAD_PAD;
	const delta = head - index; // >0: behind the head (lit trail); <0: ahead (dark)
	if (delta < -0.9) return 0;
	if (delta < 0.6) return 1; // the head itself
	const v = Math.exp(-delta / COMET_TRAIL_LEN);
	return v < 0.06 ? 0 : v;
}

function awaitIntensity(time: number, _index: number, _length: number): number {
	const breath = 0.5 * (1 + Math.sin((time / AWAIT_PERIOD_MS) * Math.PI * 2));
	return AWAIT_FLOOR + (1 - AWAIT_FLOOR) * breath;
}

function wipeIntensity(elapsed: number, index: number, length: number): number {
	const progress = elapsed / WIPE_SWEEP_MS;
	if (progress >= 1) return WIPE_SETTLE;
	const head = progress * length;
	const delta = head - index;
	if (delta < 0) return 0; // not reached yet
	return delta < 2 ? 1 : WIPE_SETTLE; // bright at the head, settled behind
}

function blinkIntensity(elapsed: number, _index: number, _length: number): number {
	if (elapsed >= BLINK_SETTLE_MS) return BLINK_SETTLE;
	return elapsed % BLINK_PERIOD_MS < BLINK_ON_MS ? 1 : BLINK_OFF;
}

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

export function shimmerEnabled(): boolean {
	return resolveMode() !== "disabled";
}

export function transitionsEnabled(): boolean {
	if (!isSettingsInitialized()) return true;
	return settings.get("display.transitions") !== "off";
}

export function shimmerSegments(segments: readonly ShimmerSegment[], theme: ShimmerTheme): string {
	const mode = resolveMode();

	let total = 0;
	const perSeg: { text: string; palette: ShimmerPalette }[] = [];
	for (const seg of segments) {
		total += countCodePoints(seg.text);
		perSeg.push({ text: seg.text, palette: seg.palette ?? DEFAULT_SHIMMER_PALETTE });
	}
	if (total === 0) return "";

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

	const livingCompiled = mode === "living" ? compile(theme, ACTIVITY_PROFILES[currentActivity].palette) : undefined;

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

const LAVA_PERIOD_MS = 5500;
const LAVA_CELL_PHASE = 0.09;
const LAVA_DEEP_FACTOR = 0.45;
const BLACK_RGB: Rgb = [0, 0, 0];

type LavaTheme = Pick<Theme, "getColorHex" | "fg">;

function hexChannel(hex: string, i: number): number {
	const hi = hex.charCodeAt(1 + i * 2);
	const lo = hex.charCodeAt(2 + i * 2);
	return (hexVal(hi) << 4) | hexVal(lo);
}

function hexVal(c: number): number {
	if (c >= 0x30 && c <= 0x39) return c - 0x30;
	if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
	return c - 0x61 + 10;
}

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
	return [hexChannel(hex, 0), hexChannel(hex, 1), hexChannel(hex, 2)];
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
	return [
		Math.round(a[0] + (b[0] - a[0]) * t),
		Math.round(a[1] + (b[1] - a[1]) * t),
		Math.round(a[2] + (b[2] - a[2]) * t),
	];
}

function lavaRgbAt(theme: LavaTheme, p: number): Rgb {
	const emberRgb = parseHex(theme.getColorHex("borderAccent"));
	const goldRgb = parseHex(theme.getColorHex("matchHighlight"));
	const f = p - Math.floor(p);
	const clamped = 1 - Math.abs(2 * f - 1);
	if (clamped < 0.5) {
		const k = clamped / 0.5;
		const deep = mixRgb(BLACK_RGB, emberRgb, 1 - LAVA_DEEP_FACTOR);
		return mixRgb(deep, emberRgb, k);
	}
	return mixRgb(emberRgb, goldRgb, (clamped - 0.5) / 0.5);
}

export function lavaAnsi(theme: LavaTheme, trueColor: boolean, now = Date.now(), cell = 0): string | undefined {
	if (!trueColor) return undefined;
	const p = now / LAVA_PERIOD_MS + cell * LAVA_CELL_PHASE;
	const [r, g, b] = lavaRgbAt(theme, p);
	return `\x1b[38;2;${CHANNEL_STR[r]};${CHANNEL_STR[g]};${CHANNEL_STR[b]}m`;
}

export function lavaText(text: string, theme: LavaTheme, trueColor: boolean, now = Date.now()): string {
	if (!trueColor) return theme.fg("borderAccent", text);
	let out = "";
	let cell = 0;
	for (const ch of text) {
		out += `${lavaAnsi(theme, true, now, cell)}${ch}`;
		cell++;
	}
	return `${out}${SGR_FG_RESET}`;
}

export const LAVA_TUNING = {
	periodMs: LAVA_PERIOD_MS,
	cellPhase: LAVA_CELL_PHASE,
	deepFactor: LAVA_DEEP_FACTOR,
} as const;
