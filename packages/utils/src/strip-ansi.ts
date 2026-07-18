/**
 * Strip terminal ANSI escape sequences: CSI (Control Sequence Introducer —
 * colors/styles/cursor movement) and OSC (Operating System Command —
 * hyperlinks, window-title sets). This is the full superset; a narrower
 * SGR-only (colors/styles only) strip is a materially different behavior
 * and must not reuse this name.
 *
 * Dependency-free by design: imported both from Node/Bun contexts and from
 * browser-bundled renderers (`@veyyon/tool-render`, via its `src/util.ts`), so
 * this file must never pull in Node built-ins.
 */
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}
