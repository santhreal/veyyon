import * as fs from "node:fs";
import { Ghostty, type GhosttyTerminal } from "ghostty-web";
import { DEFAULT_BG_RGB, DEFAULT_FG_RGB } from "./constants";

// ---------------------------------------------------------------------------
// Shared Ghostty VT engine
// ---------------------------------------------------------------------------
// `VirtualTerminal` is backed by libghostty-vt compiled to WASM — Ghostty's real
// VT100 parser. Unlike the previous xterm.js backing, this is a *modern*
// grapheme-aware terminal: emoji presentation and VS16 promotion measure 2
// cells, ZWJ/combining clusters collapse into their base cell, BCE/erase and
// scrollback behave exactly as ghostty/kitty/WezTerm/iTerm2 do. That makes the
// render-stress oracles assert against ground-truth modern-terminal semantics
// instead of an approximation, so kitty-class rendering bugs (wide-char overrun,
// pending-wrap staircase, grapheme mis-measure) surface here.
//
// The WASM module is compiled once per module evaluation, then each
// `VirtualTerminal` gets its own instance. ghostty-web's allocator is not robust
// under the hundreds of create/free/write cycles the fuzz tests perform when all
// terminals share one instance; per-terminal instances keep construction
// synchronous while isolating allocator state.
export function loadGhosttyModule(): WebAssembly.Module {
	const wasmPath = Bun.resolveSync("ghostty-web/ghostty-vt.wasm", import.meta.dir);
	// Synchronous compile (no top-level await): `bun test --parallel` leaves any
	// binding declared after a module-level `await` in the temporal dead zone when
	// a sibling test file instantiates `VirtualTerminal`, so module init must stay
	// fully synchronous (see the `DEFAULT_SCROLLBACK_LINES`/`ghosttyModule` TDZ).
	return new WebAssembly.Module(fs.readFileSync(wasmPath));
}

let ghosttyModule = loadGhosttyModule();

/**
 * Recompile the shared WASM module. ghostty-web 0.4 instances created from a
 * module that already produced a trapped instance have been observed to trap
 * again on byte streams that a freshly compiled module replays cleanly; the
 * recovery path swaps the module before rebuilding.
 */
export function reloadGhosttyModule(): void {
	ghosttyModule = loadGhosttyModule();
}

// Non-spacing combining marks (Arabic harakat, Thai/Lao vowels) written so a
// cluster lands on the right margin deterministically corrupt ghostty-web
// 0.4's WASM memory (trap surfaces a few bytes later, with autowrap on or
// off). Mark placement through this engine is already unverifiable — readback
// migrates marks across cells, and the harness compares marked rows with
// non-spacing marks stripped (`sameLinesAllowingMarkDrift`) — so dropping the
// marks before the engine sees them removes the crash class without weakening
// any oracle. Variation selectors are kept: they are width-bearing (VS16
// promotes emoji to 2 cells) and never combine at the margin.
export const UNSAFE_COMBINING_MARKS = /(?![\uFE00-\uFE0F])\p{Mn}/gu;
export function stripCombiningMarksForGhostty(data: string): string {
	if (!/\p{Mn}/u.test(data)) return data;
	return data.replace(UNSAFE_COMBINING_MARKS, "");
}

export function createGhosttyEngine(): Ghostty {
	// libghostty-vt reports unimplemented control sequences (e.g. DECCARA `$r`,
	// which this VT build does not apply) through the `env.log` import. Swallow it:
	// the oracles assert on what the renderer *emits*, never on the parser's own
	// diagnostics, and unbuffered logging would corrupt test output.
	return new Ghostty(new WebAssembly.Instance(ghosttyModule, { env: { log: () => {} } }));
}

export function createGhosttyTerminal(
	ghostty: Ghostty,
	columns: number,
	rows: number,
	scrollbackCap: number,
): GhosttyTerminal {
	return ghostty.createTerminal(columns, rows, {
		// Byte budget (not a line count). Sized to hold the wrapper's line cap
		// comfortably while staying small enough that ghostty's own page
		// eviction kicks in under heavy write volume: ghostty-web 0.4's
		// allocator traps once an instance accumulates enough un-evicted
		// history (recommit-heavy stress runs hit it). The wrapper still clamps
		// the EXPOSED scrollback to the line cap, so eviction beyond the budget
		// is invisible to the oracles.
		scrollbackLimit: Math.max((scrollbackCap + rows + 64) * 1024, 1024 * 1024),
		fgColor: DEFAULT_FG_RGB,
		bgColor: DEFAULT_BG_RGB,
	});
}
