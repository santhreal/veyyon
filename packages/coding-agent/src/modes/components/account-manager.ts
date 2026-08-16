/**
 * The `/providers` account manager: a fullscreen ModalShell LARGE card whose sidebar lists every
 * provider and whose body lists that provider's ACCOUNTS.
 *
 * WHY A NEW CARD. `/providers` used to open the onboarding wizard's provider scene, which shows
 * one row per provider and a bare `logged in` tag. The store has always held several credentials
 * per provider, so that scene could not say which of your three Anthropic accounts the session
 * is actually routed to, whether one of them is failing, or how much of each account's quota is
 * gone. This card is one row per CREDENTIAL, which is the thing you switch, name and log out.
 *
 * WHY SWITCHING IS PER PROVIDER. Several providers serve one session at once (main model,
 * subagent roles, web search), so there is no single "current account" to pick. `enter` uses the
 * selected account FOR ITS PROVIDER and the footer says so by name, because a key labelled just
 * `use` reads as a global switch and is not one. Moving from Anthropic to Google is a model
 * decision and lives in `/models`.
 *
 * WHAT IT OWNS AND WHAT IT DOES NOT. Geometry, focus, the rename input, the logout confirm and
 * mouse routing live here. The wording of every line lives in `account-manager-rows.ts`, and the
 * account model itself in `session/account-inventory.ts`. This card never reads `AuthStorage`
 * and never prints a token byte: it is given an inventory of identities and status, and that is
 * all it can show.
 */
import { getOAuthProviders } from "@veyyon/ai/oauth";
import {
	type Component,
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
	applyModalReveal,
	beginModalExit,
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	ModalRevealDriver,
	type ModalShellGeometry,
	type ModalShortcut,
	modalRevealEnabled,
	planModalChrome,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";
import { fit } from "./overlay-box";
import { hoverBandAt, renderScrollableList, selectionBand } from "./selector-helpers";

/** Body lines one wrapped warning may occupy before it is clipped. */
const NOTE_MAX_LINES = 3;
const SIDEBAR_MIN_WIDTH = 20;
const SIDEBAR_MAX_WIDTH = 30;
/**
 * Rows the sidebar spends below its provider list: a blank gap, a rule, and the account tally.
 *
 * The provider list is therefore SHORTER than the split, and everything that maps a screen row
 * to a provider has to agree about by how much — see {@link AccountManagerComponent.sidebarListRows}.
 */
const SIDEBAR_SUMMARY_ROWS = 3;

/**
 * The keystroke each clickable footer chip stands for.
 *
 * Clicking a chip replays that key through {@link AccountManagerComponent.handleInput}, so the
 * mouse path has no logic of its own: `x` still arms before it logs out, `enter` still submits an
 * open rename, and a chip can never do something the key beside it does not.
 */
const SHORTCUT_KEYS: Record<string, string> = {
	confirm: "\r",
	name: "n",
	refresh: "r",
	usage: "u",
	logout: "x",
	add: "a",
	balance: "b",
};

export interface AccountManagerCallbacks {
	/** Make this credential the account the provider uses, for every session and profile. */
	onUseAccount: (row: AccountRow) => void;
	/** Persist a chosen name for this credential. An empty string clears it. */
	onRename: (row: AccountRow, name: string) => void;
	/**
	 * Re-probe one account, or the whole provider when no row is selected.
	 *
	 * Row-scoped because the probe costs a network round-trip PER CREDENTIAL, sequentially: on a
	 * nine-account provider, asking about the row under the cursor made the user wait behind eight
	 * accounts they did not ask about. `row` is absent only from the add entry, which has no
	 * credential to probe, and then the provider's accounts are all there is to refresh.
	 */
	onRefresh: (provider: string, row?: AccountRow) => void;
	/** Remove this credential from the store. Destructive; the card confirms first. */
	onLogout: (row: AccountRow) => void;
	/** Show the full usage report for one account. */
	onShowUsage: (row: AccountRow) => void;
	/** Start a login that adds another account for this provider. */
	onAddAccount: (provider: string) => void;
	/**
	 * Flip `accounts.loadBalancing` and return its new value.
	 *
	 * On the card because the setting decides what happens when the account on screen runs out of
	 * quota, and sending the user to `/settings` to answer that question loses the context they
	 * are looking at. Returns the value actually stored, so a write the settings layer refuses
	 * cannot leave the footer claiming a state the config does not have.
	 */
	onToggleLoadBalancing: () => boolean;
	onCancel: () => void;
}

export interface AccountManagerOptions {
	/** Focus this provider's sidebar entry on open (`/account switch <provider>`). */
	initialProviderId?: string;
	/**
	 * Play the open unfold. Opt-in at the real show site only: the reveal is wall-clock-driven,
	 * so a default-on would make every direct construction (tests, embedders) render mid-frame.
	 */
	reveal?: boolean;
	/** Repaint hook, for the reveal driver and for mouse-only state changes. */
	requestRender?: () => void;
	/**
	 * Rows to size the card against, instead of reading the terminal.
	 *
	 * A piped render has no `process.stdout.rows`, so it falls back to a height nobody is looking
	 * at, and the compact card that a short terminal produces is two columns WIDER than the
	 * ordinary one. That is how a body line that overflows on a real terminal renders as fitting
	 * in an image proof, which has happened here before.
	 * Naming the height is what makes a proof reproduce the operator's card.
	 */
	terminalHeight?: number;
	/**
	 * Current value of `accounts.loadBalancing`, for the footer chip and the scope line.
	 *
	 * Passed in rather than read here: this component owns no config, and a card that reached for
	 * the settings singleton could not be rendered by a proof script or a test without one.
	 */
	loadBalancing?: boolean;
}

/**
 * What a body line points at.
 *
 * `add` is the `+ add another …` entry. It is a real list position, not a hint: arrowing off the
 * last account lands on it, `enter` there starts a login, and a click on it does the same.
 */
type BodyTarget = { kind: "account"; credentialId: number } | { kind: "add" };

/** One rendered body line, and the entry it belongs to. */
interface BodyLine {
	text: string;
	/**
	 * Every line of an entry's block carries it, so a click anywhere in the block hits the entry.
	 * The cursor and the selection band are painted on the block's FIRST line only.
	 */
	target?: BodyTarget;
}

export class AccountManagerComponent implements Component {
	#inventory: AccountInventory;
	#callbacks: AccountManagerCallbacks;
	#requestRender?: () => void;
	#terminalHeight?: number;

	#entries: AccountSidebarEntry[] = [];
	#activeProviderId = "";
	#focus: "sidebar" | "body" = "body";
	/**
	 * Selection is keyed by CREDENTIAL id, never by index.
	 *
	 * The host calls {@link setInventory} whenever a health or usage probe lands, which can be
	 * seconds after the card opened and while the user is arrowing through rows. An index-keyed
	 * selection silently moves to a different account when a refresh reorders or drops a row —
	 * and the next `x` would then log out an account the user never selected.
	 *
	 * The add-account entry has no credential, so the selection is a tagged union rather than a
	 * nullable id: a provider you hold no accounts for still has one selectable entry.
	 */
	#bodySelection: BodyTarget = { kind: "add" };

	#sidebarScroll = 0;
	/** Set by an activation (keys, click, open) so the next paint reveals the active provider. */
	#sidebarFollowActive = true;
	#sidebarHover: number | null = null;
	/**
	 * The cross-fade for the sidebar band, once the host has lent the card a repaint. A card
	 * constructed without one keeps the switched band, which is what a non-interactive test sees.
	 */
	#sidebarFade: HoverFade | undefined;
	#bodyScroll = 0;

	/** Inline rename editor, open over the selected row. */
	#rename: { credentialId: number; input: Input } | null = null;
	/**
	 * Credential armed for logout by a first `x`. A logout is irreversible from this card, so it
	 * takes a second press on the SAME row (the `/usage reset` confirm ladder).
	 */
	#pendingLogoutCredentialId: number | null = null;

	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#frameLeft = 0;
	#contentRowStart = 0;
	#splitRowCount = 0;
	#sidebarWidthLast = SIDEBAR_MIN_WIDTH;
	#bodyLines: BodyLine[] = [];
	#reveal = new ModalRevealDriver();
	/**
	 * Fade out on the shared clock before the host drops this card. The overlay stack keeps painting
	 * it and stops routing input to it the moment this is called.
	 */
	beginOverlayExit(requestRender: () => void, done: () => void): boolean {
		return beginModalExit(this.#reveal, requestRender, done);
	}

	/** Mirrors `accounts.loadBalancing`; only `b` and the chip change it. */
	#loadBalancing = false;

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
		if (options.reveal) this.#reveal.start(() => this.#requestRender?.());
		// The band fades only once the card has a repaint to lend it: the frames between two mouse
		// reports have no input to hang off. Same ambient gate as the open unfold.
		const requestRender = options.requestRender;
		if (requestRender) {
			this.#sidebarFade = new HoverFade({ requestRender, enabled: modalRevealEnabled() });
		}
	}

	/**
	 * Replace the inventory in place, keeping the user where they were.
	 *
	 * Health and usage arrive over the network, so this runs mid-interaction. The active
	 * provider and the selected credential survive; only a credential that has genuinely
	 * disappeared from the store forces the selection to move.
	 */
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
		this.#reveal.stop();
		this.#sidebarFade?.dispose();
		this.#sidebarFade = undefined;
		this.#sidebarHover = null;
	}

	/** Sidebar band strength; without a fade the hovered row is at 1 and the rest at 0. */
	#sidebarStrength(index: number): number {
		if (this.#sidebarFade !== undefined) return this.#sidebarFade.strengthAt(index);
		return index === this.#sidebarHover ? 1 : 0;
	}

	#rebuildEntries(): void {
		this.#entries = buildSidebarEntries(
			this.#inventory,
			// `formatProviderName`, the SAME rule the inventory labels a populated provider with, not
			// the catalog's marketing name. One list cannot label the same provider two ways depending
			// on whether you happen to hold an account: `openai-codex` read as "OpenAI Codex" once it
			// had a credential and "ChatGPT Plus/Pro (Codex Sub…" while it did not. The catalog names
			// also carry parenthetical model lists that only ever render truncated in a 30-column
			// sidebar, so the short form is both consistent and more readable here.
			getOAuthProviders().map(provider => {
				const id = provider.storeCredentialsAs ?? provider.id;
				return { id, label: formatProviderName(id) };
			}),
		);
		if (!this.#entries.some(entry => entry.providerId === this.#activeProviderId)) {
			this.#activeProviderId = this.#entries[0]?.providerId ?? "";
			this.#sidebarFollowActive = true;
		}
	}

	#activeEntry(): AccountSidebarEntry | undefined {
		return this.#entries.find(entry => entry.providerId === this.#activeProviderId);
	}

	#rows(): readonly AccountRow[] {
		return accountsForProvider(this.#inventory, this.#activeProviderId);
	}

	/** The selected credential, or null when the add-account entry holds the cursor. */
	#selectedCredentialId(): number | null {
		return this.#bodySelection.kind === "account" ? this.#bodySelection.credentialId : null;
	}

	#selectedRow(): AccountRow | undefined {
		const id = this.#selectedCredentialId();
		return id === null ? undefined : this.#rows().find(row => row.credentialId === id);
	}

	/** Put the cursor on the first account, or on the add entry when the provider holds none. */
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

	// ═══════════════════════════════════════════════════════════════════════
	// Input
	// ═══════════════════════════════════════════════════════════════════════

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouse(event));
			return;
		}

		// The cancel ladder: Esc unwinds the innermost thing the user opened before it closes the
		// card. A rename that vanished together with the whole view on one Esc is how typed text
		// gets lost, and an armed logout that survived Esc would be a destructive action the user
		// believes they backed out of.
		if (matchesSelectCancel(data)) {
			if (this.#rename) {
				this.#rename = null;
				return;
			}
			if (this.#pendingLogoutCredentialId !== null) {
				this.#pendingLogoutCredentialId = null;
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

		// A second `x` is the confirm, and ANY other key is not. The arm used to survive a rename, a
		// balancing toggle, a refresh and a provider switch, so an `x` pressed after all of those
		// still deleted a credential the operator had stopped thinking about: a destructive
		// confirmation whose two halves are not adjacent is not a confirmation. Cleared at the one
		// point every non-`x` key passes rather than inside each branch, so a key added later cannot
		// forget to do it.
		if (data !== "x") this.#pendingLogoutCredentialId = null;

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
				// The selected row when there is one, so the probe pays for the account under the
				// cursor and nothing else. The add entry selects no row and refreshes the provider.
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
			case "b":
				// Mirrored locally from the callback's return so the footer reflects what was STORED.
				// Assuming the flip landed is how a chip ends up claiming a state the config refused.
				this.#loadBalancing = this.#callbacks.onToggleLoadBalancing();
				return;
		}
	}

	/** Arrows move within the focused pane; either way an armed logout disarms. */
	#step(direction: 1 | -1): void {
		this.#pendingLogoutCredentialId = null;
		if (this.#focus === "sidebar") {
			if (this.#entries.length === 0) return;
			const current = Math.max(
				0,
				this.#entries.findIndex(entry => entry.providerId === this.#activeProviderId),
			);
			const next = (current + direction + this.#entries.length) % this.#entries.length;
			this.#selectProvider(this.#entries[next]?.providerId ?? this.#activeProviderId);
			return;
		}
		const rows = this.#rows();
		// The add entry is the position AFTER the last account, so arrowing off the bottom of the
		// list lands on it instead of stopping. The list wraps, like `SelectList` and like the
		// sidebar above: down from the add entry returns to the first account.
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

	/**
	 * What `enter` and a body click both mean: use the selected account, or start a login when
	 * the cursor is on the add entry. One owner, so the mouse can never run a different action
	 * from the key the footer names.
	 */
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
		// An empty submit is not a no-op: it is how a user takes a name back off an account.
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
			// A chip runs the KEY it names, never a private copy of the action, so the footer and
			// the keyboard can never drift apart.
			const key = SHORTCUT_KEYS[chrome.id];
			if (key) {
				this.handleInput(key);
				this.#requestRender?.();
			}
			return true;
		}

		// `row()` insets content by the border column plus a space, and the card floats, so the
		// split starts at `frameLeft + 2`.
		const innerCol = event.col - this.#frameLeft - 2;
		const contentLine = event.row - this.#contentRowStart;
		const overSplit = contentLine >= 0 && contentLine < this.#splitRowCount;
		// The summary block owns the last rows of the sidebar column and answers to no provider,
		// so a click there must select nothing rather than index past the visible list.
		const overSidebar =
			overSplit && contentLine < this.#sidebarListRows() && innerCol >= 0 && innerCol < this.#sidebarWidthLast;
		const overBody = overSplit && innerCol >= this.#sidebarWidthLast + 3;

		if (event.motion) {
			this.#sidebarHover = overSidebar ? this.#sidebarScroll + contentLine : null;
			this.#sidebarFade?.set(this.#sidebarHover);
			return true;
		}
		if (event.wheel !== null) {
			if (overSidebar) {
				this.#sidebarScroll = clampLow(
					this.#sidebarScroll + event.wheel,
					0,
					Math.max(0, this.#entries.length - this.#sidebarListRows()),
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

		if (overSidebar) {
			const entry = this.#entries[this.#sidebarScroll + contentLine];
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
				// The add entry has no second step to offer, so a click on it starts the login the way
				// `enter` does. An account keeps select-then-act: `enter`, `x` and `n` all read the
				// selection, and a click that re-routed the session would be one no user asked for.
				if (target.kind === "add") this.#activate();
				this.#requestRender?.();
			}
		}
		return true;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════════

	#sidebarWidth(): number {
		let longest = SIDEBAR_MIN_WIDTH;
		for (const entry of this.#entries) {
			longest = Math.max(longest, visibleWidth(entry.label) + visibleWidth(entry.annotation) + 7);
		}
		return clampLow(longest, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
	}

	#glyph(kind: AccountGlyphKind): string {
		switch (kind) {
			// `●` in the unicode preset: the account this provider's next request goes to.
			case "serving":
				return theme.fg("success", theme.status.active);
			// `◦`, documented in the symbol table as the unfilled partner of `●`.
			case "idle":
				return theme.fg("muted", theme.status.connecting);
			case "failed":
				return theme.fg("error", theme.status.error);
			// `⊗`: usable again later, so it is not an error mark.
			case "blocked":
				return theme.fg("warning", theme.status.disabled);
		}
	}

	/**
	 * Rows the sidebar's provider list actually occupies, top-aligned in the split.
	 *
	 * One owner on purpose. The click router, the wheel clamp and the renderer each convert
	 * between a screen row and a provider index, and when two of them recomputed `rows - 3`
	 * independently a click on the summary block selected a provider scrolled out of view below
	 * the fold, and the wheel could never reach the last three providers.
	 */
	#sidebarListRows(): number {
		return Math.max(1, this.#splitRowCount - SIDEBAR_SUMMARY_ROWS);
	}

	#renderSidebar(width: number): string[] {
		const listRows = this.#sidebarListRows();
		// The scroll offset is the wheel's to pan freely; only an ACTIVATION snaps it back to the
		// selected provider. Following the active entry on every frame instead made the wheel look
		// broken: each pan was undone by the very next repaint, so the providers below the fold
		// were unreachable by mouse however far you scrolled.
		if (this.#sidebarFollowActive) {
			const activeIndex = Math.max(
				0,
				this.#entries.findIndex(entry => entry.providerId === this.#activeProviderId),
			);
			if (activeIndex < this.#sidebarScroll) this.#sidebarScroll = activeIndex;
			else if (activeIndex >= this.#sidebarScroll + listRows) this.#sidebarScroll = activeIndex - listRows + 1;
			this.#sidebarFollowActive = false;
		}
		this.#sidebarScroll = clampLow(this.#sidebarScroll, 0, Math.max(0, this.#entries.length - listRows));

		const lines: string[] = [];
		for (let i = this.#sidebarScroll; i < Math.min(this.#entries.length, this.#sidebarScroll + listRows); i++) {
			const entry = this.#entries[i];
			if (!entry) continue;
			const active = entry.providerId === this.#activeProviderId;
			const cursor = active && this.#focus === "sidebar" ? theme.fg("accent", theme.nav.cursor) : " ";
			// A provider you hold no account for dims ENTIRELY, label included. Only its count was
			// dimmed before, so forty empty providers sat at the same text weight as the three you use
			// and the eye had to read the right-hand column to find them. The list's job is "what you
			// have, then what you could have", and weight is what says which is which.
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
			let line = `${left}${" ".repeat(gap)}${annotation}`;
			const hoverStrength = this.#sidebarStrength(i);
			if (hoverStrength > 0) line = hoverBandAt(line, width, hoverStrength);
			lines.push(line);
		}
		while (lines.length < listRows + 1) lines.push("");
		lines.push(theme.fg("borderAccent", "─".repeat(Math.max(1, width - 2))));
		lines.push(theme.fg("dim", truncateToWidth(sidebarSummaryLine(this.#inventory), width)));
		return lines;
	}

	/**
	 * The body pane, as text plus the credential each line belongs to.
	 *
	 * Built unstyled-then-styled in one pass so the line index that carries a credential id is
	 * the same index the click router and the selection band use.
	 */

	/**
	 * Wrap a warning across up to three body lines instead of truncating it.
	 *
	 * These notes are the ONE place a user learns what to do: a torn-down login's cause names the
	 * remedy (`invalid_grant` means re-login, a 400 from the provider does not), and truncating it to
	 * `oauth refresh failed:…` leaves exactly the half that says nothing. Bounded at three lines so a
	 * pathological upstream body cannot push the account list off the card, with an ellipsis marking
	 * that something was dropped rather than pretending the text ended.
	 */
	#wrapNote(text: string, indent: string, width: number): string[] {
		// Hanging indent: the content is wrapped at the REMAINING width and every line, continuation
		// included, carries the indent. Wrapping the already-indented string instead let continuation
		// lines start at column 0, so a three-line warning stepped left of its own first line.
		const inner = Math.max(8, width - indent.length);
		const wrapped = wrapTextWithAnsi(text, inner).map(part => `${indent}${part}`);
		if (wrapped.length <= NOTE_MAX_LINES) return wrapped;
		const kept = wrapped.slice(0, NOTE_MAX_LINES);
		const last = truncateToWidth(kept[NOTE_MAX_LINES - 1] ?? "", Math.max(1, width - 1));
		// `truncateToWidth` appends its own ellipsis when it clips, so adding one unconditionally
		// produced `…`-`…` on any note long enough to need both.
		kept[NOTE_MAX_LINES - 1] = last.endsWith("…") ? last : `${last}…`;
		return kept;
	}

	#buildBodyLines(width: number, nowMs: number): BodyLine[] {
		const entry = this.#activeEntry();
		if (!entry) return [{ text: theme.fg("muted", "No providers available") }];
		const rows = this.#rows();
		// The header wraps for the same reason the scope line does: it is the card's own sentence, and
		// the fact at its END is the one a user is looking for. Truncated, the recording read
		// `Anthropic · 3 accounts · 1 needs attenti…`, which cuts the only clause that says something
		// is wrong.
		const lines: BodyLine[] = this.#wrapNote(providerHeaderLine(entry.label, rows), "", width).map(wrapped => ({
			text: theme.bold(wrapped),
		}));
		// The scope, stated once per provider, because the choice below is not what a user
		// assumes. Every account here is shared by every profile and every session on this
		// machine, so pressing enter changes what a different terminal will use too. The
		// load-balancing state rides the same line: it is the answer to "what happens when this
		// account runs out", which is the next question the bars below provoke.
		//
		// WRAPPED, not truncated: with the sidebar taking its 30 columns the pane is ~54 wide, and
		// truncation cut this at `…on thi…`, dropping the load-balancing clause entirely. A scope
		// warning that only renders in full on a wide terminal is not a warning.
		// The two scopes are NAMED separately because they are not the same scope. Credentials live
		// in the machine-wide auth db, so every profile and session sees this list; load balancing is
		// an ordinary setting in the active profile's `agent/config.yml`, so another profile can have
		// it the other way. One line saying "shared by every profile · balancing on" read as though
		// the toggle travelled with the accounts, which is the opposite of true.
		for (const wrapped of this.#wrapNote(
			`accounts shared by every profile and session on this machine · quota load balancing ${
				this.#loadBalancing ? "on" : "off"
			} for this profile`,
			"",
			width,
		)) {
			lines.push({ text: theme.fg("dim", wrapped) });
		}
		lines.push({ text: "" });

		const group = this.#inventory.providers.find(candidate => candidate.provider === this.#activeProviderId);
		if (group) {
			for (const note of providerDisabledNote(group)) {
				for (const wrapped of this.#wrapNote(note, "  ", width)) {
					lines.push({ text: theme.fg("warning", wrapped) });
				}
			}
			if (group.disabledCause) lines.push({ text: "" });
		}

		const divergence = selectedButRotated(this.#inventory, this.#activeProviderId);
		if (divergence) {
			for (const line of divergenceLines(divergence, nowMs)) {
				for (const wrapped of this.#wrapNote(line, "  ", width)) {
					lines.push({ text: theme.fg("warning", wrapped) });
				}
			}
			lines.push({ text: "" });
		}

		for (const row of rows) {
			const target: BodyTarget = { kind: "account", credentialId: row.credentialId };
			const selected = this.#isSelected(target);
			const head = accountHeadLine(row, nowMs);
			const cursor = selected && this.#focus === "body" ? theme.fg("accent", theme.nav.cursor) : " ";
			const glyph = this.#glyph(accountGlyphKind(row, nowMs));
			const label = selected ? theme.bold(theme.fg("accent", head.label)) : head.label;
			const detail = head.detail ? `  ${theme.fg("muted", head.detail)}` : "";
			const tag = head.tag ? theme.fg(row.activeForSession ? "success" : "warning", head.tag) : "";
			const left = ` ${cursor} ${glyph} ${label}${detail}`;
			// A tag that does not fit is DROPPED, not truncated. `truncateToWidth` over the joined row
			// cut the right-aligned tag instead of the left text, so a long email left `needs …` on
			// screen: an ellipsis where a status word belongs, and the least informative element on the
			// row winning space from the identity. The glyph already carries the state, so losing the
			// word costs nothing, while one gap column is the minimum that keeps them apart.
			const tagFits = tag.length > 0 && visibleWidth(left) + 1 + visibleWidth(tag) <= width;
			const gap = tagFits ? width - visibleWidth(left) - visibleWidth(tag) : 0;
			let text = tagFits ? `${left}${" ".repeat(gap)}${tag}` : truncateToWidth(left, width);
			if (selected) text = selectionBand(text, width);
			lines.push({ text, target });

			if (this.#rename?.credentialId === row.credentialId) {
				const prompt = theme.fg("accent", "name:");
				const field = this.#rename.input.render(Math.max(8, Math.min(32, width - 14)))[0] ?? "";
				lines.push({ text: truncateToWidth(`       ${prompt} ${field}`, width), target });
			}

			// `muted`, not `dim`: this line carries the plan and the origin badge, which outrank the
			// usage bars underneath it, and rendering it quieter than they are inverted the hierarchy.
			const plan = accountPlanLine(row);
			if (plan) lines.push({ text: theme.fg("muted", truncateToWidth(`       ${plan}`, width)), target });
			for (const usage of accountUsageLines(row, nowMs)) {
				lines.push({ text: truncateToWidth(`       ${usage}`, width), target });
			}
			for (const notice of accountNoticeLines(row, nowMs)) {
				// Wrapped for the same reason as the provider note: a failed row's upstream reason is
				// the remedy, and its useful half is at the END of the string.
				for (const wrapped of this.#wrapNote(notice, "       ", width)) {
					lines.push({ text: theme.fg("error", wrapped), target });
				}
			}
			if (this.#pendingLogoutCredentialId === row.credentialId) {
				// The confirmation for the one destructive key on this card, so it is WRAPPED: at pane
				// width it truncated to `log out of Groq cr…`, which loses both which credential is
				// about to go and that `esc` backs out. A confirmation prompt missing its escape is a
				// worse defect than a clipped label.
				for (const wrapped of this.#wrapNote(
					`press x again to log out of ${head.label} · esc cancels`,
					"       ",
					width,
				)) {
					lines.push({ text: theme.fg("warning", wrapped), target });
				}
			}
			lines.push({ text: "" });
		}

		if (rows.length === 0) {
			for (const wrapped of this.#wrapNote("No accounts stored for this provider yet.", "  ", width)) {
				lines.push({ text: theme.fg("muted", wrapped) });
			}
			lines.push({ text: "" });
		}

		// The last position in the list, and a selectable one. Down from the last account lands
		// here, `enter` starts the login, and the cursor column lines up with the account glyphs
		// above so the entry reads as part of the same list rather than a caption under it.
		const addTarget: BodyTarget = { kind: "add" };
		const addSelected = this.#isSelected(addTarget);
		const addCursor = addSelected && this.#focus === "body" ? theme.fg("accent", theme.nav.cursor) : " ";
		// No `(a)` hint: the footer chip two rows below already says `a add`, and naming the key
		// twice on one card reads as two different affordances.
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
		const entry = this.#activeEntry();
		// The chip names the ACTION, not the mechanism: "switch to" is what pressing enter does, and
		// the previous "use for <provider>" left the card's headline capability reading as a noun.
		// Naming the provider is still the point — switching is per provider, and a bare "enter
		// switch" reads as a global account change. On the add entry `enter` switches nothing, so
		// the chip says what it will actually do rather than naming an account it cannot pick.
		const use =
			this.#bodySelection.kind === "add"
				? entry
					? `enter add ${entry.label} account`
					: "enter add account"
				: entry
					? `enter switch ${entry.label} to this account`
					: "enter switch to this account";
		// The three account-scoped keys are omitted while the add entry is selected. `n`, `u` and `x`
		// all read the selected ACCOUNT, and the add entry is not one, so each was a chip the card
		// painted, made clickable, and answered with nothing: the same defect the `enter` chip above
		// used to have, left in place for the keys either side of it. A footer that advertises a key
		// which does nothing teaches the operator that the card is unresponsive rather than that the
		// row is different.
		const onAddEntry = this.#bodySelection.kind === "add";
		return [
			{ label: "↑↓ move" },
			{ label: "←→ pane" },
			{ label: use, clickable: true, id: "confirm" },
			...(onAddEntry ? [] : [{ label: "n name", clickable: true, id: "name" }]),
			// Stays on the add entry, where it refreshes the provider's accounts: the probe is the one
			// account-area key that still means something with no row selected. The label says which of
			// the two it is about to do, because "refresh" alone leaves the reader to guess whether
			// pressing it costs one round-trip or nine.
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
			{ label: "a add", clickable: true, id: "add" },
			{ label: `b balancing ${this.#loadBalancing ? "on" : "off"}`, clickable: true, id: "balance" },
			{ label: "esc close", clickable: true, id: "close" },
		];
	}

	render(width: number): readonly string[] {
		// EXACTLY the rows the screen has, never a floor of its own. The host mounts this card as a
		// fullscreen overlay with `maxHeight: "100%"`, so a frame taller than the terminal is clipped
		// by the overlay — and because the card is bottom-anchored, the clip comes off the TOP. The
		// title row and the `[x]` disappear, and every row in `#shellGeometry` is then off by the
		// clipped amount, so the close glyph, the footer chips and the whole split answer to clicks
		// several rows away from where they are painted. `computeModalDims` already refuses a screen
		// too small to draw on, which is the case a minimum height was standing in for.
		const height = this.#terminalHeight ?? (process.stdout.rows || 40);
		const sizing = sizingForArea(MODAL_SIZING_LARGE, height);
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: height }, () => padding(width));
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
		// Published before the panes render: `#sidebarListRows` reads it, and so does every mouse
		// event that arrives between this frame and the next.
		this.#splitRowCount = splitRows;
		const nowMs = Date.now();

		// The line COUNT does not depend on width — each account contributes a fixed set of lines —
		// so overflow can be decided from a first build and the two columns the scrollbar takes can
		// be handed to a rebuild. Without that the right-aligned routing tag and the selection band
		// are laid out two columns too wide and the scrollbar clips them.
		this.#bodyLines = this.#buildBodyLines(bodyWidth, nowMs);
		if (this.#bodyLines.length > splitRows) {
			this.#bodyLines = this.#buildBodyLines(Math.max(1, bodyWidth - 2), nowMs);
		}
		// Keep the selected entry on screen: it is what `enter`, `x`, `n` and `u` act on. Every line
		// of an entry's block carries the target, so this finds the block's head line.
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
			rowWidth => window.map(line => truncateToWidth(line.text, rowWidth)),
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
		return applyModalReveal(shell, width, this.#reveal.value);
	}
}
