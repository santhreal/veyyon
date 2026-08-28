// xterm.js' default scrollback line cap, used when a terminal is created without
// an explicit one. The exposed scrollback is clamped to this many lines (below).
export const DEFAULT_SCROLLBACK_LINES = 1000;
// Packed default colors (0xRRGGBB). Light-grey fg on black bg so a styled SGR
// row differs from a default row in cell readback.
export const DEFAULT_FG_RGB = 0xcccccc;
export const DEFAULT_BG_RGB = 0x000000;
export const MAX_GHOSTTY_WRITE_CHUNK = 4096;
// Compact the OOM-recovery event log once it exceeds this many logged chars.
// Kept aggressively small: ghostty-web 0.4 instances can trap on long byte
// histories (interactions that a synthesized text+grid state does not
// reproduce), so recovery must always replay a compact synthetic snapshot
// plus a short tail rather than the raw session history.
export const EVENT_LOG_COMPACT_BUDGET = 256_000;
export const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
export const SYNC_OUTPUT_END = "\x1b[?2026l";
export const OSC_SEQUENCE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// Compare readback against the configured defaults directly; Ghostty's
// getColors() currently reports render-state metadata, not these cell colors.
export const DEFAULT_FG_R = (DEFAULT_FG_RGB >> 16) & 0xff;
export const DEFAULT_FG_G = (DEFAULT_FG_RGB >> 8) & 0xff;
export const DEFAULT_FG_B = DEFAULT_FG_RGB & 0xff;
export const DEFAULT_BG_R = (DEFAULT_BG_RGB >> 16) & 0xff;
export const DEFAULT_BG_G = (DEFAULT_BG_RGB >> 8) & 0xff;
export const DEFAULT_BG_B = DEFAULT_BG_RGB & 0xff;
