import { matchesKey } from "../keys";
import { HoverFade, type HoverFadeOptions } from "../motion-hover";
import type { Component } from "../tui";
import { clampLow, padding, truncateToWidth, visibleWidth } from "../utils";

export interface Tab {
	id: string;
	label: string;
	short?: string;
	muted?: boolean;
}

export interface TabBarTheme {
	label: (text: string) => string;
	activeTab: (text: string) => string;
	inactiveTab: (text: string) => string;
	hint: (text: string) => string;
	mutedTab?: (text: string) => string;
	hoverTab?: (text: string, strength: number) => string;
}

export class TabBar implements Component {
	#tabs: Tab[];
	#activeIndex: number = 0;
	#theme: TabBarTheme;
	#label: string;
	#hoverTabId: string | null = null;
	#hoverFade?: HoverFade<string>;
	#hitZones: { line: number; start: number; end: number; index: number }[] = [];

	onTabChange?: (tab: Tab, index: number) => void;

	showHint = true;

	constructor(label: string, tabs: Tab[], theme: TabBarTheme, initialIndex: number = 0) {
		this.#label = label;
		this.#tabs = tabs;
		this.#theme = theme;
		this.#activeIndex = initialIndex;
	}

	getActiveTab(): Tab {
		return this.#tabs[this.#activeIndex];
	}

	getActiveIndex(): number {
		return this.#activeIndex;
	}

	setActiveIndex(index: number): void {
		const newIndex = clampLow(index, 0, this.#tabs.length - 1);
		if (newIndex !== this.#activeIndex) {
			this.#activeIndex = newIndex;
			this.onTabChange?.(this.#tabs[this.#activeIndex], this.#activeIndex);
		}
	}

	setTabs(tabs: Tab[], activeId?: string): void {
		const targetId = activeId ?? this.#tabs[this.#activeIndex]?.id;
		this.#tabs = tabs;
		const index = tabs.findIndex(tab => tab.id === targetId);
		this.#activeIndex = index >= 0 ? index : clampLow(this.#activeIndex, 0, tabs.length - 1);
	}

	setActiveById(id: string): boolean {
		const index = this.#tabs.findIndex(tab => tab.id === id);
		if (index === -1) return false;
		this.#activeIndex = index;
		return true;
	}

	selectTab(id: string): boolean {
		const index = this.#tabs.findIndex(tab => tab.id === id);
		if (index === -1 || this.#tabs[index]?.muted) return false;
		this.setActiveIndex(index);
		return true;
	}

	nextTab(): void {
		this.#stepTab(1);
	}

	prevTab(): void {
		this.#stepTab(-1);
	}

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

	invalidate(): void {}

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

	render(width: number): readonly string[] {
		if (!(width >= 1)) return [""];
		const maxWidth = Math.max(1, width);

		interface TabChunk {
			text: string;
			tabIndex?: number;
		}

		const buildChunks = (labels: readonly string[]): TabChunk[] => {
			const chunks: TabChunk[] = [];
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

	renderVertical(width: number, cursor = "> "): readonly string[] {
		if (!(width >= 1)) return [""];
		const maxWidth = Math.max(1, width);
		const cursorW = visibleWidth(cursor);
		this.#hitZones = [];
		const lines: string[] = [];
		for (let i = 0; i < this.#tabs.length; i++) {
			const tab = this.#tabs[i];
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

	tabAt(line: number, col: number): Tab | undefined {
		for (let zi = 0; zi < this.#hitZones.length; zi++) {
			const zone = this.#hitZones[zi]!;
			if (zone.line === line && col >= zone.start && col < zone.end) {
				return this.#tabs[zone.index];
			}
		}
		return undefined;
	}

	setHoverTab(id: string | null): void {
		this.#hoverTabId = id;
		this.#hoverFade?.set(id);
	}

	setHoverMotion(options: HoverFadeOptions): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = new HoverFade<string>(options);
		if (this.#hoverTabId !== null) this.#hoverFade.set(this.#hoverTabId);
	}

	disposeHoverMotion(): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoverTabId = null;
	}

	#hoverStrength(tab: Tab): number {
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(tab.id);
		return tab.id === this.#hoverTabId ? 1 : 0;
	}

	#paintTab(tab: Tab, index: number, text: string): string {
		if (tab.muted) return (this.#theme.mutedTab ?? this.#theme.inactiveTab)(text);
		if (index === this.#activeIndex) return this.#theme.activeTab(text);
		const strength = this.#hoverStrength(tab);
		const band = this.#theme.hoverTab;
		return band !== undefined && strength > 0 ? band(text, strength) : this.#theme.inactiveTab(text);
	}
}
