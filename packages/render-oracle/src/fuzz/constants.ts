export const BASE_SEEDS = [
	0x00c0ffee, 0x1badb002, 0x5eed1234, 0xdecafbad, 0x8badf00d, 0x0ddc0ffe, 0xcafed00d, 0xb16b00b5,
] as const;
// Pinned regression replays: template+seed pairs that once broke an oracle or
// the engine. BASE_SEEDS pair with templates round-robin, so a bug found on a
// specific (scenario, seed) combination would otherwise only re-run under a
// wide TUI_STRESS_SEEDS sweep; these are appended to EVERY default pool so the
// exact reproduction stays in the always-on suite. Each entry documents the
// bug it locks out.
export const REGRESSION_REPLAYS: readonly { template: string; seed: number }[] = [
	// 2026-07-24: after collapseToFew shrank the frame into the committed
	// prefix, the next growth frame tripped tape/physical scroll parity at
	// op 87 — twice over: the shadow ledger re-derived the engine's window
	// classification and drifted one frame off (fixed by reading the engine's
	// committed counter and verifying it against physical scrolls), and the
	// parity guard re-armed from the collapsed frame's LENGTH while the
	// terminal history stayed saturated (baseY pinned at the line cap, every
	// scroll evicting — fixed by gating on observed baseY saturation).
	{ template: "darwin-normal-small", seed: 0xe19c9184 },
	// 2026-07-24: highWaterPreviewCollapse streams a 17-row transient preview
	// past a tiny viewport and collapses back inside ONE op. The frame ends
	// byte-identical but the overflow rows legitimately committed into history
	// and stay there with scrollback rebuild disabled ("duplication, never
	// loss") — the frame-neutral growth oracle demanded zero growth unless the
	// buffer ended clean; it now allows growth bounded by the op's tape delta.
	{ template: "darwin-normal-tiny", seed: 0x8b0f1a71 },
	// 2026-07-24: appendRepeatedTail while the reader is scrolled into a
	// SATURATED history (baseY at the line cap): the commit evicts the oldest
	// row and the offset-pinned viewport's visible content slides up one row.
	// The anti-yank row-stability oracle read that legitimate eviction shift as
	// a stray write; it now skips row stability only when saturated AND the op
	// committed (tape grew).
	{ template: "darwin-normal-small", seed: 0x40593834 },
	// 2026-07-24: ghostty-web 0.4 deterministically traps (out-of-bounds WASM
	// memory) replaying a long multi-width resize history; the OOM recovery
	// replayed the raw log and trapped identically, killing the scenario. The
	// VirtualTerminal recovery now rebuilds the pre-write state, rotates onto
	// the compact synthetic snapshot, and re-applies the failed write.
	{ template: "win32-intermittentUnknown-small", seed: 0x90744a00 },
	// 2026-07-24: same ghostty-web multi-width corruption, read side — a WSL
	// scenario never reads scrollback between ops, so the poisoned state built
	// up invisibly until the OOM-recovery's own compaction READ trapped
	// (get_scrollback_line out-of-bounds). VirtualTerminal now rotates onto a
	// compact synthetic state at every resize boundary so the multi-width trap
	// state never forms.
	{ template: "linux-unknown-wsl-small", seed: 0x24d2d8c2 },
];
export const LARGE_SCROLL = 1_000_000;
export const CORE_ITERATIONS = 120;
export const SOAK_ITERATIONS = 300;
export const CORE_BULK_MAX = 1_000;
export const SOAK_BULK_MAX = 1_000;
export const CORE_TIMEOUT_MS = 20_000;
export const SOAK_TIMEOUT_MS = 45_000;
export const EXHAUSTIVE_SCROLLBACK = Bun.env.TUI_STRESS_EXHAUSTIVE_SCROLLBACK === "1";

export const SEGMENT_RESET = "\x1b[0m";
export const ESC = "\x1b";
export const BEL = "\x07";
export const ALT_SCREEN_ENTER = "\x1b[?1049h";
export const ALT_SCREEN_EXIT = "\x1b[?1049l";
export const SMILE = String.fromCodePoint(0x1f642);
