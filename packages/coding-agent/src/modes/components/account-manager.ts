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
import { accountsForProvider, pinnedButRotated } from "../../session/account-inventory";
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
	computeModalDims,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	ModalRevealDriver,
	type ModalShellGeometry,
	type ModalShortcut,
	modalNeedsCompactPadding,
	planModalChrome,
	renderModalShell,
	withCompact,
} from "./modal-shell";
import { fit } from "./overlay-box";
import { renderScrollableList, selectionBand } from "./selector-helpers";

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

export interface AccountManagerCallbacks {
	/** Route this provider's traffic to this credential for the session. */
	onUseAccount: (row: AccountRow) => void;
	/** Persist a chosen name for this credential. An empty string clears it. */
	onRename: (row: AccountRow, name: string) => void;
	/** Re-probe health and usage for one provider. */
	onRefresh: (provider: string) => void;
	/** Remove this credential from the store. Destructive; the card confirms first. */
	onLogout: (row: AccountRow) => void;
	/** Show the full usage report for one account. */
	onShowUsage: (row: AccountRow) => void;
	/** Start a login that adds another account for this provider. */
	onAddAccount: (provider: string) => void;
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
	 * in an image proof, which has happened here before (see `scripts/demos/render-secret-manager.ts`).
	 * Naming the height is what makes a proof reproduce the operator's card.
	 */
	terminalHeight?: number;
}

/** One rendered body line, and the account it belongs to when it is the selectable head line. */
interface BodyLine {
	text: string;
	/** Set only on a row's first line — the one the cursor lands on and the band paints. */
	credentialId?: number;
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
	 */
	#selectedCredentialId: number | null = null;

	#sidebarScroll = 0;
	/** Set by an activation (keys, click, open) so the next paint reveals the active provider. */
	#sidebarFollowActive = true;
	#sidebarHover: number | null = null;
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

	constructor(inventory: AccountInventory, callbacks: AccountManagerCallbacks, options: AccountManagerOptions = {}) {
		this.#inventory = inventory;
		this.#callbacks = callbacks;
		this.#requestRender = options.requestRender;
		this.#terminalHeight = options.terminalHeight;
		this.#rebuildEntries();
		const requested = options.initialProviderId;
		if (requested && this.#entries.some(entry => entry.providerId === requested)) {
			this.#activeProviderId = requested;
		}
		this.#selectedCredentialId = this.#rows()[0]?.credentialId ?? null;
		if (options.reveal) this.#reveal.start(() => this.#requestRender?.());
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
		if (!rows.some(row => row.credentialId === this.#selectedCredentialId)) {
			this.#selectedCredentialId = rows[0]?.credentialId ?? null;
			this.#rename = null;
			this.#pendingLogoutCredentialId = null;
		}
	}

	dispose(): void {
		this.#reveal.stop();
	}

	#rebuildEntries(): void {
		this.#entries = buildSidebarEntries(
			this.#inventory,
			// `formatProviderName`, the SAME rule the inventory labels a populated provider with, not
			// the catalog's marketing name. One list cannot label the same provider two ways depending
			// on whether you happen to hold an account: `openai-codex` read as "Openai Codex" once it
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

	#selectedRow(): AccountRow | undefined {
		return this.#rows().find(row => row.credentialId === this.#selectedCredentialId);
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
			this.#pendingLogoutCredentialId = null;
			return;
		}
		if (matchesKey(data, "right")) {
			this.#focus = "body";
			this.#pendingLogoutCredentialId = null;
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const row = this.#selectedRow();
			if (row) this.#callbacks.onUseAccount(row);
			return;
		}

		switch (data) {
			case "n":
				this.#openRename();
				return;
			case "r":
				if (this.#activeProviderId) this.#callbacks.onRefresh(this.#activeProviderId);
				return;
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
		if (rows.length === 0) return;
		const current = Math.max(
			0,
			rows.findIndex(row => row.credentialId === this.#selectedCredentialId),
		);
		const next = (current + direction + rows.length) % rows.length;
		this.#selectedCredentialId = rows[next]?.credentialId ?? null;
	}

	#selectProvider(providerId: string): void {
		if (providerId === this.#activeProviderId) return;
		this.#activeProviderId = providerId;
		this.#rename = null;
		this.#pendingLogoutCredentialId = null;
		this.#bodyScroll = 0;
		this.#sidebarFollowActive = true;
		this.#selectedCredentialId = this.#rows()[0]?.credentialId ?? null;
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
		if (chrome.kind === "hover-shortcut") {
			if (this.#hoveredShortcutId !== chrome.id) {
				this.#hoveredShortcutId = chrome.id;
				this.#requestRender?.();
			}
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
			const line = this.#bodyLines[this.#bodyScroll + contentLine];
			if (line?.credentialId !== undefined) {
				this.#focus = "body";
				this.#selectedCredentialId = line.credentialId;
				this.#pendingLogoutCredentialId = null;
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
			if (i === this.#sidebarHover) line = selectionBand(line, width);
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
		const lines: BodyLine[] = [
			{ text: theme.bold(truncateToWidth(providerHeaderLine(entry.label, rows), width)) },
			{ text: "" },
		];

		const group = this.#inventory.providers.find(candidate => candidate.provider === this.#activeProviderId);
		if (group) {
			for (const note of providerDisabledNote(group)) {
				for (const wrapped of this.#wrapNote(note, "  ", width)) {
					lines.push({ text: theme.fg("warning", wrapped) });
				}
			}
			if (group.disabledCause) lines.push({ text: "" });
		}

		const divergence = pinnedButRotated(this.#inventory, this.#activeProviderId);
		if (divergence) {
			for (const line of divergenceLines(divergence, nowMs)) {
				lines.push({ text: theme.fg("warning", truncateToWidth(`  ${line}`, width)) });
			}
			lines.push({ text: "" });
		}

		for (const row of rows) {
			const selected = row.credentialId === this.#selectedCredentialId;
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
			lines.push({ text, credentialId: row.credentialId });

			if (this.#rename?.credentialId === row.credentialId) {
				const prompt = theme.fg("accent", "name:");
				const field = this.#rename.input.render(Math.max(8, Math.min(32, width - 14)))[0] ?? "";
				lines.push({ text: truncateToWidth(`       ${prompt} ${field}`, width) });
			}

			// `muted`, not `dim`: this line carries the plan and the origin badge, which outrank the
			// usage bars underneath it, and rendering it quieter than they are inverted the hierarchy.
			const plan = accountPlanLine(row);
			if (plan) lines.push({ text: theme.fg("muted", truncateToWidth(`       ${plan}`, width)) });
			for (const usage of accountUsageLines(row, nowMs)) {
				lines.push({ text: truncateToWidth(`       ${usage}`, width) });
			}
			for (const notice of accountNoticeLines(row, nowMs)) {
				// Wrapped for the same reason as the provider note: a failed row's upstream reason is
				// the remedy, and its useful half is at the END of the string.
				for (const wrapped of this.#wrapNote(notice, "       ", width)) {
					lines.push({ text: theme.fg("error", wrapped) });
				}
			}
			if (this.#pendingLogoutCredentialId === row.credentialId) {
				lines.push({
					text: theme.fg(
						"warning",
						truncateToWidth(`       press x again to log out of ${head.label} · esc cancels`, width),
					),
				});
			}
			lines.push({ text: "" });
		}

		if (rows.length === 0) {
			lines.push({ text: theme.fg("muted", truncateToWidth("  No accounts stored for this provider yet.", width)) });
			lines.push({ text: "" });
		}
		lines.push({
			text: theme.fg(
				"accent",
				// No `(a)` hint: the footer chip two rows below already says `a add`, and naming the key
				// twice on one card reads as two different affordances.
				truncateToWidth(`  + add another ${sanitizeAccountText(entry.label)} account`, width),
			),
		});
		return lines;
	}

	#shortcuts(): ModalShortcut[] {
		if (this.#rename) {
			return [{ label: "enter save name" }, { label: "esc cancel", clickable: true, id: "close" }];
		}
		const entry = this.#activeEntry();
		// Naming the provider is the point: `enter use` alone reads as a global account switch,
		// and switching accounts is per provider.
		const use = entry ? `enter use for ${entry.label}` : "enter use";
		return [
			{ label: "↑↓ move" },
			{ label: "←→ pane" },
			{ label: use },
			{ label: "n name" },
			{ label: "r refresh" },
			{ label: "u usage" },
			{ label: this.#pendingLogoutCredentialId === null ? "x logout" : "x confirm logout" },
			{ label: "a add" },
			{ label: "esc close", clickable: true, id: "close" },
		];
	}

	render(width: number): readonly string[] {
		const height = Math.max(16, this.#terminalHeight ?? (process.stdout.rows || 40));
		const sizing = withCompact(MODAL_SIZING_LARGE, modalNeedsCompactPadding(height, MODAL_SIZING_LARGE));
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
		// Keep the selected row on screen: it is what `enter`, `x`, `n` and `u` act on.
		const selectedLine = this.#bodyLines.findIndex(line => line.credentialId === this.#selectedCredentialId);
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
