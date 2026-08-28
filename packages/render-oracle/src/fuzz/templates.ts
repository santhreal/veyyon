import type { ScenarioTemplate } from "./scenarios";
import type { EnvMode, GeometryMode, TerminalMode, TestPlatform } from "./types";

export function coreTemplates(): ScenarioTemplate[] {
	return [
		{
			name: "darwin-normal-small",
			platform: "darwin",
			terminalMode: "normal",
			envMode: "plain",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 24, 32, 40],
			heightChoices: [3, 4, 6],
			scrollbackRows: 5,
		},
		{
			name: "linux-normal-small",
			platform: "linux",
			terminalMode: "normal",
			envMode: "plain",
			geometryMode: "small",
			columns: 40,
			rows: 6,
			widthChoices: [10, 18, 32, 40],
			heightChoices: [3, 4, 6],
		},
		{
			// VTE 0.68 reports DEC 2026 synchronized output as permanently reset
			// and users can opt out when a terminal's implementation is buggy or
			// visually worse. The renderer must remove only the 2026 wrapper; it
			// still keeps autowrap disabled around paints to avoid pending-wrap
			// staircase corruption.
			name: "linux-normal-vteNoSync-small",
			platform: "linux",
			terminalMode: "normal",
			envMode: "vteNoSync",
			geometryMode: "small",
			columns: 40,
			rows: 6,
			widthChoices: [10, 18, 32, 40],
			heightChoices: [3, 4, 6],
		},
		{
			name: "darwin-normal-large",
			platform: "darwin",
			terminalMode: "normal",
			envMode: "plain",
			geometryMode: "large",
			columns: 80,
			rows: 12,
			widthChoices: [40, 80, 120],
			heightChoices: [12, 24],
		},
		{
			name: "win32-intermittentUnknown-small",
			platform: "win32",
			terminalMode: "intermittentUnknown",
			envMode: "plain",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 32],
			heightChoices: [3, 4, 6],
		},
		{
			name: "darwin-normal-tmux-small",
			platform: "darwin",
			terminalMode: "normal",
			envMode: "tmux",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 32],
			heightChoices: [3, 4, 6],
		},
		{
			name: "linux-staleBottom-large",
			platform: "linux",
			terminalMode: "staleBottom",
			envMode: "plain",
			geometryMode: "large",
			columns: 120,
			rows: 24,
			widthChoices: [80, 120],
			heightChoices: [12, 24],
		},
		{
			name: "darwin-normal-tiny",
			platform: "darwin",
			terminalMode: "normal",
			envMode: "plain",
			geometryMode: "small",
			columns: 6,
			rows: 1,
			widthChoices: [1, 2, 6, 12],
			heightChoices: [1, 2, 3],
			uniqueContent: true,
		},
		{
			name: "linux-normal-termux-small",
			platform: "linux",
			terminalMode: "normal",
			envMode: "termux",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 32],
			heightChoices: [1, 2, 3, 4, 6],
		},
		{
			name: "darwin-unknown-appleTerminal-small",
			platform: "darwin",
			terminalMode: "unknown",
			envMode: "appleTerminal",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 32],
			heightChoices: [3, 4, 6],
			scrollbackRows: 10_000,
		},
		{
			// WSL fronted by Windows Terminal (#1610): the viewport probe is
			// permanently unobservable (kernel32 is unreachable from a Linux
			// process) and the outer WT host erases scrollback on ED3, snapping a
			// scrolled-up reader to the remaining buffer. The renderer must treat
			// this environment as ED3-risk and defer eager live rebuilds.
			name: "linux-unknown-wsl-small",
			platform: "linux",
			terminalMode: "unknown",
			envMode: "wsl",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 32],
			heightChoices: [3, 4, 6],
			scrollbackRows: 10_000,
		},
		{
			// Native-Windows ConPTY host (Windows Terminal, Tabby, Hyper, VS Code,
			// conhost behind ConPTY — #1635/#1746). kernel32 cannot see the host
			// UI's scrollback (the pseudo-console buffer is pinned to the visible
			// grid), and no env var distinguishes the hosts (Tabby sets none), so
			// the probe is permanently `undefined`. A reader scrolled in the host
			// UI must not be yanked by streaming-time rebuilds; reconciliation
			// waits for explicit checkpoints.
			name: "win32-unknown-small",
			platform: "win32",
			terminalMode: "unknown",
			envMode: "plain",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 32],
			heightChoices: [3, 4, 6],
			scrollbackRows: 10_000,
		},
		{
			// Foreground tool actively streaming on an ED3-risk terminal whose
			// viewport position is unobservable (ghostty/kitty/alacritty/VTE/iTerm2).
			// Content frames flow through `viewportRepaint`/`diff` instead of a
			// forced history rebuild. An offscreen-edit growth then repaints in
			// place — advancing the rendered line count without committing the
			// overflow to native history — and the next shrink must still
			// re-anchor the bottom of the viewport from that lagging high-water mark.
			// The default content-frame path forces a render and never reaches this
			// state (a notification chip rendering over the active tool render: the
			// original report).
			name: "darwin-unknown-ghostty-stream-small",
			platform: "darwin",
			terminalMode: "unknown",
			envMode: "ghostty",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 32],
			heightChoices: [3, 4, 6],
			scrollbackRows: 10_000,
			foregroundStream: true,
		},
		{
			name: "linux-unknown-ghostty-stream-large",
			platform: "linux",
			terminalMode: "unknown",
			envMode: "ghostty",
			geometryMode: "large",
			columns: 80,
			rows: 12,
			widthChoices: [40, 80, 120],
			heightChoices: [8, 12, 24],
			scrollbackRows: 10_000,
			foregroundStream: true,
		},
		{
			// Width-reflowing content (wrapped/markdown-style) uses the same grapheme
			// width semantics as the real Ghostty-backed terminal, so the wrap agrees
			// with the terminal's cell widths. A width resize changes the physical
			// line count, so the renderer must
			// re-anchor the viewport and rebuild native history across a line-count
			// change — not just retruncate rows. Combined with the full random op
			// space (scroll, overlay, append, shrink) it covers reflow interactions
			// the deterministic width tests exercise only in isolation.
			name: "darwin-normal-reflow-small",
			platform: "darwin",
			terminalMode: "normal",
			envMode: "plain",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [8, 12, 16, 24, 32, 40],
			heightChoices: [3, 4, 6],
			reflow: true,
		},
		{
			name: "darwin-unknown-reflow-stream-large",
			platform: "darwin",
			terminalMode: "unknown",
			envMode: "ghostty",
			geometryMode: "large",
			columns: 80,
			rows: 12,
			widthChoices: [24, 40, 80, 120],
			heightChoices: [8, 12, 24],
			scrollbackRows: 10_000,
			reflow: true,
			foregroundStream: true,
		},
	];
}

export function soakTemplates(): ScenarioTemplate[] {
	const templates: ScenarioTemplate[] = [];
	const platformEnvModes: readonly { platform: TestPlatform; envModes: readonly EnvMode[] }[] = [
		{ platform: "darwin", envModes: ["plain", "tmux"] },
		{ platform: "linux", envModes: ["plain", "tmux", "termux", "vteNoSync"] },
		{ platform: "win32", envModes: ["plain"] },
	];
	const terminalModes: readonly TerminalMode[] = ["normal", "unknown", "intermittentUnknown", "staleBottom"];
	const geometries: readonly GeometryMode[] = ["small", "large"];
	for (const { platform, envModes } of platformEnvModes) {
		for (const terminalMode of terminalModes) {
			for (const envMode of envModes) {
				for (const geometryMode of geometries) {
					const large = geometryMode === "large";
					templates.push({
						name: `${platform}-${terminalMode}-${envMode}-${geometryMode}`,
						platform,
						terminalMode,
						envMode,
						geometryMode,
						columns: large ? 80 : 32,
						rows: large ? 12 : 4,
						widthChoices: large ? [80, 120] : [2, 10, 16, 24, 32, 40],
						heightChoices: large ? [12, 24] : [3, 4, 6],
						...(!large && terminalMode === "normal" && envMode === "plain"
							? { scrollbackRows: 5, uniqueContent: true }
							: {}),
					});
				}
			}
		}
	}
	// WSL fronted by Windows Terminal (#1610): only the unknown terminal mode is
	// realistic — the kernel32 viewport probe never answers from a Linux process.
	for (const geometryMode of geometries) {
		const large = geometryMode === "large";
		templates.push({
			name: `linux-unknown-wsl-${geometryMode}`,
			platform: "linux",
			terminalMode: "unknown",
			envMode: "wsl",
			geometryMode,
			columns: large ? 80 : 32,
			rows: large ? 12 : 4,
			widthChoices: large ? [80, 120] : [2, 10, 16, 24, 32, 40],
			heightChoices: large ? [12, 24] : [3, 4, 6],
		});
	}
	// Foreground tool streaming on an ED3-risk terminal with an unobservable
	// viewport (ghostty/kitty/…): the eager native-scrollback rebuild opt-in is
	// gated off, so content frames repaint in place and offscreen-edit growth
	// lags the high-water mark — a later shrink must still re-anchor the viewport
	// bottom rather than drifting rows up over one another.
	for (const geometryMode of geometries) {
		const large = geometryMode === "large";
		templates.push({
			name: `darwin-unknown-ghostty-stream-${geometryMode}`,
			platform: "darwin",
			terminalMode: "unknown",
			envMode: "ghostty",
			geometryMode,
			columns: large ? 80 : 32,
			rows: large ? 12 : 4,
			widthChoices: large ? [80, 120] : [2, 10, 16, 24, 32, 40],
			heightChoices: large ? [8, 12, 24] : [3, 4, 6],
			foregroundStream: true,
		});
	}
	return templates;
}
