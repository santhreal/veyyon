/**
 * The `living` shimmer mode: the working line's motion AND color change with
 * what the agent is doing. This suite locks three contracts, each of which is a
 * regression waiting to happen if the mapping or the math drifts:
 *
 *  1. STATE → (motion, theme-token palette). Every activity binds to a specific
 *     motion character and a specific {@link ThemeColor} token — never a literal
 *     hex, so a rebrand owns every hue. If a state silently loses its motion or
 *     borrows the wrong token, the signal stops meaning what it says.
 *  2. Each MOTION's intensity profile at exact (time, index, since). These are
 *     the shapes that make the states legible without reading the words — a
 *     forward comet, a ping-pong scan, a still unison breath, a one-shot wipe, a
 *     double blink. Asserted against computed values, never `!isEmpty`.
 *  3. The LIVING RENDER PATH end to end: with the setting on, `shimmerText`
 *     paints the whole line in the active state's token, switching color the
 *     instant the activity switches, and one-shot motions (wipe) anchor to the
 *     transition instant recorded by `setShimmerActivity`.
 *
 * Motion tunables live in shimmer.ts; the expected values below are derived from
 * them by hand so a tunable change that alters the feel fails loudly here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings, settings } from "@veyyon/coding-agent/config/settings";
import {
	ACTIVITY_PROFILES,
	getShimmerActivity,
	livingIntensity,
	livingSpinnerColor,
	motionForActivity,
	type ShimmerActivity,
	setShimmerActivity,
	shimmerText,
} from "@veyyon/coding-agent/modes/theme/shimmer";
import type { Theme } from "@veyyon/coding-agent/modes/theme/theme";

// Distinct SGR codes per token so a rendered run reveals exactly which token
// colored it. Every token the living palettes reference is present.
const TOKEN_CODE: Record<string, string> = {
	accent: "\x1b[36m",
	dim: "\x1b[2m",
	muted: "\x1b[90m",
	thinkingText: "\x1b[35m",
	toolTitle: "\x1b[34m",
	success: "\x1b[32m",
	error: "\x1b[31m",
	text: "\x1b[37m",
};
const testTheme = {
	bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
	fg: (color: Parameters<Theme["fg"]>[0], t: string) => `${TOKEN_CODE[color as string] ?? ""}${t}\x1b[39m`,
	getFgAnsi: (color: Parameters<Theme["getFgAnsi"]>[0]) => TOKEN_CODE[color as string] ?? "",
};

describe("ACTIVITY_PROFILES — state binds to one motion and one theme token", () => {
	// Locks the semantic mapping. If someone repoints `streaming` off the comet,
	// or colors `error` with anything but the error token, the signal breaks.
	// Most states carry ONE hue (crest === shoulder); `idle` is the exception —
	// it drifts across a silver `text` crest down through a `muted` shoulder to a
	// `dim` floor, a graded structural shimmer, not a single-hue pulse.
	type Bind = { motion: string; high: string; mid: string };
	const EXPECTED: Record<ShimmerActivity, Bind> = {
		idle: { motion: "drift", high: "text", mid: "muted" },
		thinking: { motion: "ponder", high: "thinkingText", mid: "thinkingText" },
		streaming: { motion: "comet", high: "accent", mid: "accent" },
		tool: { motion: "scan", high: "toolTitle", mid: "toolTitle" },
		ask: { motion: "await", high: "success", mid: "success" },
		done: { motion: "wipe", high: "success", mid: "success" },
		error: { motion: "blink", high: "error", mid: "error" },
	};

	for (const [state, expected] of Object.entries(EXPECTED) as [ShimmerActivity, Bind][]) {
		it(`${state} → ${expected.motion} motion, ${expected.high} crest / ${expected.mid} shoulder`, () => {
			expect(String(motionForActivity(state))).toBe(expected.motion);
			const p = ACTIVITY_PROFILES[state].palette;
			// Tiers reference tokens (strings), never { ansi } literals; the floor is
			// always dim so every state fades to the same dark base.
			expect(String(p.high)).toBe(expected.high);
			expect(String(p.mid)).toBe(expected.mid);
			expect(String(p.low)).toBe("dim");
			expect(p.bold).toBe(true);
		});
	}

	it("covers every activity — no state left without a profile", () => {
		const states: ShimmerActivity[] = ["idle", "thinking", "streaming", "tool", "ask", "done", "error"];
		for (const s of states) expect(ACTIVITY_PROFILES[s]).toBeDefined();
		expect(Object.keys(ACTIVITY_PROFILES).sort()).toEqual([...states].sort());
	});
});

describe("livingIntensity — drift (idle / resting)", () => {
	// The state the user stares at most. A single slow luminance wave travels
	// ALONG the line: each cell peaks at a different instant, so a band of light
	// glides across a mostly-dim rule instead of the whole line breathing in
	// unison. Values below are computed by hand from the drift tunables
	// (period 2600ms, wavelength 0.42, floor 0.1) so a tunable change fails here.
	it("is a traveling wave — cells at the same instant differ by index (NOT unison)", () => {
		// t=0: index 0 sits at the wave midpoint (0.55); index 5 is pulled down the
		// falling edge to ~0.1616. If drift ever became unison these would match.
		expect(livingIntensity("idle", 0, 0, 0, 20)).toBeCloseTo(0.55, 5);
		expect(livingIntensity("idle", 0, 0, 5, 20)).toBeCloseTo(0.1616, 3);
		expect(livingIntensity("idle", 0, 0, 0, 20)).not.toBeCloseTo(livingIntensity("idle", 0, 0, 5, 20), 2);
	});
	it("crests above the high tier so the silver crest actually lights", () => {
		// t=650 is a quarter period → index 0 sits exactly at the wave peak (1.0),
		// well clear of TIER_HIGH (0.65), so the `text` crest token shows.
		expect(livingIntensity("idle", 650, 0, 0, 20)).toBeCloseTo(1, 5);
	});
	it("troughs to the floor (below the mid tier) so most of the rule reads dim", () => {
		// Three-quarter period → the wave bottoms out at the 0.1 floor, below
		// TIER_MID (0.22), so the trough falls back to the `dim` token.
		expect(livingIntensity("idle", 1950, 0, 0, 20)).toBeCloseTo(0.1, 5);
	});
	it("never goes fully dark and stays within [0,1] across a full sweep", () => {
		for (let t = 0; t < 5200; t += 41) {
			for (let i = 0; i < 40; i++) {
				const v = livingIntensity("idle", t, 0, i, 40);
				expect(v).toBeGreaterThanOrEqual(0.1 - 1e-9); // the horizon is always present
				expect(v).toBeLessThanOrEqual(1);
			}
		}
	});
});

describe("livingIntensity — ponder (thinking)", () => {
	// A unison breath (all cells rise/fall together) plus a faint per-char
	// ripple so it never looks frozen. At t=0 the breath is at its trough, so
	// index 0 sits exactly at the 0.22 base and index 5 is pulled down by the
	// ripple — proving the ripple is real and per-index.
	it("sits at the 0.22 base at the breath trough, index 0", () => {
		expect(livingIntensity("thinking", 0, 0, 0, 20)).toBeCloseTo(0.22, 5);
	});
	it("applies a per-char ripple away from index 0", () => {
		// 0.22 + 0 + 0.16*sin(-5*0.32) = 0.22 + 0.16*sin(-1.6) ≈ 0.0601
		expect(livingIntensity("thinking", 0, 0, 5, 20)).toBeCloseTo(0.0601, 3);
	});
	it("stays within [0,1] across a sweep of times and indices", () => {
		for (let t = 0; t < 2000; t += 37) {
			for (let i = 0; i < 20; i++) {
				const v = livingIntensity("thinking", t, 0, i, 20);
				expect(v).toBeGreaterThanOrEqual(0);
				expect(v).toBeLessThanOrEqual(1);
			}
		}
	});
	it("rises to a bright crest (high tier) somewhere on the line at the breath peak", () => {
		// At t≈425 the breath is at its peak (contributes the full 0.5 over the
		// 0.22 base). Where the ripple is non-negative the value clears the high
		// tier (0.65); index 6 is one such cell. Proven both pointwise and by scan.
		expect(livingIntensity("thinking", 425, 0, 6, 20)).toBeGreaterThan(0.65);
		let max = 0;
		for (let i = 0; i < 20; i++) max = Math.max(max, livingIntensity("thinking", 425, 0, i, 20));
		expect(max).toBeGreaterThan(0.65);
	});
});

describe("livingIntensity — comet (streaming)", () => {
	// A bright head runs forward; an exponential trail fades behind it; nothing
	// ahead. At t=1000 over a 20-cell line the head sits on index 18.
	//   period = 20 + 8*2 = 36; pos = 26 % 36 = 26; head = 26 - 8 = 18
	it("lights the head cell fully", () => {
		expect(livingIntensity("streaming", 1000, 0, 18, 20)).toBe(1);
	});
	it("is dark one cell ahead of the head (nothing predicts the future)", () => {
		expect(livingIntensity("streaming", 1000, 0, 19, 20)).toBe(0);
	});
	it("decays exponentially along the trail behind the head", () => {
		// index 10 is 8 cells behind the head: exp(-8/8) = exp(-1) ≈ 0.3679
		expect(livingIntensity("streaming", 1000, 0, 10, 20)).toBeCloseTo(0.3679, 3);
	});
	it("is directional — a far-behind cell is dimmer than a near-behind cell", () => {
		const near = livingIntensity("streaming", 1000, 0, 16, 20); // 2 behind
		const far = livingIntensity("streaming", 1000, 0, 4, 20); // 14 behind
		expect(near).toBeGreaterThan(far);
	});
});

describe("livingIntensity — scan (tool, KITT head)", () => {
	// A single head ping-pongs. At t=1000 over 20 cells it is travelling left
	// with the head on index 8; cells ahead (lower index, the direction of
	// travel) are dark, cells behind carry a quadratic trail.
	it("lights the head cell fully", () => {
		expect(livingIntensity("tool", 1000, 0, 8, 20)).toBe(1);
	});
	it("is dark ahead of the head in its travel direction", () => {
		expect(livingIntensity("tool", 1000, 0, 6, 20)).toBe(0);
	});
	it("carries a decaying trail behind the head", () => {
		// index 10, 2 behind: tt = (2 - 0.6)/7 = 0.2, f = 0.8, f*f = 0.64
		expect(livingIntensity("tool", 1000, 0, 10, 20)).toBeCloseTo(0.64, 3);
	});
});

describe("livingIntensity — await (your turn)", () => {
	// A steady unison breath that never goes dark and never travels. The floor
	// (0.4) is the "present and waiting" signal; the value is identical across
	// every index at a given instant.
	it("holds a 0.7 value at the breath midpoint (t=0)", () => {
		expect(livingIntensity("ask", 0, 0, 0, 20)).toBeCloseTo(0.7, 5);
	});
	it("never drops below the 0.4 floor", () => {
		for (let t = 0; t < 3000; t += 31) {
			expect(livingIntensity("ask", t, 0, 0, 20)).toBeGreaterThanOrEqual(0.4 - 1e-9);
		}
	});
	it("is unison — identical for every index at a fixed instant", () => {
		const at = (i: number) => livingIntensity("ask", 777, 0, i, 40);
		expect(at(0)).toBe(at(20));
		expect(at(20)).toBe(at(39));
	});
});

describe("livingIntensity — wipe (done), anchored to `since`", () => {
	// One pass, then settle. `elapsed = time - since`, so the pass plays once
	// from the transition instant, not from an arbitrary global phase.
	it("lights only the head at elapsed 0", () => {
		expect(livingIntensity("done", 1000, 1000, 0, 20)).toBe(1); // head at index 0
		expect(livingIntensity("done", 1000, 1000, 5, 20)).toBe(0); // not reached yet
	});
	it("has the head mid-line at half the sweep", () => {
		// elapsed = 325ms = WIPE_SWEEP_MS/2 → head at index 10 of 20
		expect(livingIntensity("done", 1000, 675, 10, 20)).toBe(1);
		expect(livingIntensity("done", 1000, 675, 0, 20)).toBe(0.8); // settled behind
		expect(livingIntensity("done", 1000, 675, 15, 20)).toBe(0); // ahead of head
	});
	it("settles the whole line lit once the sweep completes", () => {
		// elapsed = 700ms ≥ WIPE_SWEEP_MS (650) → every cell at the settle value
		for (let i = 0; i < 20; i++) expect(livingIntensity("done", 1000, 300, i, 20)).toBe(0.8);
	});
});

describe("livingIntensity — blink (error), anchored to `since`", () => {
	// Two sharp full-line pulses, then settle. `elapsed = time - since`.
	it("is fully lit at the start of a pulse", () => {
		expect(livingIntensity("error", 1000, 1000, 0, 20)).toBe(1); // elapsed 0
		expect(livingIntensity("error", 1100, 1000, 7, 20)).toBe(1); // elapsed 100 < 190
	});
	it("drops to the off value between pulses", () => {
		// elapsed 300ms: 300 % 640 = 300 ≥ 190 → off
		expect(livingIntensity("error", 1300, 1000, 3, 20)).toBe(0.22);
	});
	it("keeps blinking through the second pulse", () => {
		// elapsed 700ms: 700 % 640 = 60 < 190 → on again
		expect(livingIntensity("error", 1700, 1000, 3, 20)).toBe(1);
	});
	it("settles after the blink window closes", () => {
		// elapsed 1300ms ≥ BLINK_SETTLE_MS → settle
		expect(livingIntensity("error", 2300, 1000, 3, 20)).toBe(0.55);
	});
});

describe("setShimmerActivity / getShimmerActivity", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		setShimmerActivity("idle");
	});
	it("defaults to idle and reflects the last set state", () => {
		setShimmerActivity("idle");
		expect(getShimmerActivity()).toBe("idle");
		setShimmerActivity("streaming");
		expect(getShimmerActivity()).toBe("streaming");
		setShimmerActivity("tool");
		expect(getShimmerActivity()).toBe("tool");
	});
});

describe("living render path — shimmerText colors by the active state", () => {
	beforeEach(async () => {
		// Real, in-memory settings so resolveMode() reads a live value. An init
		// `overrides` layer would permanently pin the mode (later `settings.set`
		// can't beat it), so we init plain and `set` the mode instead. The shipped
		// default is now `disabled` (the living animation was too visually noisy at
		// rest), so these tests set `living` explicitly to exercise that engine.
		await Settings.init({ inMemory: true });
		settings.set("display.shimmer", "living");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		setShimmerActivity("idle");
	});

	it("paints a thinking line in the thinkingText token, not the accent", () => {
		vi.spyOn(Date, "now").mockReturnValue(425); // near the ponder crest
		setShimmerActivity("idle");
		setShimmerActivity("thinking");
		const out = shimmerText("hello", testTheme);
		expect(out).toContain(TOKEN_CODE.thinkingText);
		expect(out).not.toContain(TOKEN_CODE.accent);
		expect(Bun.stripANSI(out)).toBe("hello");
	});

	it("paints a streaming line in the accent token", () => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		setShimmerActivity("idle");
		setShimmerActivity("streaming");
		const out = shimmerText("streaming now", testTheme);
		expect(out).toContain(TOKEN_CODE.accent);
		expect(Bun.stripANSI(out)).toBe("streaming now");
	});

	it("paints a tool line in the toolTitle token", () => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		setShimmerActivity("idle");
		setShimmerActivity("tool");
		const out = shimmerText("tool", testTheme);
		expect(out).toContain(TOKEN_CODE.toolTitle);
	});

	it("paints an ask line entirely in the success token (unison, above the crest)", () => {
		vi.spyOn(Date, "now").mockReturnValue(0); // await = 0.7 ≥ high tier for all cells
		setShimmerActivity("idle");
		setShimmerActivity("ask");
		const out = shimmerText("waiting", testTheme);
		expect(out).toContain(TOKEN_CODE.success);
		expect(out).not.toContain(TOKEN_CODE.dim); // nothing falls to the floor
	});

	it("switching activity switches the color on the very next render", () => {
		vi.spyOn(Date, "now").mockReturnValue(0);
		setShimmerActivity("idle");
		setShimmerActivity("ask");
		expect(shimmerText("x y z", testTheme)).toContain(TOKEN_CODE.success);
		setShimmerActivity("error"); // elapsed 0 → fully lit
		const out = shimmerText("x y z", testTheme);
		expect(out).toContain(TOKEN_CODE.error);
		expect(out).not.toContain(TOKEN_CODE.success);
	});

	it("anchors the done wipe to the transition instant recorded by setShimmerActivity", () => {
		vi.spyOn(Date, "now").mockReturnValue(5000);
		setShimmerActivity("idle");
		setShimmerActivity("done"); // records since = 5000
		// elapsed 0: only the head cell is lit, the rest fall to the dim floor.
		const atStart = shimmerText("hello", testTheme);
		expect(atStart).toContain(TOKEN_CODE.success);
		expect(atStart).toContain(TOKEN_CODE.dim);
		// Advance past the sweep without changing state: the line settles fully
		// lit, nothing left at the floor — proving the wipe ran from `since`.
		(Date.now as unknown as { mockReturnValue: (n: number) => void }).mockReturnValue(5000 + 700);
		const settled = shimmerText("hello", testTheme);
		expect(settled).toContain(TOKEN_CODE.success);
		expect(settled).not.toContain(TOKEN_CODE.dim);
	});
});

/**
 * The working spinner glyph must share the message's living hue so the whole
 * status line moves as one state — green while asking, red on error — rather
 * than a fixed brand accent glued to a colour-shifting message. `livingSpinnerColor`
 * is the ONE seam the loader reads for that; these lock its contract: it returns
 * the current activity's token ANSI in living mode and nothing outside it.
 */
describe("livingSpinnerColor — spinner shares the activity hue", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		setShimmerActivity("idle");
	});

	it("returns undefined when shimmer is not in living mode (spinner keeps the brand accent)", async () => {
		await Settings.init({ inMemory: true });
		settings.set("display.shimmer", "classic");
		setShimmerActivity("streaming");
		expect(livingSpinnerColor(testTheme)).toBeUndefined();
		settings.set("display.shimmer", "living");
	});

	it("returns the exact ANSI of the current activity's token in living mode", async () => {
		await Settings.init({ inMemory: true });
		settings.set("display.shimmer", "living");
		setShimmerActivity("idle");
		setShimmerActivity("error");
		expect(livingSpinnerColor(testTheme)).toBe(TOKEN_CODE.error);
		setShimmerActivity("ask");
		expect(livingSpinnerColor(testTheme)).toBe(TOKEN_CODE.success);
		setShimmerActivity("tool");
		expect(livingSpinnerColor(testTheme)).toBe(TOKEN_CODE.toolTitle);
	});

	it("resolves the resting hue to the silver `text` token and streaming to accent", async () => {
		// The composer's `›` prompt glyph reads this exact seam: at rest it must be
		// the neutral silver structural token (never a pinned ember), and it shifts
		// to the accent while streaming — so the prompt and the horizon share one
		// living hue and a rebrand owns both through the same tokens.
		await Settings.init({ inMemory: true });
		settings.set("display.shimmer", "living");
		setShimmerActivity("idle");
		expect(livingSpinnerColor(testTheme)).toBe(TOKEN_CODE.text);
		setShimmerActivity("streaming");
		expect(livingSpinnerColor(testTheme)).toBe(TOKEN_CODE.accent);
	});
});
