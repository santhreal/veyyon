import {
	type Component,
	Container,
	FuzzyText,
	HoverFade,
	type HoverFadeOptions,
	Input,
	matchesKey,
	padding,
	replaceTabs,
	routeSgrMouseInput,
	ScrollView,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui";
import { clampLow, errorMessage, formatBytes } from "@veyyon/utils";
import { withIcon } from "../../modes/theme/icon-label";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { SessionInfo } from "../../session/session-listing";
import { shortenPath } from "../../tools/render-utils";
import { HookSelectorComponent } from "./hook-selector";
import {
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	type ModalShellGeometry,
	type ModalShortcut,
	pointerMotionEnabled,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";
import { hoverBandAt, SCROLL_LIST_THEME } from "./selector-helpers";
import type { RankedSessionMatch, SessionHistoryMatcher } from "./session-selector-helpers";
import {
	compareFuzzyRank,
	compareLiteralRank,
	FUZZY_SCAN_CHUNK_COUNT,
	FUZZY_SCAN_INLINE_COUNT,
	formatSessionStatus,
	HISTORY_MERGE_DEBOUNCE_MS,
	HISTORY_MERGE_MIN_QUERY,
	isLiteralMatch,
	mergeSessionRanking,
	scoreFuzzySession,
	sessionTextLower,
	tokenizeSessionQuery,
} from "./session-selector-helpers";

export { rankSessionSearchMatches } from "./session-selector-helpers";
export { mergeSessionRanking };

class SessionList implements Component {
	#filteredSessions: SessionInfo[] = [];
	#selectedIndex: number = 0;
	#hitRows: (number | undefined)[] = [];
	#hoveredIndex: number | null = null;
	#hoverFade?: HoverFade;
	readonly #searchInput: Input;
	onSelect?: (session: SessionInfo) => void;
	onCancel?: () => void;
	onExit: () => void = () => {};
	onToggleScope?: () => void;
	readonly #getTerminalRows: () => number;

	onDeleteRequest?: (session: SessionInfo) => void;

	#allSessions: SessionInfo[];
	#showCwd: boolean;
	readonly #historyMatcher?: SessionHistoryMatcher;
	#historyMergeTimer: NodeJS.Timeout | undefined;
	onRequestRender?: () => void;

	#literalRanked: RankedSessionMatch[] = [];
	#fuzzyRanked: RankedSessionMatch[] = [];
	#historyIds: string[] = [];
	#scanGeneration = 0;
	#scanTimer: NodeJS.Timeout | undefined;
	#selectionMoved = false;

	constructor(
		sessions: SessionInfo[],
		showCwd = false,
		historyMatcher?: SessionHistoryMatcher,
		getTerminalRows: () => number = () => 24,
	) {
		this.#getTerminalRows = getTerminalRows;
		this.#allSessions = sessions;
		this.#showCwd = showCwd;
		this.#historyMatcher = historyMatcher;
		this.#filteredSessions = sessions;
		this.#searchInput = new Input();

		this.#searchInput.onSubmit = () => {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected) {
				this.onSelect?.(selected);
			}
		};
	}

	#visibleCount(): number {
		const CHROME = 12;
		const PER_SESSION = 4;
		const RESERVE = 1;
		const budget = this.#getTerminalRows() - CHROME - RESERVE;
		return Math.max(2, Math.floor(budget / PER_SESSION));
	}

	setSessions(sessions: SessionInfo[], showCwd: boolean): void {
		this.#allSessions = sessions;
		this.#showCwd = showCwd;
		this.#selectedIndex = 0;
		this.#filterSessions(this.#searchInput.getValue());
	}

	#filterSessions(query: string): void {
		this.#scanGeneration++;
		if (this.#scanTimer !== undefined) {
			clearTimeout(this.#scanTimer);
			this.#scanTimer = undefined;
		}
		this.#selectionMoved = false;
		this.#historyIds = [];
		this.#literalRanked = [];
		this.#fuzzyRanked = [];

		const tokens = tokenizeSessionQuery(query);
		if (tokens.length === 0) {
			this.#filteredSessions = this.#allSessions;
			this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#filteredSessions.length - 1));
			this.#scheduleHistoryMerge(query);
			return;
		}

		const literal: RankedSessionMatch[] = [];
		const rest: number[] = [];
		const all = this.#allSessions;
		for (let index = 0; index < all.length; index++) {
			if (isLiteralMatch(sessionTextLower(all[index]!), tokens)) {
				literal.push({ session: all[index]!, score: 0, index });
			} else {
				rest.push(index);
			}
		}
		literal.sort(compareLiteralRank);
		this.#literalRanked = literal;

		this.#scanFuzzySlice(this.#scanGeneration, tokens, rest, 0, FUZZY_SCAN_INLINE_COUNT);
		this.#composeFiltered();
		this.#scheduleHistoryMerge(query);
	}

	#scanFuzzySlice(generation: number, tokens: string[], rest: number[], start: number, budget: number): void {
		const all = this.#allSessions;
		const end = Math.min(rest.length, start + budget);
		for (let i = start; i < end; i++) {
			const index = rest[i]!;
			const session = all[index]!;
			const match = scoreFuzzySession(session, index, tokens, new FuzzyText(sessionTextLower(session)));
			if (match) this.#fuzzyRanked.push(match);
		}
		if (end >= rest.length) return;
		this.#scanTimer = setTimeout(() => {
			this.#scanTimer = undefined;
			if (generation !== this.#scanGeneration) return;
			const before = this.#fuzzyRanked.length;
			this.#scanFuzzySlice(generation, tokens, rest, end, FUZZY_SCAN_CHUNK_COUNT);
			if (this.#fuzzyRanked.length > before) {
				this.#composeFiltered();
				this.onRequestRender?.();
			}
		}, 0);
	}

	#composeFiltered(): void {
		this.#fuzzyRanked.sort(compareFuzzyRank);
		const base: SessionInfo[] = [];
		for (const match of this.#literalRanked) base.push(match.session);
		for (const match of this.#fuzzyRanked) base.push(match.session);
		this.#filteredSessions =
			this.#historyIds.length > 0 ? mergeSessionRanking(this.#allSessions, base, this.#historyIds) : base;
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#filteredSessions.length - 1));
	}

	#scheduleHistoryMerge(query: string): void {
		if (this.#historyMergeTimer !== undefined) {
			clearTimeout(this.#historyMergeTimer);
			this.#historyMergeTimer = undefined;
		}
		const matcher = this.#historyMatcher;
		const trimmed = query.trim();
		if (!matcher || trimmed.length < HISTORY_MERGE_MIN_QUERY) return;
		this.#historyMergeTimer = setTimeout(() => {
			this.#historyMergeTimer = undefined;
			if (this.#searchInput.getValue() !== query) return;
			if (this.#selectionMoved) return;
			const historyIds = matcher(trimmed);
			if (historyIds.length === 0) return;
			this.#historyIds = historyIds;
			this.#composeFiltered();
			this.onRequestRender?.();
		}, HISTORY_MERGE_DEBOUNCE_MS);
	}

	dispose(): void {
		this.#scanGeneration++;
		if (this.#scanTimer !== undefined) {
			clearTimeout(this.#scanTimer);
			this.#scanTimer = undefined;
		}
		if (this.#historyMergeTimer !== undefined) {
			clearTimeout(this.#historyMergeTimer);
			this.#historyMergeTimer = undefined;
		}
		this.disposeHoverMotion();
	}

	removeSession(sessionPath: string): void {
		const index = this.#allSessions.findIndex(s => s.path === sessionPath);
		if (index === -1) return;
		this.#allSessions.splice(index, 1);
		this.#filterSessions(this.#searchInput.getValue());
		if (this.#selectedIndex >= this.#filteredSessions.length) {
			this.#selectedIndex = Math.max(0, this.#filteredSessions.length - 1);
		}
	}

	hitTestSession(line: number): number | undefined {
		return this.#hitRows[line];
	}

	setHoverIndex(index: number | null): boolean {
		if (this.#hoveredIndex === index) return false;
		this.#hoveredIndex = index;
		this.#hoverFade?.set(index);
		return true;
	}

	setHoverMotion(options: HoverFadeOptions): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = new HoverFade(options);
		if (this.#hoveredIndex !== null) this.#hoverFade.set(this.#hoveredIndex);
	}

	disposeHoverMotion(): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoveredIndex = null;
	}

	#hoverStrength(index: number): number {
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(index);
		return index === this.#hoveredIndex ? 1 : 0;
	}

	handleWheel(delta: -1 | 1): void {
		if (this.#filteredSessions.length === 0) return;
		this.#selectionMoved = true;
		this.#selectedIndex = clampLow(this.#selectedIndex + delta, 0, this.#filteredSessions.length - 1);
	}

	selectAndConfirm(index: number): void {
		const session = this.#filteredSessions[index];
		if (!session) return;
		this.#selectedIndex = index;
		this.onSelect?.(session);
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		this.#hitRows = [];

		const siLines = this.#searchInput.render(width);
		for (let li = 0; li < siLines.length; li++) lines.push(siLines[li]!);
		lines.push(""); // Blank line after search

		if (this.#filteredSessions.length === 0) {
			if (this.#showCwd) {
				lines.push(truncateToWidth(theme.fg("muted", "  No sessions found"), width));
			} else {
				lines.push(
					truncateToWidth(theme.fg("muted", "  No sessions in current folder. Press Tab to view all."), width),
				);
			}
			return lines;
		}

		const formatDate = (date: Date): string => {
			const now = new Date();
			const diffMs = now.getTime() - date.getTime();
			const diffMins = Math.floor(diffMs / 60000);
			const diffHours = Math.floor(diffMs / 3600000);
			const diffDays = Math.floor(diffMs / 86400000);

			if (diffMins < 1) return "just now";
			if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
			if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
			if (diffDays === 1) return "1 day ago";
			if (diffDays < 7) return `${diffDays} days ago`;

			return date.toLocaleDateString();
		};

		const maxVisible = this.#visibleCount();
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), this.#filteredSessions.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.#filteredSessions.length);

		const sessionLines: string[] = [];
		const sessionRowIndex: number[] = [];
		const overflow = this.#filteredSessions.length > maxVisible;
		const rowWidth = Math.max(0, width - (overflow ? 1 : 0));
		for (let i = startIndex; i < endIndex; i++) {
			const blockStart = sessionLines.length;
			const session = this.#filteredSessions[i];
			const isSelected = i === this.#selectedIndex;
			const hoverStrength = this.#hoverStrength(i);

			const normalizedMessage = session.firstMessage.replace(/\n/g, " ").trim();

			const cursorSymbol = `${theme.nav.cursor} `;
			const cursorWidth = visibleWidth(cursorSymbol);
			const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(cursorWidth);
			const maxWidth = rowWidth - cursorWidth; // Account for cursor width

			if (session.title) {
				const truncatedTitle = truncateToWidth(session.title, maxWidth);
				const titleLine = cursor + (isSelected ? theme.bold(truncatedTitle) : truncatedTitle);
				sessionLines.push(titleLine);

				const truncatedPreview = truncateToWidth(normalizedMessage, maxWidth);
				sessionLines.push(`  ${theme.fg("dim", truncatedPreview)}`);
			} else {
				const truncatedMsg = truncateToWidth(normalizedMessage, maxWidth);
				const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);
				sessionLines.push(messageLine);
			}

			const dim = (s: string) => theme.fg("dim", s);
			const dot = dim(theme.sep.dot);
			const modified = formatDate(session.modified);
			let metadata = `  ${dim(modified)} ${dot} ${dim(formatBytes(session.size))}`;
			const status = formatSessionStatus(session.status);
			if (status) {
				metadata += ` ${dot} ${status}`;
			}
			if (session.parentSessionPath) {
				metadata += ` ${dot} ${dim(withIcon(theme.icon.branch, "fork"))}`;
			}
			if (this.#showCwd && session.cwd) {
				metadata += ` ${dot} ${dim(shortenPath(session.cwd))}`;
			}
			const metadataLine = truncateToWidth(metadata, rowWidth);

			sessionLines.push(metadataLine);
			if (hoverStrength > 0) {
				for (let k = blockStart; k < sessionLines.length; k++) {
					sessionLines[k] = hoverBandAt(sessionLines[k]!, rowWidth, hoverStrength);
				}
			}
			sessionLines.push(""); // Blank line between sessions
			for (let k = blockStart; k < sessionLines.length; k++) sessionRowIndex[k] = i;
		}

		const visibleCount = endIndex - startIndex;
		const linesPerItem = visibleCount > 0 ? sessionLines.length / visibleCount : 1;
		const sv = new ScrollView(sessionLines, {
			height: sessionLines.length,
			scrollbar: "auto",
			totalRows: Math.round(this.#filteredSessions.length * linesPerItem),
			theme: SCROLL_LIST_THEME,
		});
		sv.setScrollOffset(Math.round(startIndex * linesPerItem));
		const sessionRegionStart = lines.length;
		const svLines = sv.render(width);
		for (let k = 0; k < svLines.length; k++) this.#hitRows[sessionRegionStart + k] = sessionRowIndex[k];
		const sl = svLines;
		for (let li = 0; li < sl.length; li++) lines.push(sl[li]!);

		return lines;
	}

	handleInput(keyData: string): void {
		if (
			matchesKey(keyData, "delete") ||
			(matchesKey(keyData, "backspace") && this.#searchInput.getValue().length === 0)
		) {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected && this.onDeleteRequest) {
				this.onDeleteRequest(selected);
			}
			return;
		}
		if (matchesSelectUp(keyData)) {
			this.#selectionMoved = true;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			return;
		}
		if (matchesSelectDown(keyData)) {
			this.#selectionMoved = true;
			this.#selectedIndex = Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + 1);
			return;
		}
		if (matchesKey(keyData, "pageUp")) {
			this.#selectionMoved = true;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.#visibleCount());
			return;
		}
		if (matchesKey(keyData, "pageDown")) {
			this.#selectionMoved = true;
			this.#selectedIndex = Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + this.#visibleCount());
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected);
			}
			return;
		}
		if (matchesAppInterrupt(keyData)) {
			if (this.onCancel) {
				this.onCancel();
			}
			return;
		}
		if (matchesKey(keyData, "ctrl+c")) {
			this.onExit();
			return;
		}
		if (matchesKey(keyData, "tab")) {
			this.onToggleScope?.();
			return;
		}
		this.#searchInput.handleInput(keyData);
		this.#filterSessions(this.#searchInput.getValue());
	}
}

export interface SessionSelectorOptions {
	onDelete?: (session: SessionInfo) => Promise<boolean>;
	historyMatcher?: SessionHistoryMatcher;
	loadAllSessions?: () => Promise<SessionInfo[]>;
	allSessions?: SessionInfo[];
	getTerminalRows?: () => number;
	fillHeight?: boolean;
}

export class SessionSelectorComponent extends Container {
	#sessionList: SessionList;
	#confirmationDialog: HookSelectorComponent | null = null;
	#contentSlot: Container;
	#messageContainer: Container;
	#headerText: Text;
	#onDelete?: (session: SessionInfo) => Promise<boolean>;
	#onRequestRender?: () => void;
	readonly #loadAllSessions?: () => Promise<SessionInfo[]>;
	#folderSessions: SessionInfo[];
	#globalSessions: SessionInfo[] | null = null;
	#scope: "folder" | "all" = "folder";
	#toggling = false;
	#listLineOffset = 0;
	#footerStart = 0;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	readonly #getTerminalRows: () => number;
	readonly #fillHeight: boolean;
	#bodyRowsHighWater = 0;

	constructor(
		sessions: SessionInfo[],
		onSelect: (session: SessionInfo) => void,
		onCancel: () => void,
		onExit: () => void,
		options: SessionSelectorOptions = {},
	) {
		super();

		this.#messageContainer = new Container();
		this.#onDelete = options.onDelete;
		this.#loadAllSessions = options.loadAllSessions;
		this.#folderSessions = sessions;
		this.#globalSessions = options.allSessions ?? null;
		this.#getTerminalRows = options.getTerminalRows ?? (() => 24);
		this.#fillHeight = options.fillHeight ?? false;
		this.#headerText = new Text(this.#headerLabel(), 1, 0);
		this.addChild(this.#headerText);
		this.addChild(this.#messageContainer);
		this.#sessionList = new SessionList(sessions, false, options.historyMatcher, options.getTerminalRows);
		this.#sessionList.onSelect = session => {
			this.#sessionList.dispose();
			onSelect(session);
		};
		this.#sessionList.onCancel = () => {
			this.#sessionList.dispose();
			onCancel();
		};
		this.#sessionList.onExit = () => {
			this.#sessionList.dispose();
			onExit();
		};
		this.#sessionList.onRequestRender = () => this.#onRequestRender?.();
		this.#sessionList.onDeleteRequest = (session: SessionInfo) => {
			this.#showDeleteConfirmation(session);
		};
		if (this.#loadAllSessions || this.#globalSessions) {
			this.#sessionList.onToggleScope = () => {
				void this.#toggleScope();
			};
		}
		this.#contentSlot = new Container();
		this.#contentSlot.addChild(this.#sessionList);
		this.addChild(this.#contentSlot);
	}

	#headerLabel(): string {
		return "";
	}

	async #toggleScope(): Promise<void> {
		if (this.#toggling || this.#confirmationDialog) return;
		if (this.#scope === "folder") {
			let global = this.#globalSessions;
			if (!global) {
				if (!this.#loadAllSessions) return;
				this.#toggling = true;
				this.#messageContainer.clear();
				this.#messageContainer.addChild(new Text(theme.fg("muted", "  Loading all projects…"), 1, 0));
				this.#onRequestRender?.();
				try {
					global = await this.#loadAllSessions();
				} catch (err) {
					this.#showError(errorMessage(err));
					this.#toggling = false;
					this.#onRequestRender?.();
					return;
				}
				this.#globalSessions = global;
				this.#messageContainer.clear();
				this.#toggling = false;
			}
			this.#scope = "all";
			this.#sessionList.setSessions(global, true);
		} else {
			this.#scope = "folder";
			this.#sessionList.setSessions(this.#folderSessions, false);
		}
		this.#headerText.setText(this.#headerLabel());
		this.#onRequestRender?.();
	}

	setOnRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
		this.#sessionList.setHoverMotion({ requestRender: callback, enabled: pointerMotionEnabled() });
	}

	dispose(): void {
		this.#sessionList.dispose();
		super.dispose();
	}

	#clearError(): void {
		this.#messageContainer.clear();
	}

	#showError(message: string): void {
		this.#messageContainer.clear();
		this.#messageContainer.addChild(new Text(theme.fg("error", `Error: ${replaceTabs(message)}`), 1, 0));
		this.#messageContainer.addChild(new Spacer(1));
	}

	#showDeleteConfirmation(session: SessionInfo): void {
		const displayName = session.title || session.firstMessage.slice(0, 40) || session.id;
		const closeDialog = () => {
			this.#confirmationDialog = null;
			this.#contentSlot.clear();
			this.#contentSlot.addChild(this.#sessionList);
			this.#onRequestRender?.();
		};
		this.#confirmationDialog = new HookSelectorComponent(
			`Delete session?\n${displayName}`,
			["Yes", "No"],
			async (option: string) => {
				if (option === "Yes" && this.#onDelete) {
					this.#clearError();
					try {
						const deleted = await this.#onDelete(session);
						if (deleted) {
							this.#sessionList.removeSession(session.path);
						}
					} catch (err) {
						this.#showError(errorMessage(err));
					}
				}
				closeDialog();
			},
			closeDialog,
			{ initialIndex: 1, presentation: "embedded" },
		);
		this.#contentSlot.clear();
		this.#contentSlot.addChild(this.#confirmationDialog);
		this.#onRequestRender?.();
	}

	render(width: number): readonly string[] {
		const termHeight = Math.max(14, this.#getTerminalRows());
		const sizing = sizingForArea(MODAL_SIZING_LARGE, termHeight, !this.#fillHeight);
		const dims = computeModalDims(width, termHeight, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return new Array(termHeight).fill(padding(width));
		}

		const body: string[] = [];
		const headerLines = this.#headerText.render(dims.contentWidth);
		for (let li = 0; li < headerLines.length; li++) body.push(headerLines[li]!);
		const msgLines = this.#messageContainer.render(dims.contentWidth);
		for (let li = 0; li < msgLines.length; li++) body.push(msgLines[li]!);
		this.#listLineOffset = body.length;
		const slotLines = this.#contentSlot.render(dims.contentWidth);
		for (let li = 0; li < slotLines.length; li++) body.push(slotLines[li]!);

		const scopeLabel = this.#scope === "all" ? "current folder" : "all projects";
		const shortcuts: readonly ModalShortcut[] = this.#confirmationDialog
			? [
					{ label: "navigate", keybindings: ["tui.select.up", "tui.select.down"] },
					{ label: "enter confirm", clickable: true, id: "confirm" },
					{ label: "esc cancel", clickable: true, id: "close" },
				]
			: [
					{ label: "enter select", clickable: true, id: "confirm" },
					{ label: "del delete", clickable: true, id: "delete" },
					{ label: `tab ${scopeLabel}` },
					{ label: "esc close", clickable: true, id: "close" },
				];
		const shell = renderModalShell({
			title: "Resume Session",
			breadcrumb: this.#scope === "all" ? " · all projects" : " · current folder",
			sizing,
			areaWidth: width,
			areaHeight: termHeight,
			body,
			preferredBodyRows: this.#bodyRowsHighWater,
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});

		this.#shellGeometry = shell.geometry;
		this.#listLineOffset = (shell.geometry?.bodyRowStart ?? 0) + this.#listLineOffset;
		this.#footerStart = shell.geometry?.footerRowStart ?? shell.lines.length;
		return shell.lines;
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<")) {
			this.#handleMouse(keyData);
			return;
		}
		if (this.#confirmationDialog) {
			this.#confirmationDialog.handleInput(keyData);
		} else {
			this.#sessionList.handleInput(keyData);
		}
	}

	#handleMouse(data: string): void {
		if (this.#confirmationDialog) {
			this.#handleConfirmationMouse(data);
			return;
		}
		routeSgrMouseInput(data, event => {
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
				this.#sessionList.onCancel?.();
				return true;
			}
			if (chrome.kind === "shortcut" && chrome.id === "confirm") {
				this.#sessionList.handleInput("\n");
				return true;
			}
			if (chrome.kind === "shortcut" && chrome.id === "delete") {
				this.#sessionList.handleInput("\x7f");
				return true;
			}
			if (event.wheel !== null) {
				this.#sessionList.handleWheel(event.wheel);
				return true;
			}
			if (event.motion) {
				const index = this.#sessionList.hitTestSession(event.row - this.#listLineOffset) ?? null;
				if (this.#sessionList.setHoverIndex(index)) this.#onRequestRender?.();
				return true;
			}
			if (!event.leftClick || event.row >= this.#footerStart) return true;
			const index = this.#sessionList.hitTestSession(event.row - this.#listLineOffset);
			if (index !== undefined) this.#sessionList.selectAndConfirm(index);
			return true;
		});
	}

	#handleConfirmationMouse(data: string): void {
		routeSgrMouseInput(data, event => {
			const dialog = this.#confirmationDialog;
			if (!dialog) return true;
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
				dialog.handleInput("\x1b");
				return true;
			}
			if (chrome.kind === "shortcut" && chrome.id === "confirm") {
				dialog.handleInput("\n");
				return true;
			}
			if (event.wheel !== null) {
				dialog.handleWheel(event.wheel);
				this.#onRequestRender?.();
				return true;
			}
			const line = event.row - this.#listLineOffset;
			if (event.motion) {
				if (dialog.setHoveredOption(dialog.hitTestOption(line) ?? null)) this.#onRequestRender?.();
				return true;
			}
			if (event.leftClick) dialog.selectOptionAt(line);
			return true;
		});
	}

	getSessionList(): SessionList {
		return this.#sessionList;
	}
}
