/**
 * What a tool's UI status is, and the one glyph that renders it.
 *
 * WHY IT IS NOT IN `tools/render-utils.ts`. It was, and that module is 167 modules: it reads the
 * keybindings, the settings and the image-resize helpers, because plenty of tool rendering needs them.
 * This does not. `formatStatusIcon` is a switch over eight cases that asks the theme for a symbol, and
 * `tui/status-line.ts` wanted exactly those two names, so a status line cost 167 modules.
 *
 * That is not where it stopped. `tui/index.ts` re-exports the status line, `tools/fetch.ts` takes two
 * names from that barrel, and `tools/read.ts` imports `fetch`, so reading a local file reached the
 * settings through a status glyph. `render-utils.ts` re-exports both names, so no caller changed.
 */

import type { Theme } from "../modes/theme/theme";

export type ToolUIStatus = "success" | "done" | "error" | "warning" | "info" | "pending" | "running" | "aborted";

/**
 * Get the appropriate status icon with color for a given state.
 * Standardizes status icon usage across all renderers.
 */
export function formatStatusIcon(status: ToolUIStatus, theme: Theme, spinnerFrame?: number): string {
	switch (status) {
		case "success":
			return theme.styledSymbol("status.success", "success");
		case "done":
			return theme.styledSymbol("status.done", "success");
		case "error":
			return theme.styledSymbol("status.error", "error");
		case "warning":
			return theme.styledSymbol("status.warning", "warning");
		case "info":
			return theme.styledSymbol("status.info", "accent");
		case "pending":
			return theme.styledSymbol("status.pending", "muted");
		case "running":
			if (spinnerFrame !== undefined) {
				const frames = theme.spinnerFrames;
				return frames[spinnerFrame % frames.length];
			}
			return theme.styledSymbol("status.running", "accent");
		case "aborted":
			return theme.styledSymbol("status.aborted", "error");
	}
}
