/** Horizontal tab bar for switching between views or panels. */
import { matchesKey } from "../keys";
import { HoverFade, type HoverFadeOptions } from "../motion-hover";
import type { Component } from "../tui";
import { clampLow, padding, truncateToWidth, visibleWidth } from "../utils";

/** Tab definition */
export interface Tab {
	/** Unique identifier for the tab */
	id: string;
	/** Display label shown in the tab bar */
	label: string;
	/** Compact form (e.g. just the icon) used when the bar must shrink to fit one line. */
	short?: string;
	/** Render with the muted style and skip during keyboard navigation. */
	muted?: boolean;
}

/** Theme for styling the tab bar */
export interface TabBarTheme {
	/** Style for the label prefix (e.g., "Settings:") */
	label: (text: string) => string;
	/** Style for the currently active tab */
	activeTab: (text: string) => string;
	/** Style for inactive tabs */
	inactiveTab: (text: string) => string;
	/** Style for the hint text (e.g., "(tab to cycle)") */
	hint: (text: string) => string;
	/** Style for muted tabs. Falls back to `inactiveTab` when omitted. */
	mutedTab?: (text: string) => string;
	/** Style for the tab under the mouse pointer. */
	hoverTab?: (text: string, strength: number) => string;
}

/** Horizontal tab bar component. */
export class TabBar implements Component {
	#tabs: Tab[];
	#activeIndex: number = 0;
	#theme: TabBarTheme;
	#label: string;
	#hoverTabId: string | null = null;
	/**
	 * The cross-fade, once a host has offered a way to repaint between mouse
	 * reports ({@link setHoverMotion}). Absent, the band is switched: exactly the
	 * behavior every existing host has.
	 */
	#hoverFade?: HoverFade<string>;
	/** Per-render tab hit zones: 0-based line + [start, end) columns. */
	#hitZones: { line: number; start: number; end: number; index: number }[] = [];

	/** Callback fired when the active tab changes */
	onTabChange?: (tab: Tab, index: number) => void;

	/** Render the trailing "(tab to cycle)" hint. Disable when the host folds the hint into its own footer. */
	showHint = true;

	constructor(label: string, tabs: Tab[], theme: TabBarTheme, initialIndex: number = 0) {
		this.#label = label;
		this.#tabs = tabs;
		this.#theme = theme;
		this.#activeIndex = initialIndex;
	}

	/** Get the currently active tab */
	getActiveTab(): Tab {
		return this.#tabs[this.#activeIndex];
	}

	/** Get the index of the currently active tab */
	getActiveIndex(): number {
		return this.#activeIndex;
	}

	/** Set the active tab by index (clamped to valid range) */
	setActiveIndex(index: number): void {
		// `clampLow` for the same reason `setTabs` below uses it: with no tabs the
		// high bound is -1, and `clamp` returns that inverted bound, which would
		// report tab -1 and hand `onTabChange` an undefined tab.
		const newIndex = clampLow(index, 0, this.#tabs.length - 1);
		if (newIndex !== this.#activeIndex) {
			this.#activeIndex = newIndex;
			this.onTabChange?.(this.#tabs[this.#activeIndex], this.#activeIndex);
		}
	}

	/**
	 * Replace the tab set without firing onTabChange. The active tab is
	 * preserved by id when it survives the swap (or forced via `activeId`);
	 * otherwise the index is clamped.
	 */
	setTabs(tabs: Tab[], activeId?: string): void {
		const targetId = activeId ?? this.#tabs[this.#activeIndex]?.id;
		this.#tabs = tabs;
		const index = tabs.findIndex(tab => tab.id === targetId);
		this.#activeIndex = index >= 0 ? index : clampLow(this.#activeIndex, 0, tabs.length - 1);
	}

	/** Set the active tab by id without firing onTabChange. Returns false when the id is unknown. */
	setActiveById(id: string): boolean {
		const index = this.#tabs.findIndex(tab => tab.id === id);
		if (index === -1) return false;
		this.#activeIndex = index;
		return true;
	}

	/** Activate the tab with `id`, firing onTabChange when it changes. Muted tabs are ignored. */
	selectTab(id: string): boolean {
		const index = this.#tabs.findIndex(tab => tab.id === id);
		if (index === -1 || this.#tabs[index]?.muted) return false;
		this.setActiveIndex(index);
		return true;
	}

	/** Move to the next non-muted tab (wraps to first tab after last) */
	nextTab(): void {
		this.#stepTab(1);
	}

	/** Move to the previous non-muted tab (wraps to last tab before first) */
	prevTab(): void {
		this.#stepTab(-1);
	}

	/** Step to the nearest non-muted tab in `delta` direction; no-op when none exists. */
	#stepTab(delta: -1 | 1): void {
		const len = this.#tabs.length;
		if (len === 0) return;
		for (let step = 1; step <= len; step++) {
			const index = (((this.#activeIndex + delta * step) % len) + len) % len;
			if (!this.#tabs[index]?.muted) {
				this.setActiveIndex(index);
				return;
			}
		}
	}

	invalidate(): void {
		// No cached state to invalidate
	}

	/**
	 * Handle keyboard input for tab navigation.
	 * @returns true if the input was handled, false otherwise
	 */
	handleInput(data: string): boolean {
		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			this.nextTab();
			return true;
		}
		if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
			this.prevTab();
			return true;
		}
		return false;
	}

	/** Render the tab bar horizontally, collapsing to short form on overflow. */
	render(width: number): readonly string[] {
		// A zero-column bar has nothing legal to draw: `truncateToWidth(text, 0)`
		// still returns the ellipsis, which is one cell wider than the space the
		// caller has, and a component that overruns its width corrupts every
		// line to its right. Report the row as empty instead.
		if (!(width >= 1)) return [""];
		const maxWidth = Math.max(1, width);

		interface TabChunk {
			text: string;
			/** Index into #tabs when this chunk is a clickable tab button. */
			tabIndex?: number;
		}

		const buildChunks = (labels: readonly string[]): TabChunk[] => {
			const chunks: TabChunk[] = [];
			// Label prefix (omitted when the label is empty)
			if (this.#label) {
				chunks.push({ text: this.#theme.label(`${this.#label}:`) });
				chunks.push({ text: "  " });
			}
			for (let i = 0; i < this.#tabs.length; i++) {
				const tab = this.#tabs[i];
				chunks.push({ text: this.#paintTab(tab, i, ` ${labels[i]} `), tabIndex: i });
				if (i < this.#tabs.length - 1) {
					chunks.push({ text: "  " });
				}
			}
			// Navigation hint
			if (this.showHint) {
				chunks.push({ text: "  " });
				chunks.push({ text: this.#theme.hint("(tab to cycle)") });
			}
			return chunks;
		};
		const totalWidth = (chunks: TabChunk[]): number => {
			let sum = 0;
			for (let ci = 0; ci < chunks.length; ci++) sum += visibleWidth(chunks[ci]!.text);
			return sum;
		};

		const labels = new Array<string>(this.#tabs.length);
		for (let ti = 0; ti < this.#tabs.length; ti++) labels[ti] = this.#tabs[ti]!.label;
		let chunks = buildChunks(labels);

		if (totalWidth(chunks) > maxWidth) {
			const collapseOrder: number[] = [];
			for (let ti = 0; ti < this.#tabs.length; ti++) {
				if (ti !== this.#activeIndex && this.#tabs[ti]!.short !== undefined) collapseOrder.push(ti);
			}
			collapseOrder.sort((a, b) => Math.abs(b - this.#activeIndex) - Math.abs(a - this.#activeIndex));
			for (let ci = 0; ci < collapseOrder.length; ci++) {
				const index = collapseOrder[ci]!;
				labels[index] = this.#tabs[index]!.short ?? this.#tabs[index]!.label;
				chunks = buildChunks(labels);
				if (totalWidth(chunks) <= maxWidth) break;
			}
		}

		this.#hitZones = [];
		const lines: string[] = [];
		let currentLine = "";
		let currentWidth = 0;

		for (let chi = 0; chi < chunks.length; chi++) {
			const chunk = chunks[chi]!;
			const chunkWidth = visibleWidth(chunk.text);
			if (chunkWidth <= 0) {
				continue;
			}

			if (chunkWidth > maxWidth) {
				if (currentLine) {
					lines.push(currentLine);
					currentLine = "";
					currentWidth = 0;
				}
				if (chunk.tabIndex !== undefined) {
					this.#hitZones.push({ line: lines.length, start: 0, end: maxWidth, index: chunk.tabIndex });
				}
				lines.push(truncateToWidth(chunk.text, maxWidth));
				continue;
			}

			if (currentWidth > 0 && currentWidth + chunkWidth > maxWidth) {
				lines.push(currentLine);
				currentLine = "";
				currentWidth = 0;
			}

			if (chunk.tabIndex !== undefined) {
				this.#hitZones.push({
					line: lines.length,
					start: currentWidth,
					end: currentWidth + chunkWidth,
					index: chunk.tabIndex,
				});
			}
			currentLine += chunk.text;
			currentWidth += chunkWidth;
		}

		if (currentLine) {
			lines.push(currentLine);
		}

		return lines.length > 0 ? lines : [""];
	}

	/** Render tabs vertically as a sidebar column. */
	renderVertical(width: number, cursor = "> "): readonly string[] {
		// Same zero-width contract as the horizontal bar, and the same reason.
		if (!(width >= 1)) return [""];
		const maxWidth = Math.max(1, width);
		const cursorW = visibleWidth(cursor);
		this.#hitZones = [];
		const lines: string[] = [];
		for (let i = 0; i < this.#tabs.length; i++) {
			const tab = this.#tabs[i];
			// Muted tabs never take the active highlight (matches render()).
			const active = i === this.#activeIndex && !tab.muted;
			let label = tab.label;
			if (cursorW + visibleWidth(label) > maxWidth && tab.short !== undefined) {
				label = tab.short;
			}
			const text = truncateToWidth(`${active ? cursor : padding(cursorW)}${label}`, maxWidth, undefined, true);
			this.#hitZones.push({ line: i, start: 0, end: maxWidth, index: i });
			lines.push(this.#paintTab(tab, i, text));
		}
		return lines.length > 0 ? lines : [""];
	}

	/**
	 * Resolve a pointer position against the last rendered frame. `line` is the
	 * 0-based line index within this component's render output, `col` the
	 * 0-based column.
	 */
	tabAt(line: number, col: number): Tab | undefined {
		for (let zi = 0; zi < this.#hitZones.length; zi++) {
			const zone = this.#hitZones[zi]!;
			if (zone.line === line && col >= zone.start && col < zone.end) {
				return this.#tabs[zone.index];
			}
		}
		return undefined;
	}

	/** Highlight the tab under the pointer (null clears). */
	setHoverTab(id: string | null): void {
		this.#hoverTabId = id;
		this.#hoverFade?.set(id);
	}

	/** Configure hover cross-fade motion. */
	setHoverMotion(options: HoverFadeOptions): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = new HoverFade<string>(options);
		if (this.#hoverTabId !== null) this.#hoverFade.set(this.#hoverTabId);
	}

	/** Cancel every fade and forget the pointer. The bar paints no band after this. */
	disposeHoverMotion(): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoverTabId = null;
	}

	/** Resolved hover band strength for a tab index (0 to 1). */
	#hoverStrength(tab: Tab): number {
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(tab.id);
		return tab.id === this.#hoverTabId ? 1 : 0;
	}

	/** Style a tab based on active, muted, and hover state. */
	#paintTab(tab: Tab, index: number, text: string): string {
		if (tab.muted) return (this.#theme.mutedTab ?? this.#theme.inactiveTab)(text);
		if (index === this.#activeIndex) return this.#theme.activeTab(text);
		const strength = this.#hoverStrength(tab);
		const band = this.#theme.hoverTab;
		return band !== undefined && strength > 0 ? band(text, strength) : this.#theme.inactiveTab(text);
	}
}
