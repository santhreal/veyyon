import {
	type Component,
	clampLow,
	matchesKey,
	padding,
	routeSgrMouseInput,
	ScrollView,
	type SgrMouseEvent,
} from "@veyyon/tui";
import type { LogoutAccount } from "../../slash-commands/helpers/logout";
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

const LOGOUT_SELECTOR_MAX_VISIBLE = 10;

const LOGOUT_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down navigate" },
	{ label: "enter logout", clickable: true, id: "confirm" },
	{ label: "esc close", clickable: true, id: "close" },
];

/** Account picker for `/logout` after the provider has been selected — floating ModalShell card. */
export class LogoutAccountSelectorComponent implements Component {
	#providerName: string;
	#accounts: LogoutAccount[];
	#selectedIndex = 0;
	#statusMessage: string | undefined;
	#onSelectCallback: (account: LogoutAccount) => void;
	#onCancelCallback: () => void;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#onRequestRender?: () => void;

	constructor(
		providerName: string,
		accounts: LogoutAccount[],
		onSelect: (account: LogoutAccount) => void,
		onCancel: () => void,
	) {
		this.#providerName = providerName;
		this.#accounts = accounts;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		const activeIndex = accounts.findIndex(account => account.active);
		this.#selectedIndex = activeIndex >= 0 ? activeIndex : 0;
	}

	setOnRequestRender(cb: () => void): void {
		this.#onRequestRender = cb;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	#buildBody(width: number): string[] {
		const total = this.#accounts.length;
		const maxVisible = LOGOUT_SELECTOR_MAX_VISIBLE;
		const startIndex =
			total <= maxVisible ? 0 : clampLow(this.#selectedIndex - Math.floor(maxVisible / 2), 0, total - maxVisible);
		const endIndex = Math.min(startIndex + maxVisible, total);

		const rows: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const account = this.#accounts[i];
			if (!account) continue;
			const activeTag = account.active ? theme.fg("muted", " (active)") : "";
			const detail = account.detail ? theme.fg("dim", `  ${account.detail}`) : "";
			if (i === this.#selectedIndex) {
				rows.push(`${theme.fg("accent", `${theme.nav.cursor} ${account.label}`)}${activeTag}${detail}`);
			} else {
				rows.push(`  ${account.label}${activeTag}${detail}`);
			}
		}

		const body: string[] = [];
		if (rows.length > 0) {
			const sv = new ScrollView(rows, {
				height: rows.length,
				scrollbar: "auto",
				totalRows: total,
				theme: { track: text => theme.fg("muted", text), thumb: text => theme.fg("accent", text) },
			});
			sv.setScrollOffset(startIndex);
			body.push(...sv.render(width));
		}

		if (total === 0) {
			body.push(theme.fg("muted", "No stored accounts to log out"));
		}

		if (this.#statusMessage) {
			body.push("", theme.fg("warning", this.#statusMessage));
		}

		return body;
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<")) {
			routeSgrMouseInput(keyData, event => this.#routeMouse(event));
			return;
		}

		if (matchesSelectCancel(keyData)) {
			this.#onCancelCallback();
			return;
		}

		if (matchesSelectUp(keyData)) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = this.#selectedIndex === 0 ? this.#accounts.length - 1 : this.#selectedIndex - 1;
			}
			this.#statusMessage = undefined;
		} else if (matchesSelectDown(keyData)) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = this.#selectedIndex === this.#accounts.length - 1 ? 0 : this.#selectedIndex + 1;
			}
			this.#statusMessage = undefined;
		} else if (matchesKey(keyData, "pageUp")) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = Math.max(0, this.#selectedIndex - LOGOUT_SELECTOR_MAX_VISIBLE);
			}
			this.#statusMessage = undefined;
		} else if (matchesKey(keyData, "pageDown")) {
			if (this.#accounts.length > 0) {
				this.#selectedIndex = Math.min(
					this.#accounts.length - 1,
					this.#selectedIndex + LOGOUT_SELECTOR_MAX_VISIBLE,
				);
			}
			this.#statusMessage = undefined;
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const account = this.#accounts[this.#selectedIndex];
			if (!account) return;
			this.#onSelectCallback(account);
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
			title: `Logout · ${this.#providerName}`,
			sizing,
			areaWidth: width,
			areaHeight: height,
			body: this.#buildBody(dims.contentWidth),
			shortcuts: LOGOUT_SHORTCUTS,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		return shell.lines;
	}
}
