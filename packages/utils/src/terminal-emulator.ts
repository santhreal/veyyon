/**
 * Terminal emulator identity, resolved from environment markers.
 *
 * Distinct from `ttyid.ts` (which names the TTY device or multiplexer pane): this identifies the
 * outer emulator whose capabilities and background color the host renders into.
 */

export type TerminalId =
	| "kitty"
	| "ghostty"
	| "wezterm"
	| "iterm2"
	| "vscode"
	| "alacritty"
	| "warp"
	| "base"
	| "trueColor";

/** Resolve terminal emulator identity from environment markers used by common emulators. */
export function detectTerminalId(env: NodeJS.ProcessEnv = Bun.env): TerminalId {
	const {
		KITTY_WINDOW_ID,
		GHOSTTY_RESOURCES_DIR,
		WEZTERM_PANE,
		ITERM_SESSION_ID,
		VSCODE_PID,
		ALACRITTY_WINDOW_ID,
		TERM_PROGRAM,
		TERM,
		COLORTERM,
	} = env;

	if (KITTY_WINDOW_ID) return "kitty";
	if (GHOSTTY_RESOURCES_DIR) return "ghostty";
	if (WEZTERM_PANE) return "wezterm";
	if (ITERM_SESSION_ID) return "iterm2";
	if (VSCODE_PID) return "vscode";
	if (ALACRITTY_WINDOW_ID) return "alacritty";

	if (TERM_PROGRAM) {
		switch (TERM_PROGRAM.toLowerCase()) {
			case "kitty":
				return "kitty";
			case "ghostty":
				return "ghostty";
			case "wezterm":
				return "wezterm";
			case "iterm.app":
				return "iterm2";
			case "vscode":
				return "vscode";
			case "alacritty":
				return "alacritty";
			case "warpterminal":
				return "warp";
		}
	}

	if (TERM?.toLowerCase().includes("ghostty")) return "ghostty";

	const colorterm = COLORTERM?.toLowerCase();
	if (colorterm === "truecolor" || colorterm === "24bit") return "trueColor";
	return "base";
}
