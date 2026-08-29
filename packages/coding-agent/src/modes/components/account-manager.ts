import { getOAuthProviders } from "@veyyon/ai/oauth";
import {
	type Component,
	extractPrintableText,
	fuzzyFilter,
	HoverFade,
	Input,
	matchesKey,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@veyyon/tui";
import { clampLow } from "@veyyon/utils";
import type { AccountInventory, AccountRow } from "../../session/account-inventory";
import { accountsForProvider, selectedButRotated } from "../../session/account-inventory";
import { formatProviderName } from "../../slash-commands/helpers/format";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import type { AccountManagerCallbacks, AccountManagerOptions, BodyLine, BodyTarget } from "./account-manager-helpers";
import {
	NOTE_MAX_LINES,
	SHORTCUT_KEYS,
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
	SIDEBAR_SUMMARY_ROWS,
} from "./account-manager-helpers";
import {
	type AccountGlyphKind,
	type AccountSidebarEntry,
	accountGlyphKind,
	accountHeadLine,
	accountNoticeLines,
	accountPlanLine,
	accountUsageLines,
	buildSidebarEntries,
	divergenceLines,
	providerDisabledNote,
	providerHeaderLine,
	sanitizeAccountText,
	sidebarSummaryLine,
} from "./account-manager-rows";
import {
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	type ModalShellGeometry,
	type ModalShortcut,
	planModalChrome,
	pointerMotionEnabled,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";
import { fit } from "./overlay-box";
import { hoverBandAt, renderScrollableList, selectionBand } from "./selector-helpers";

export type { AccountManagerCallbacks, AccountManagerOptions };

export class AccountManagerComponent implements Component {
	#inventory: AccountInventory;
	#callbacks: AccountManagerCallbacks;
	#requestRender?: () => void;
	#terminalHeight?: number;

	#entries: AccountSidebarEntry[] = [];
	#activeProviderId = "";
	#focus: "sidebar" | "body" = "body";
	#bodySelection: BodyTarget = { kind: "add" };

	#sidebarScroll = 0;
	#sidebarFollowActive = true;
	#sidebarHover: number | null = null;
	#sidebarFade: HoverFade | undefined;
	#bodyScroll = 0;

	#rename: { credentialId: number; input: Input } | null = null;
	#pendingLogoutCredentialId: number | null = null;

	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#frameLeft = 0;
	#contentRowStart = 0;
	#splitRowCount = 0;
	#sidebarWidthLast = SIDEBAR_MIN_WIDTH;
	#bodyLines: BodyLine[] = [];
	#loadBalancing = false;
	#searchQuery = "";
	#searching = false;

	constructor(inventory: AccountInventory, callbacks: AccountManagerCallbacks, options: AccountManagerOptions = {}) {
		this.#inventory = inventory;
		this.#callbacks = callbacks;
		this.#requestRender = options.requestRender;
		this.#terminalHeight = options.terminalHeight;
		this.#loadBalancing = options.loadBalancing ?? false;
		this.#rebuildEntries();
		const requested = options.initialProviderId;
		if (requested && this.#entries.some(entry => entry.providerId === requested)) {
			this.#activeProviderId = requested;
		}
		this.#selectFirstEntry();
		const requestRender = options.requestRender;
		if (requestRender) {
			this.#sidebarFade = new HoverFade({ requestRender, enabled: pointerMotionEnabled() });
		}
	}

	setInventory(next: AccountInventory): void {
		this.#inventory = next;
		this.#rebuildEntries();
		const rows = this.#rows();
		const selected = this.#selectedCredentialId();
		if (selected !== null && !rows.some(row => row.credentialId === selected)) {
			this.#selectFirstEntry();
			this.#rename = null;
			this.#pendingLogoutCredentialId = null;
		}
	}

	dispose(): void {
		this.#sidebarFade?.dispose();
		this.#sidebarFade = undefined;
		this.#sidebarHover = null;
	}

	#sidebarStrength(index: number): number {
		if (this.#sidebarFade !== undefined) return this.#sidebarFade.strengthAt(index);
		return index === this.#sidebarHover ? 1 : 0;
	}

	#rebuildEntries(): void {
		this.#entries = buildSidebarEntries(
			this.#inventory,
			getOAuthProviders().map(provider => {
				const id = provider.storeCredentialsAs ?? provider.id;
				return { id, label: formatProviderName(id) };
			}),
		);
		if (!this.#entries.some(entry => entry.providerId === this.#activeProviderId)) {
			this.#activeProviderId = this.#entries[0]?.providerId ?? "";
			this.#sidebarFollowActive = true;
		}
		if (this.#searchQuery.trim()) {
			const filtered = this.#filteredEntries;
			if (filtered.length > 0 && !filtered.some(entry => entry.providerId === this.#activeProviderId)) {
				this.#activeProviderId = filtered[0]?.providerId ?? this.#activeProviderId;
				this.#sidebarFollowActive = true;
				this.#selectFirstEntry();
			}
			this.#sidebarScroll = 0;
		}
	}

	#activeEntry(): AccountSidebarEntry | undefined {
		return this.#entries.find(entry => entry.providerId === this.#activeProviderId);
	}

	#rows(): readonly AccountRow[] {
		return accountsForProvider(this.#inventory, this.#activeProviderId);
	}

	#selectedCredentialId(): number | null {
		return this.#bodySelection.kind === "account" ? this.#bodySelection.credentialId : null;
	}

	#selectedRow(): AccountRow | undefined {
		const id = this.#selectedCredentialId();
		return id === null ? undefined : this.#rows().find(row => row.credentialId === id);
	}

	#selectFirstEntry(): void {
		const first = this.#rows()[0];
		this.#bodySelection = first ? { kind: "account", credentialId: first.credentialId } : { kind: "add" };
	}

	#isSelected(target: BodyTarget | undefined): boolean {
		if (!target) return false;
		const selection = this.#bodySelection;
		return target.kind === "add"
			? selection.kind === "add"
			: selection.kind === "account" && selection.credentialId === target.credentialId;
	}

	searching(): boolean {
		return this.#searching;
	}

	get #filteredEntries(): AccountSidebarEntry[] {
		const query = this.#searchQuery.trim();
		if (!query) return this.#entries;
		return fuzzyFilter(this.#entries, query, entry => `${entry.label} ${entry.providerId}`);
	}

	#setSearching(searching: boolean): void {
		if (this.#searching === searching) return;
		this.#searching = searching;
		if (searching) this.#focus = "sidebar";
		else this.#setSearchQuery("");
		this.#requestRender?.();
	}

	#setSearchQuery(query: string): void {
		this.#searchQuery = query;
		const filtered = this.#filteredEntries;
		if (filtered.length > 0 && !filtered.some(entry => entry.providerId === this.#activeProviderId)) {
			this.#activeProviderId = filtered[0]?.providerId ?? this.#activeProviderId;
			this.#bodyScroll = 0;
			this.#sidebarFollowActive = true;
			this.#selectFirstEntry();
		}
		this.#sidebarScroll = 0;
	}

	#handleSearchInput(data: string): boolean {
		if (!this.#searching) return false;
		if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
			const chars = [...this.#searchQuery];
			chars.pop();
			this.#setSearchQuery(chars.join(""));
			return true;
		}
		const printable = extractPrintableText(data);
		if (printable === undefined) return false;
		if (this.#searchQuery.length === 0 && printable.trim().length === 0) return false;
		this.#setSearchQuery(this.#searchQuery + printable);
		return true;
	}

	#renderSearchStatus(width: number): string {
		const label = theme.fg("accent", "Search:");
		const query = this.#searchQuery.length > 0 ? this.#searchQuery : theme.fg("dim", "type to filter");
		return truncateToWidth(`  ${label} ${query}`, width);
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouse(event));
			return;
		}

		if (matchesSelectCancel(data)) {
			if (this.#rename) {
				this.#rename = null;
				return;
			}
			if (this.#pendingLogoutCredentialId !== null) {
				this.#pendingLogoutCredentialId = null;
				return;
			}
			if (this.#searching) {
				this.#setSearching(false);
				return;
			}
			this.#callbacks.onCancel();
			return;
		}

		if (this.#rename) {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				this.#submitRename();
				return;
			}
			this.#rename.input.handleInput(data);
			return;
		}

		if (data !== "x") this.#pendingLogoutCredentialId = null;
		if (matchesKey(data, "ctrl+s")) {
			this.#setSearching(!this.#searching);
			return;
		}
		if (this.#handleSearchInput(data)) return;

		if (matchesSelectUp(data)) {
			this.#step(-1);
			return;
		}
		if (matchesSelectDown(data)) {
			this.#step(1);
			return;
		}
		if (matchesKey(data, "left")) {
			this.#focus = "sidebar";
			return;
		}
		if (matchesKey(data, "right")) {
			this.#focus = "body";
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activate();
			return;
		}

		switch (data) {
			case "n":
				this.#openRename();
				return;
			case "r": {
				if (this.#activeProviderId) this.#callbacks.onRefresh(this.#activeProviderId, this.#selectedRow());
				return;
			}
			case "u": {
				const row = this.#selectedRow();
				if (row) this.#callbacks.onShowUsage(row);
				return;
			}
			case "x":
				this.#pressLogout();
				return;
			case "a":
				if (this.#activeProviderId) this.#callbacks.onAddAccount(this.#activeProviderId);
				return;
			case "c": {
				const blocked = this.#selectedRow();
				if (blocked && this.#rowIsBlocked(blocked)) this.#callbacks.onClearRateLimitBlock(blocked);
				return;
			}
		}
	}

	#rowIsBlocked(row: AccountRow): boolean {
		return row.blockedUntilMs !== undefined && row.blockedUntilMs > Date.now();
	}

	#selectedRowIsBlocked(): boolean {
		const row = this.#selectedRow();
		return row !== undefined && this.#rowIsBlocked(row);
	}

	#step(direction: 1 | -1): void {
		this.#pendingLogoutCredentialId = null;
		if (this.#focus === "sidebar") {
			const filtered = this.#filteredEntries;
			if (filtered.length === 0) return;
			const current = Math.max(
				0,
				filtered.findIndex(entry => entry.providerId === this.#activeProviderId),
			);
			const next = (current + direction + filtered.length) % filtered.length;
			this.#selectProvider(filtered[next]?.providerId ?? this.#activeProviderId);
			return;
		}
		const rows = this.#rows();
		const count = rows.length + 1;
		const current =
			this.#bodySelection.kind === "add"
				? rows.length
				: Math.max(
						0,
						rows.findIndex(row => row.credentialId === this.#selectedCredentialId()),
					);
		const next = (current + direction + count) % count;
		const row = rows[next];
		this.#bodySelection = row ? { kind: "account", credentialId: row.credentialId } : { kind: "add" };
	}

	#activate(): void {
		if (this.#bodySelection.kind === "add") {
			if (this.#activeProviderId) this.#callbacks.onAddAccount(this.#activeProviderId);
			return;
		}
		const row = this.#selectedRow();
		if (row) this.#callbacks.onUseAccount(row);
	}

	#selectProvider(providerId: string): void {
		if (providerId === this.#activeProviderId) return;
		this.#activeProviderId = providerId;
		this.#rename = null;
		this.#pendingLogoutCredentialId = null;
		this.#bodyScroll = 0;
		this.#sidebarFollowActive = true;
		this.#selectFirstEntry();
	}

	#openRename(): void {
		const row = this.#selectedRow();
		if (!row) return;
		const input = new Input();
		input.setValue(row.name ?? "");
		this.#rename = { credentialId: row.credentialId, input };
		this.#pendingLogoutCredentialId = null;
	}

	#submitRename(): void {
		const rename = this.#rename;
		if (!rename) return;
		const row = this.#rows().find(candidate => candidate.credentialId === rename.credentialId);
		this.#rename = null;
		if (row) this.#callbacks.onRename(row, rename.input.getValue().trim());
	}

	#pressLogout(): void {
		const row = this.#selectedRow();
		if (!row) return;
		if (this.#pendingLogoutCredentialId === row.credentialId) {
			this.#pendingLogoutCredentialId = null;
			this.#callbacks.onLogout(row);
			return;
		}
		this.#pendingLogoutCredentialId = row.credentialId;
	}

	#routeMouse(event: SgrMouseEvent): boolean {
		const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
			motion: event.motion,
			leftClick: event.leftClick,
		});
		if (
			consumeModalChipHover(chrome, this.#hoveredShortcutId, id => {
				this.#hoveredShortcutId = id;
				this.#requestRender?.();
			})
		) {
			return true;
		}
		if (
			chrome.kind === "close" ||
			chrome.kind === "outside" ||
			(chrome.kind === "shortcut" && chrome.id === "close")
		) {
			this.handleInput("\x1b");
			this.#requestRender?.();
			return true;
		}
		if (chrome.kind === "shortcut") {
			const key = SHORTCUT_KEYS[chrome.id];
			if (key) {
				this.handleInput(key);
				this.#requestRender?.();
			}
			return true;
		}

		const innerCol = event.col - this.#frameLeft - 2;
		const contentLine = event.row - this.#contentRowStart;
		const overSplit = contentLine >= 0 && contentLine < this.#splitRowCount;
		const searchOffset = this.#searching ? 1 : 0;
		const overSidebar =
			overSplit &&
			contentLine >= searchOffset &&
			contentLine < searchOffset + this.#sidebarListRows() &&
			innerCol >= 0 &&
			innerCol < this.#sidebarWidthLast;
		const overBody = overSplit && innerCol >= this.#sidebarWidthLast + 3;

		if (event.motion) {
			this.#sidebarHover = overSidebar ? this.#sidebarScroll + contentLine - searchOffset : null;
			this.#sidebarFade?.set(this.#sidebarHover);
			return true;
		}
		if (event.wheel !== null) {
			const overSidebarForWheel =
				overSplit &&
				contentLine < searchOffset + this.#sidebarListRows() &&
				innerCol >= 0 &&
				innerCol < this.#sidebarWidthLast;
			if (overSidebarForWheel) {
				const filtered = this.#filteredEntries;
				this.#sidebarScroll = clampLow(
					this.#sidebarScroll + event.wheel,
					0,
					Math.max(0, filtered.length - this.#sidebarListRows()),
				);
			} else if (overBody) {
				this.#bodyScroll = clampLow(
					this.#bodyScroll + event.wheel,
					0,
					Math.max(0, this.#bodyLines.length - this.#splitRowCount),
				);
			}
			return true;
		}
		if (!event.leftClick) return true;

		if (searchOffset === 1 && overSplit && contentLine === 0 && innerCol >= 0 && innerCol < this.#sidebarWidthLast) {
			this.#focus = "sidebar";
			this.#requestRender?.();
			return true;
		}
		if (overSidebar) {
			const filtered = this.#filteredEntries;
			const providerLine = contentLine - searchOffset;
			const entry = filtered[this.#sidebarScroll + providerLine];
			if (entry) {
				this.#focus = "sidebar";
				this.#selectProvider(entry.providerId);
				this.#requestRender?.();
			}
			return true;
		}
		if (overBody) {
			const target = this.#bodyLines[this.#bodyScroll + contentLine]?.target;
			if (target) {
				this.#focus = "body";
				this.#bodySelection = target;
				this.#pendingLogoutCredentialId = null;
				if (target.kind === "add") this.#activate();
				this.#requestRender?.();
			}
		}
		return true;
	}

	#sidebarWidth(): number {
		let longest = SIDEBAR_MIN_WIDTH;
		for (let ei = 0; ei < this.#entries.length; ei++) {
			const entry = this.#entries[ei]!;
			longest = Math.max(longest, visibleWidth(entry.label) + visibleWidth(entry.annotation) + 7);
		}
		return clampLow(longest, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
	}

	#glyph(kind: AccountGlyphKind): string {
		switch (kind) {
			case "serving":
				return theme.fg("success", theme.status.active);
			case "idle":
				return theme.fg("muted", theme.status.connecting);
			case "failed":
				return theme.fg("error", theme.status.error);
			case "blocked":
				return theme.fg("warning", theme.status.disabled);
		}
	}

	#sidebarListRows(): number {
		return Math.max(1, this.#splitRowCount - SIDEBAR_SUMMARY_ROWS - (this.#searching ? 1 : 0));
	}

	#renderSidebar(width: number): string[] {
		const listRows = this.#sidebarListRows();
		const filtered = this.#filteredEntries;
		if (this.#sidebarFollowActive) {
			const activeIndex = Math.max(
				0,
				filtered.findIndex(entry => entry.providerId === this.#activeProviderId),
			);
			if (activeIndex < this.#sidebarScroll) this.#sidebarScroll = activeIndex;
			else if (activeIndex >= this.#sidebarScroll + listRows) this.#sidebarScroll = activeIndex - listRows + 1;
			this.#sidebarFollowActive = false;
		}
		this.#sidebarScroll = clampLow(this.#sidebarScroll, 0, Math.max(0, filtered.length - listRows));

		const lines: string[] = [];
		if (this.#searching) {
			lines.push(this.#renderSearchStatus(width));
		}
		if (filtered.length === 0) {
			if (this.#searching) lines.push(theme.fg("muted", truncateToWidth("  No matching providers", width)));
			while (lines.length < (this.#searching ? 1 : 0) + listRows) lines.push("");
		} else {
			for (let i = this.#sidebarScroll; i < Math.min(filtered.length, this.#sidebarScroll + listRows); i++) {
				const entry = filtered[i];
				if (!entry) continue;
				const active = entry.providerId === this.#activeProviderId;
				const cursor = active && this.#focus === "sidebar" ? theme.fg("accent", theme.nav.cursor) : " ";
				const label = active
					? theme.bold(theme.fg("accent", entry.label))
					: entry.accountCount === 0
						? theme.fg("dim", entry.label)
						: entry.label;
				const annotation = entry.hasFailure
					? `${theme.fg("dim", entry.annotation)} ${theme.fg("warning", theme.status.warning)}`
					: `${theme.fg("dim", entry.annotation)}  `;
				const left = `${cursor} ${label}`;
				const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(annotation));
				let line = `${left}${padding(gap)}${annotation}`;
				const hoverStrength = this.#sidebarStrength(i);
				if (hoverStrength > 0) line = hoverBandAt(line, width, hoverStrength);
				lines.push(line);
			}
			while (lines.length < (this.#searching ? 1 : 0) + listRows) lines.push("");
		}
		while (lines.length < (this.#searching ? 1 : 0) + listRows + 1) lines.push("");
		lines.push(theme.fg("borderAccent", "─".repeat(Math.max(1, width - 2))));
		lines.push(theme.fg("dim", truncateToWidth(sidebarSummaryLine(this.#inventory), width)));
		return lines;
	}

	#wrapNote(text: string, indent: string, width: number): string[] {
		const inner = Math.max(8, width - indent.length);
		const wrappedRaw = wrapTextWithAnsi(text, inner);
		const wrapped = new Array<string>(wrappedRaw.length);
		for (let wi = 0; wi < wrappedRaw.length; wi++) wrapped[wi] = `${indent}${wrappedRaw[wi]!}`;
		if (wrapped.length <= NOTE_MAX_LINES) return wrapped;
		const kept = wrapped.slice(0, NOTE_MAX_LINES);
		const last = truncateToWidth(kept[NOTE_MAX_LINES - 1] ?? "", Math.max(1, width - 1));
		kept[NOTE_MAX_LINES - 1] = last.endsWith("…") ? last : `${last}…`;
		return kept;
	}

	#buildBodyLines(width: number, nowMs: number): BodyLine[] {
		const entry = this.#activeEntry();
		if (!entry) return [{ text: theme.fg("muted", "No providers available") }];
		const rows = this.#rows();
		const headerWrapped = this.#wrapNote(providerHeaderLine(entry.label, rows), "", width);
		const lines: BodyLine[] = new Array<BodyLine>(headerWrapped.length);
		for (let hi = 0; hi < headerWrapped.length; hi++) lines[hi] = { text: theme.bold(headerWrapped[hi]!) };
		const scopeWrapped = this.#wrapNote(
			`accounts shared by every profile and session on this machine · quota load balancing ${
				this.#loadBalancing ? "on" : "off"
			} for this profile`,
			"",
			width,
		);
		for (let wi = 0; wi < scopeWrapped.length; wi++) {
			lines.push({ text: theme.fg("dim", scopeWrapped[wi]!) });
		}
		lines.push({ text: "" });

		const group = this.#inventory.providers.find(candidate => candidate.provider === this.#activeProviderId);
		if (group) {
			const providerNotes = providerDisabledNote(group);
			for (let ni = 0; ni < providerNotes.length; ni++) {
				const noteWrapped = this.#wrapNote(providerNotes[ni]!, "  ", width);
				for (let wi = 0; wi < noteWrapped.length; wi++) {
					lines.push({ text: theme.fg("warning", noteWrapped[wi]!) });
				}
			}
			if (group.disabledCause) lines.push({ text: "" });
		}

		const divergence = selectedButRotated(this.#inventory, this.#activeProviderId);
		if (divergence) {
			const divLines = divergenceLines(divergence, nowMs);
			for (let di = 0; di < divLines.length; di++) {
				const divWrapped = this.#wrapNote(divLines[di]!, "  ", width);
				for (let wi = 0; wi < divWrapped.length; wi++) {
					lines.push({ text: theme.fg("warning", divWrapped[wi]!) });
				}
			}
			lines.push({ text: "" });
		}

		for (let ri = 0; ri < rows.length; ri++) {
			const row = rows[ri]!;
			const target: BodyTarget = { kind: "account", credentialId: row.credentialId };
			const selected = this.#isSelected(target);
			const head = accountHeadLine(row, nowMs);
			const cursor = selected && this.#focus === "body" ? theme.fg("accent", theme.nav.cursor) : " ";
			const glyph = this.#glyph(accountGlyphKind(row, nowMs));
			const label = selected ? theme.bold(theme.fg("accent", head.label)) : head.label;
			const detail = head.detail ? `  ${theme.fg("muted", head.detail)}` : "";
			const tag = head.tag ? theme.fg(row.activeForSession ? "success" : "warning", head.tag) : "";
			const left = ` ${cursor} ${glyph} ${label}${detail}`;
			const tagFits = tag.length > 0 && visibleWidth(left) + 1 + visibleWidth(tag) <= width;
			const gap = tagFits ? width - visibleWidth(left) - visibleWidth(tag) : 0;
			let text = tagFits ? `${left}${padding(gap)}${tag}` : truncateToWidth(left, width);
			if (selected) text = selectionBand(text, width);
			lines.push({ text, target });

			if (this.#rename?.credentialId === row.credentialId) {
				const prompt = theme.fg("accent", "name:");
				const field = this.#rename.input.render(Math.max(8, Math.min(32, width - 14)))[0] ?? "";
				lines.push({ text: truncateToWidth(`       ${prompt} ${field}`, width), target });
			}

			const plan = accountPlanLine(row);
			if (plan) lines.push({ text: theme.fg("muted", truncateToWidth(`       ${plan}`, width)), target });
			const usageLines = accountUsageLines(row, nowMs);
			for (let ui = 0; ui < usageLines.length; ui++) {
				lines.push({ text: truncateToWidth(`       ${usageLines[ui]!}`, width), target });
			}
			const noticeLines = accountNoticeLines(row, nowMs);
			for (let ni = 0; ni < noticeLines.length; ni++) {
				const notice = noticeLines[ni]!;
				const wrappedNotice = this.#wrapNote(notice, "       ", width);
				for (let wi = 0; wi < wrappedNotice.length; wi++) {
					lines.push({ text: theme.fg("error", wrappedNotice[wi]!), target });
				}
			}
			if (this.#pendingLogoutCredentialId === row.credentialId) {
				const logoutWrapped = this.#wrapNote(
					`press x again to log out of ${head.label} · esc cancels`,
					"       ",
					width,
				);
				for (let wi = 0; wi < logoutWrapped.length; wi++) {
					lines.push({ text: theme.fg("warning", logoutWrapped[wi]!), target });
				}
			}
			lines.push({ text: "" });
		}

		if (rows.length === 0) {
			const emptyWrapped = this.#wrapNote("No accounts stored for this provider yet.", "  ", width);
			for (let wi = 0; wi < emptyWrapped.length; wi++) {
				lines.push({ text: theme.fg("muted", emptyWrapped[wi]!) });
			}
			lines.push({ text: "" });
		}

		const addTarget: BodyTarget = { kind: "add" };
		const addSelected = this.#isSelected(addTarget);
		const addCursor = addSelected && this.#focus === "body" ? theme.fg("accent", theme.nav.cursor) : " ";
		const addLabel = `+ add another ${sanitizeAccountText(entry.label)} account`;
		let addText = truncateToWidth(
			` ${addCursor} ${addSelected ? theme.bold(theme.fg("accent", addLabel)) : theme.fg("accent", addLabel)}`,
			width,
		);
		if (addSelected) addText = selectionBand(addText, width);
		lines.push({ text: addText, target: addTarget });
		return lines;
	}

	#shortcuts(): ModalShortcut[] {
		if (this.#rename) {
			return [
				{ label: "enter save name", clickable: true, id: "confirm" },
				{ label: "esc cancel", clickable: true, id: "close" },
			];
		}
		if (this.#searching) {
			return [
				{ label: "↑↓ move" },
				{ label: "enter switch to this account", clickable: true, id: "confirm" },
				{ label: "esc exit search", clickable: true, id: "close" },
			];
		}
		const entry = this.#activeEntry();
		const use =
			this.#bodySelection.kind === "add"
				? entry
					? `enter add ${entry.label} account`
					: "enter add account"
				: entry
					? `enter switch ${entry.label} to this account`
					: "enter switch to this account";
		const onAddEntry = this.#bodySelection.kind === "add";
		return [
			{ label: "↑↓ move" },
			{ label: "←→ pane" },
			{ label: use, clickable: true, id: "confirm" },
			...(onAddEntry ? [] : [{ label: "n name", clickable: true, id: "name" }]),
			{
				label: onAddEntry ? "r refresh accounts" : "r refresh this account",
				clickable: true,
				id: "refresh",
			},
			...(onAddEntry
				? []
				: [
						{ label: "u usage", clickable: true, id: "usage" },
						{
							label: this.#pendingLogoutCredentialId === null ? "x logout" : "x confirm logout",
							clickable: true,
							id: "logout",
						},
					]),
			...(this.#selectedRowIsBlocked() ? [{ label: "c clear limit", clickable: true, id: "clearBlock" }] : []),
			{ label: "a add", clickable: true, id: "add" },
			{ label: "ctrl+s search", clickable: true, id: "search" },
			{ label: "esc close", clickable: true, id: "close" },
		];
	}

	render(width: number): readonly string[] {
		const height = this.#terminalHeight ?? (process.stdout.rows || 40);
		const sizing = sizingForArea(MODAL_SIZING_LARGE, height);
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return new Array(height).fill(padding(width));
		}
		const contentWidth = dims.contentWidth;
		const sidebarWidth = this.#sidebarWidth();
		this.#sidebarWidthLast = sidebarWidth;
		const paneSep = theme.fg("dim", ` ${theme.boxSharp.vertical} `);
		const bodyWidth = Math.max(1, contentWidth - sidebarWidth - 3);

		const shortcuts = this.#shortcuts();
		const chrome = planModalChrome({
			sizing,
			modalHeight: dims.modalHeight,
			contentWidth,
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
		});
		const splitRows = Math.max(1, chrome.maxBodyRows);
		this.#splitRowCount = splitRows;
		const nowMs = Date.now();

		this.#bodyLines = this.#buildBodyLines(bodyWidth, nowMs);
		if (this.#bodyLines.length > splitRows) {
			this.#bodyLines = this.#buildBodyLines(Math.max(1, bodyWidth - 2), nowMs);
		}
		const selectedLine = this.#bodyLines.findIndex(line => this.#isSelected(line.target));
		if (selectedLine >= 0) {
			if (selectedLine < this.#bodyScroll) this.#bodyScroll = selectedLine;
			else if (selectedLine >= this.#bodyScroll + splitRows) this.#bodyScroll = selectedLine - splitRows + 1;
		}
		this.#bodyScroll = clampLow(this.#bodyScroll, 0, Math.max(0, this.#bodyLines.length - splitRows));
		const window = this.#bodyLines.slice(this.#bodyScroll, this.#bodyScroll + splitRows);
		const paneLines = renderScrollableList(
			{
				width: bodyWidth,
				visibleRows: splitRows,
				totalRows: this.#bodyLines.length,
				scrollOffset: this.#bodyScroll,
			},
			rowWidth => {
				const out = new Array<string>(window.length);
				for (let li = 0; li < window.length; li++) out[li] = truncateToWidth(window[li]!.text, rowWidth);
				return out;
			},
		);

		const sidebarLines = this.#renderSidebar(sidebarWidth);
		const body: string[] = [];
		for (let i = 0; i < splitRows; i++) {
			body.push(fit(sidebarLines[i] ?? "", sidebarWidth) + paneSep + fit(paneLines[i] ?? "", bodyWidth));
		}

		const shell = renderModalShell({
			title: "Accounts",
			sizing,
			areaWidth: width,
			areaHeight: height,
			body,
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		this.#frameLeft = shell.geometry?.leftPad ?? 0;
		this.#contentRowStart = shell.geometry?.bodyRowStart ?? 0;
		return shell.lines;
	}
}
