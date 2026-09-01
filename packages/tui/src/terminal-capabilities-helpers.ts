export { isInsideTmux, wrapTmuxPassthrough } from "./tmux";

export enum ImageProtocol {
	Kitty = "\x1b_G",
	Iterm2 = "\x1b]1337;File=",
	Sixel = "\x1bPq",
}

export enum NotifyProtocol {
	Bell = "\x07",
	Osc99 = "\x1b]99;;",
	Osc9 = "\x1b]9;",
}

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

export function hasNeedleBefore(line: string, needle: string, limit: number): boolean {
	const index = line.indexOf(needle);
	return index !== -1 && index + needle.length <= limit;
}

export function hasSixelDcsStart(line: string): boolean {
	const limit = Math.min(line.length, 128);
	let from = 0;
	for (;;) {
		const start = line.indexOf("\x1bP", from);
		if (start === -1 || start + 3 > limit) return false;
		let i = start + 2;
		while (i < limit) {
			const code = line.charCodeAt(i);
			if ((code >= 0x30 && code <= 0x39) || code === 0x3b) {
				i++;
				continue;
			}
			break;
		}
		if (i < limit && line.charCodeAt(i) === 0x71) return true;
		from = start + 2;
	}
}
