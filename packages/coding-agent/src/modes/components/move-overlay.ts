import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	HoverFade,
	Key,
	matchesKey,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
} from "@veyyon/tui";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import {
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	pointerMotionEnabled,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";
import type { DirEntry, MoveOverlayResult } from "./move-overlay-helpers";

import { MAX_RESULTS, MOVE_SHORTCUTS, printableInput, readDirCached, searchDirectories } from "./move-overlay-helpers";
import { hoverBandAt } from "./selector-helpers";

export { resolveExistingDirectory, resolveMovePath } from "./move-overlay-helpers";
export type { MoveOverlayResult };

export class MoveOverlay implements Component, Focusable {
	#focused = false;
	#input = "";
	#cursor = 0;
	#selectedIndex = 0;
	#results: DirEntry[] = [];
	#cwd: string;
	#done: (result: MoveOverlayResult | undefined) => void;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#listRowStart = 0;
	#hoveredIndex: number | null = null;
	#onRequestRender?: () => void;
	#hoverFade: HoverFade | undefined;

	constructor(cwd: string, done: (result: MoveOverlayResult | undefined) => void) {
		this.#cwd = cwd;
		this.#done = done;
		readDirCached(cwd);
		this.#updateResults();
	}

	setOnRequestRender(cb: () => void): void {
		this.#onRequestRender = cb;
		this.#hoverFade?.dispose();
		this.#hoverFade = new HoverFade({ requestRender: cb, enabled: pointerMotionEnabled() });
		if (this.#hoveredIndex !== null) this.#hoverFade.set(this.#hoveredIndex);
	}

	dispose(): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoveredIndex = null;
	}

	#hoverStrength(index: number): number {
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(index);
		return index === this.#hoveredIndex ? 1 : 0;
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouse(event));
			return;
		}
		if (matchesSelectCancel(data) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.#done(undefined);
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			this.#confirm();
			return;
		}
		if (matchesSelectUp(data) || matchesKey(data, Key.up)) {
			if (this.#results.length > 0) this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, Key.down)) {
			if (this.#results.length > 0)
				this.#selectedIndex = Math.min(this.#results.length - 1, this.#selectedIndex + 1);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			const selected = this.#results[this.#selectedIndex];
			if (selected) {
				this.#input = selected.value;
				this.#cursor = this.#input.length;
				this.#selectedIndex = 0;
				this.#updateResults();
			}
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.#cursor = Math.max(0, this.#cursor - 1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.#cursor = Math.min(this.#input.length, this.#cursor + 1);
			return;
		}
		if (matchesKey(data, Key.backspace) && this.#cursor > 0) {
			this.#input = this.#input.slice(0, this.#cursor - 1) + this.#input.slice(this.#cursor);
			this.#cursor--;
			this.#selectedIndex = 0;
			this.#updateResults();
			return;
		}
		const text = printableInput(data);
		if (text.length > 0) {
			this.#input = this.#input.slice(0, this.#cursor) + text + this.#input.slice(this.#cursor);
			this.#cursor += text.length;
			this.#selectedIndex = 0;
			this.#updateResults();
		}
	}

	render(width: number): readonly string[] {
		const height = process.stdout.rows || 40;
		const sizing = sizingForArea(MODAL_SIZING_MEDIUM, height);
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return new Array(height).fill(padding(width));
		}

		const body: string[] = [this.#renderInput(), ""];
		if (this.#results.length === 0 && this.#input.length > 0) {
			body.push(theme.fg("dim", "No matching directories"));
		} else {
			const shown = Math.min(this.#results.length, MAX_RESULTS);
			for (let i = 0; i < shown; i++) {
				const item = this.#results[i]!;
				const selected = i === this.#selectedIndex;
				const hoverStrength = this.#hoverStrength(i);
				const marker = selected ? theme.fg("accent", "▶ ") : "  ";
				const label = selected ? theme.fg("accent", item.label) : theme.fg("text", item.label);
				const row = `${marker}${label}`;
				body.push(hoverStrength > 0 ? hoverBandAt(row, dims.contentWidth, hoverStrength) : row);
			}
		}

		const shell = renderModalShell({
			title: "Move",
			sizing,
			areaWidth: width,
			areaHeight: height,
			body,
			shortcuts: MOVE_SHORTCUTS,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		this.#listRowStart = (shell.geometry?.bodyRowStart ?? 0) + 2;
		return shell.lines;
	}

	invalidate(): void {}

	#routeMouse(event: SgrMouseEvent): boolean {
		const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
			motion: event.motion,
			leftClick: event.leftClick,
		});
		if (
			consumeModalChipHover(chrome, this.#hoveredShortcutId, id => {
				this.#hoveredShortcutId = id;
				this.#onRequestRender?.();
			})
		) {
			return true;
		}
		if (
			chrome.kind === "close" ||
			chrome.kind === "outside" ||
			(chrome.kind === "shortcut" && chrome.id === "close")
		) {
			this.#done(undefined);
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "confirm") {
			this.#confirm();
			return true;
		}
		if (event.wheel !== null) {
			if (this.#results.length > 0) {
				this.#selectedIndex = Math.max(0, Math.min(this.#results.length - 1, this.#selectedIndex + event.wheel));
				this.#onRequestRender?.();
			}
			return true;
		}
		const index = event.row - this.#listRowStart;
		const shown = Math.min(this.#results.length, MAX_RESULTS);
		if (event.motion) {
			const hovered = index >= 0 && index < shown ? index : null;
			if (hovered !== this.#hoveredIndex) {
				this.#hoveredIndex = hovered;
				this.#hoverFade?.set(hovered);
				this.#onRequestRender?.();
			}
			return true;
		}
		if (event.leftClick) {
			if (index >= 0 && index < shown) {
				this.#selectedIndex = index;
				this.#confirm();
			}
			return true;
		}
		return true;
	}

	#renderInput(): string {
		const prompt = theme.fg("dim", "Path: ");
		if (this.#input.length === 0) {
			const placeholder = theme.fg("dim", "Type a directory path…");
			const marker = this.#focused ? CURSOR_MARKER : "";
			return `${prompt}${placeholder}${marker}\x1b[7m \x1b[27m`;
		}
		const before = this.#input.slice(0, this.#cursor);
		const cursorChar = this.#cursor < this.#input.length ? this.#input[this.#cursor] : " ";
		const after = this.#input.slice(this.#cursor + 1);
		const marker = this.#focused ? CURSOR_MARKER : "";
		return `${prompt}${before}${marker}\x1b[7m${cursorChar}\x1b[27m${after}`;
	}

	#updateResults(): void {
		this.#results = searchDirectories(this.#input, this.#cwd, MAX_RESULTS + 5);
		if (this.#selectedIndex >= this.#results.length) {
			this.#selectedIndex = Math.max(0, this.#results.length - 1);
		}
	}

	#confirm(): void {
		const selected = this.#results[this.#selectedIndex];
		if (selected) {
			this.#done({ directory: selected.value });
			return;
		}
		if (this.#input.trim().length > 0) {
			this.#done({ directory: this.#input.trim() });
			return;
		}
		this.#done(undefined);
	}
}
