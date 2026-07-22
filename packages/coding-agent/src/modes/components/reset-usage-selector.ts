import { type Component, matchesKey, padding, routeSgrMouseInput, ScrollView, type SgrMouseEvent } from "@veyyon/tui";
import { clampLow, formatCount } from "@veyyon/utils";
import type { ResetUsageAccount } from "../../slash-commands/helpers/reset-usage";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import {
	computeModalDims,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	type ModalShortcut,
	renderModalShell,
	withCompact,
} from "./modal-shell";

const RESET_SELECTOR_MAX_VISIBLE = 10;

const RESET_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down navigate" },
	{ label: "enter spend", clickable: true, id: "confirm" },
	{ label: "esc close", clickable: true, id: "close" },
];

const RESET_PENDING_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "enter confirm", clickable: true, id: "confirm" },
	{ label: "esc cancel pending", clickable: true, id: "close" },
];

/**
 * Account picker for `/usage reset` — floating ModalShell card. Lists Codex
 * accounts with their saved rate-limit reset counts; selecting one redeems a
 * reset. Because a reset is a scarce, irreversible credit, Enter requires a
 * second press to confirm.
 */
export class ResetUsageSelectorComponent implements Component {
	#accounts: ResetUsageAccount[];
	#selectedIndex = 0;
	#pendingIndex: number | null = null;
	#statusMessage: string | undefined;
	#onSelectCallback: (account: ResetUsageAccount) => void;
	#onCancelCallback: () => void;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#onRequestRender?: () => void;

	constructor(accounts: ResetUsageAccount[], onSelect: (account: ResetUsageAccount) => void, onCancel: () => void) {
		this.#accounts = accounts;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		const firstRedeemable = accounts.findIndex(account => account.availableCount > 0);
		this.#selectedIndex = firstRedeemable >= 0 ? firstRedeemable : 0;
	}

	setOnRequestRender(cb: () => void): void {
		this.#onRequestRender = cb;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	#pendingAccount(): ResetUsageAccount | undefined {
		return this.#pendingIndex !== null ? this.#accounts[this.#pendingIndex] : undefined;
	}

	#buildBody(width: number): string[] {
		const total = this.#accounts.length;
		const maxVisible = RESET_SELECTOR_MAX_VISIBLE;
		const startIndex =
			total <= maxVisible
				? 0
				: clampLow(this.#selectedIndex - Math.floor(maxVisible / 2), 0, total - maxVisible);
		const endIndex = Math.min(startIndex + maxVisible, total);

		const rows: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const account = this.#accounts[i];
			if (!account) continue;
			const isSelected = i === this.#selectedIndex;
			const redeemable = account.availableCount > 0;
			const countLabel = account.error ? account.error : formatCount("saved reset", account.availableCount);
			const countText = account.error
				? theme.fg("error", countLabel)
				: redeemable
					? theme.fg("success", countLabel)
					: theme.fg("dim", countLabel);
			const activeTag = account.active ? theme.fg("muted", " (active)") : "";
			if (isSelected) {
				const name = redeemable ? theme.fg("accent", account.label) : theme.fg("dim", account.label);
				rows.push(`${theme.fg("accent", `${theme.nav.cursor} `)}${name}${activeTag}  ${countText}`);
			} else {
				const name = redeemable ? `  ${account.label}` : theme.fg("dim", `  ${account.label}`);
				rows.push(`${name}${activeTag}  ${countText}`);
			}
		}

		const body: string[] = [];
		if (rows.length > 0) {
			const sv = new ScrollView(rows, {
				height: rows.length,
				scrollbar: "auto",
				totalRows: total,
				theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
			});
			sv.setScrollOffset(startIndex);
			body.push(...sv.render(width));
		}

		if (total === 0) {
			body.push(theme.fg("muted", "No Codex accounts with saved resets"));
		}

		if (this.#statusMessage) {
			body.push("", theme.fg("warning", this.#statusMessage));
		}

		return body;
	}

	#tipCandidates(): readonly string[] | undefined {
		const pending = this.#pendingAccount();
		if (!pending) return undefined;
		return [
			theme.fg("warning", `Press Enter again to spend 1 reset for ${pending.label}, Esc to cancel`),
			theme.fg("warning", "Press Enter again to confirm"),
		];
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<")) {
			routeSgrMouseInput(keyData, event => this.#routeMouse(event));
			return;
		}

		if (matchesSelectCancel(keyData)) {
			if (this.#pendingIndex !== null) {
				this.#pendingIndex = null;
				this.#statusMessage = undefined;
				return;
			}
			this.#onCancelCallback();
			return;
		}

		if (matchesSelectUp(keyData)) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = this.#selectedIndex === 0 ? this.#accounts.length - 1 : this.#selectedIndex - 1;
			}
			this.#pendingIndex = null;
			this.#statusMessage = undefined;
		} else if (matchesSelectDown(keyData)) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = this.#selectedIndex === this.#accounts.length - 1 ? 0 : this.#selectedIndex + 1;
			}
			this.#pendingIndex = null;
			this.#statusMessage = undefined;
		} else if (matchesKey(keyData, "pageUp")) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = Math.max(0, this.#selectedIndex - RESET_SELECTOR_MAX_VISIBLE);
			}
			this.#pendingIndex = null;
		} else if (matchesKey(keyData, "pageDown")) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = Math.min(this.#accounts.length - 1, this.#selectedIndex + RESET_SELECTOR_MAX_VISIBLE);
			}
			this.#pendingIndex = null;
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const account = this.#accounts[this.#selectedIndex];
			if (!account) return;
			if (account.availableCount <= 0) {
				this.#statusMessage = "That account has no saved resets to spend.";
				return;
			}
			if (this.#pendingIndex === this.#selectedIndex) {
				this.#onSelectCallback(account);
				return;
			}
			this.#pendingIndex = this.#selectedIndex;
			this.#statusMessage = undefined;
		}
	}

	#routeMouse(event: SgrMouseEvent): boolean {
		const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
			motion: event.motion,
			leftClick: event.leftClick,
		});
		if (chrome.kind === "hover-shortcut") {
			if (this.#hoveredShortcutId !== chrome.id) {
				this.#hoveredShortcutId = chrome.id;
				this.#onRequestRender?.();
			}
			return true;
		}
		if (
			chrome.kind === "close" ||
			chrome.kind === "outside" ||
			(chrome.kind === "shortcut" && chrome.id === "close")
		) {
			if (this.#pendingIndex !== null) {
				this.#pendingIndex = null;
				this.#statusMessage = undefined;
				this.#onRequestRender?.();
				return true;
			}
			this.#onCancelCallback();
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "confirm") {
			this.handleInput("\n");
			return true;
		}
		return true;
	}

	render(width: number): readonly string[] {
		const height = process.stdout.rows || 40;
		const sizing = withCompact(MODAL_SIZING_MEDIUM, height < 24);
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: height }, () => padding(width));
		}

		const shell = renderModalShell({
			title: "Spend reset",
			sizing,
			areaWidth: width,
			areaHeight: height,
			body: this.#buildBody(dims.contentWidth),
			tipCandidates: this.#tipCandidates(),
			shortcuts: this.#pendingIndex !== null ? RESET_PENDING_SHORTCUTS : RESET_SHORTCUTS,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		return shell.lines;
	}
}
