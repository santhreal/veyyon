import { getOAuthProviders } from "@veyyon/ai/oauth";
import type { OAuthProviderInfo } from "@veyyon/ai/oauth/types";
import {
	type Component,
	clampLow,
	extractPrintableText,
	fuzzyFilter,
	HoverFade,
	matchesKey,
	type SgrMouseEvent,
	truncateToWidth,
} from "@veyyon/tui";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import { settings } from "../../config/settings-instance";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { AuthStorage, CredentialOriginKind } from "../../session/auth-storage";
import { modalRevealEnabled } from "./modal-shell";
import { hoverBandAt, renderScrollableList } from "./selector-helpers";

/** Default visible provider rows when the host does not size the selector. */
const OAUTH_SELECTOR_MAX_VISIBLE = 10;

/**
 * Provider ids the user has disabled via settings. The sign-in list hides these
 * so a disabled provider's models stay out of reach end-to-end, mirroring
 * the model picker's `disabledProviders` filtering. Reads the settings singleton
 * defensively: it throws before `Settings.init()`, in which case nothing is disabled.
 */
function getDisabledProviderIds(): ReadonlySet<string> {
	try {
		return new Set(settings.get("disabledProviders"));
	} catch {
		return new Set();
	}
}

/** Compact, human-readable tag for each credential-origin leg. */
const ORIGIN_LABELS: Record<CredentialOriginKind, string> = {
	runtime: "--api-key",
	config: "config",
	oauth: "login",
	api_key: "api key",
	env: "env",
	fallback: "custom provider",
};

/**
 * Component that renders an OAuth provider selector for signing IN.
 *
 * Content-only rows, no chrome: the one host is the setup wizard's Sign-in tab, which supplies its
 * own scene border, sizes the list with {@link setMaxVisible} and forwards mouse reports through
 * {@link routeMouse} at a local line/col offset. Logging out is not a provider choice at all any
 * more, so there is no second mode: the account card owns it, one row per credential.
 */
export class OAuthSelectorComponent implements Component {
	#allProviders: OAuthProviderInfo[] = [];
	#filteredProviders: OAuthProviderInfo[] = [];
	#searchQuery = "";
	/**
	 * True while {@link #searchQuery} is something the user typed here.
	 *
	 * {@link #isSearchEnabled} is a function of the CURRENT row budget, and the
	 * setup wizard resizes this selector on every render, so growing the terminal
	 * until every provider fits used to turn a live query un-typeable, un-
	 * backspaceable and un-clearable in one frame — and, because the wizard reads
	 * {@link hasActiveSearch} to decide who owns Escape, turned Escape back into
	 * "end onboarding" while a filtered list was still on screen. A query the
	 * user typed stays theirs to clear whatever the budget does afterwards.
	 */
	#searchTypedByUser = false;
	#selectedIndex: number = 0;
	#hoveredIndex: number | null = null;
	/**
	 * The cross-fade between the provider the pointer left and the one it arrived at, when the host
	 * gave this card a repaint. Absent, the band is switched.
	 */
	#hoverFade: HoverFade | undefined;
	/** First provider index of the visible ScrollView window (last #buildBody). */
	#scrollStart = 0;
	#visibleCount = 0;
	/**
	 * Visible provider rows. Instance state, not the module constant, so a host
	 * that owns the viewport can size the selector to it: inside the setup
	 * wizard a fixed ten rows overran the body budget, and the wizard clipped the
	 * tail, leaving providers below the fold unreachable during onboarding.
	 */
	#maxVisible = OAUTH_SELECTOR_MAX_VISIBLE;
	#authStorage: AuthStorage;
	#onSelectCallback: (providerId: string) => void;
	#onCancelCallback: () => void;
	#statusMessage: string | undefined;
	#validateAuthCallback?: (providerId: string) => Promise<boolean>;
	#requestRenderCallback?: () => void;
	#authState: Map<string, "checking" | "valid" | "invalid"> = new Map();
	#spinnerFrame: number = 0;
	#spinnerInterval?: NodeJS.Timeout;
	#validationGeneration: number = 0;

	constructor(
		authStorage: AuthStorage,
		onSelect: (providerId: string) => void,
		onCancel: () => void,
		options?: {
			validateAuth?: (providerId: string) => Promise<boolean>;
			requestRender?: () => void;
		},
	) {
		this.#authStorage = authStorage;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#validateAuthCallback = options?.validateAuth;
		this.#requestRenderCallback = options?.requestRender;
		// The band fades only when the host lends a repaint: the frames between two mouse reports
		// have no input to hang off. Same ambient gate as a card's open unfold.
		if (this.#requestRenderCallback !== undefined) {
			const requestRender = this.#requestRenderCallback;
			this.#hoverFade = new HoverFade({ requestRender, enabled: modalRevealEnabled() });
		}
		this.#loadProviders();
		this.#startValidation();
	}

	/** Size the provider list to the rows the host can actually show. */
	setMaxVisible(rows: number): void {
		this.#maxVisible = Math.max(1, Math.floor(rows));
	}

	/**
	 * Whether the cancel key clears a live search instead of closing the selector.
	 *
	 * A host that owns Escape (the setup wizard, whose Escape leaves onboarding)
	 * has to ask before consuming it, or the user's way of undoing a mistyped
	 * search is the same key that ends the run. The host claims Escape while this
	 * is true and forwards the keystroke here.
	 *
	 * Gated on the search being CLEARABLE, not merely stored, so the answer
	 * matches what the cancel key will actually do. A query the user typed stays
	 * clearable after a resize shrinks the provider list back inside the window;
	 * see {@link #searchTypedByUser}.
	 */
	hasActiveSearch(): boolean {
		return this.#searchQuery.length > 0 && (this.#searchTypedByUser || this.#isSearchEnabled());
	}

	stopValidation(): void {
		this.#validationGeneration += 1;
		this.#stopSpinner();
	}

	/** Settle the pointer band so no timer outlives a card the host has finished with. */
	dispose(): void {
		this.stopValidation();
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoveredIndex = null;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	#hasSelectableAuth(providerId: string): boolean {
		return this.#authStorage.hasAuth(providerId);
	}

	#loadProviders(): void {
		const disabled = getDisabledProviderIds();
		// Hide a login entry when either its own id or the provider id it stores credentials under is
		// disabled, so alias logins (e.g. `openai-codex-device` ⇒ `openai-codex`) disappear alongside
		// the model provider they authenticate.
		this.#allProviders = getOAuthProviders().filter(
			provider =>
				!disabled.has(provider.id) && !(provider.storeCredentialsAs && disabled.has(provider.storeCredentialsAs)),
		);
		this.#filteredProviders = this.#allProviders;
	}

	#startValidation(): void {
		if (!this.#validateAuthCallback) return;
		const generation = this.#validationGeneration + 1;
		this.#validationGeneration = generation;

		let pending = 0;
		for (const provider of this.#allProviders) {
			if (!this.#hasSelectableAuth(provider.id)) {
				this.#authState.delete(provider.id);
				continue;
			}
			this.#authState.set(provider.id, "checking");
			pending += 1;
			void this.#validateProvider(provider.id, generation);
		}

		if (pending > 0) {
			this.#startSpinner();
			this.#requestRenderCallback?.();
		}
	}

	async #validateProvider(providerId: string, generation: number): Promise<void> {
		if (!this.#validateAuthCallback) return;
		let isValid = false;
		try {
			isValid = await this.#validateAuthCallback(providerId);
		} catch {
			isValid = false;
		}

		if (generation !== this.#validationGeneration) return;
		this.#authState.set(providerId, isValid ? "valid" : "invalid");
		if (![...this.#authState.values()].includes("checking")) {
			this.#stopSpinner();
		}
		this.#requestRenderCallback?.();
	}

	#startSpinner(): void {
		if (this.#spinnerInterval) return;
		this.#spinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount > 0) {
				this.#spinnerFrame = (this.#spinnerFrame + 1) % frameCount;
			}
			this.#requestRenderCallback?.();
		}, 80);
	}

	#stopSpinner(): void {
		if (this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
		}
	}

	/**
	 * Muted provenance suffix (" (env: COPILOT_GITHUB_TOKEN)", " (login)", …) so
	 * the list distinguishes a real login from an env var aliasing the provider.
	 */
	#getSourceLabel(providerId: string): string {
		const origin = this.#authStorage.getCredentialOrigin(providerId);
		if (!origin) return "";
		const detail = origin.kind === "env" && origin.envVar ? `env: ${origin.envVar}` : ORIGIN_LABELS[origin.kind];
		return theme.fg("muted", ` (${detail})`);
	}

	#getStatusIndicator(providerId: string): string {
		const state = this.#authState.get(providerId);
		const source = this.#getSourceLabel(providerId);
		if (state === "checking") {
			const frameCount = theme.spinnerFrames.length;
			const spinner = frameCount > 0 ? theme.spinnerFrames[this.#spinnerFrame % frameCount] : theme.status.pending;
			return theme.fg("warning", ` ${spinner} checking`) + source;
		}
		if (state === "invalid") {
			return theme.fg("error", ` ${theme.status.error} invalid`) + source;
		}
		if (state === "valid") {
			return theme.fg("success", ` ${theme.status.enabled} logged in`) + source;
		}
		return this.#hasSelectableAuth(providerId)
			? theme.fg("success", ` ${theme.status.enabled} logged in`) + source
			: "";
	}

	#isSearchEnabled(): boolean {
		return this.#allProviders.length > this.#maxVisible;
	}

	#shouldRenderSearchStatus(): boolean {
		return this.#isSearchEnabled() || this.#searchQuery.length > 0;
	}

	#renderStatusLine(_total: number): string {
		const query = this.#searchQuery.trim();
		const suffix = query ? `Search: ${this.#searchQuery}` : "Type to search";
		return theme.fg("muted", `  ${suffix}`);
	}

	#getProviderSearchText(provider: OAuthProviderInfo): string {
		let text = `${provider.name} ${provider.id}`;
		const origin = this.#authStorage.getCredentialOrigin(provider.id);
		if (origin) {
			text += ` logged in authenticated ${ORIGIN_LABELS[origin.kind]}`;
			if (origin.envVar) text += ` ${origin.envVar}`;
		}
		if (!provider.available) {
			text += " unavailable";
		}
		return text;
	}

	#setSearchQuery(query: string, typedByUser = false): void {
		this.#searchQuery = query;
		this.#searchTypedByUser = query.length > 0 && typedByUser;
		this.#filteredProviders = query.trim()
			? fuzzyFilter(this.#allProviders, query, provider => this.#getProviderSearchText(provider))
			: this.#allProviders;
		this.#selectedIndex = 0;
		this.#statusMessage = undefined;
	}

	#handleSearchInput(keyData: string): boolean {
		// Backspace is judged by whether the query is CLEARABLE, not by whether a
		// new one could be started: a resize that grows the window past the
		// provider count must not strand the query the user already typed.
		if (matchesKey(keyData, "backspace")) {
			if (!this.hasActiveSearch()) return false;
			const chars = [...this.#searchQuery];
			chars.pop();
			this.#setSearchQuery(chars.join(""), true);
			return true;
		}

		if (!this.#isSearchEnabled()) return false;

		const printableText = extractPrintableText(keyData);
		if (printableText === undefined) return false;
		if (this.#searchQuery.length === 0 && printableText.trim().length === 0) return false;

		this.#setSearchQuery(this.#searchQuery + printableText, true);
		return true;
	}

	#buildBody(width: number): string[] {
		const total = this.#filteredProviders.length;
		const maxVisible = this.#maxVisible;
		const startIndex =
			total <= maxVisible ? 0 : clampLow(this.#selectedIndex - Math.floor(maxVisible / 2), 0, total - maxVisible);
		const endIndex = Math.min(startIndex + maxVisible, total);
		this.#scrollStart = startIndex;
		this.#visibleCount = endIndex - startIndex;

		const body: string[] = [];
		if (endIndex > startIndex) {
			body.push(
				...renderScrollableList(
					{ width, visibleRows: endIndex - startIndex, totalRows: total, scrollOffset: startIndex },
					rowWidth => {
						const rows: string[] = [];
						for (let i = startIndex; i < endIndex; i++) {
							const provider = this.#filteredProviders[i];
							if (!provider) continue;
							const isSelected = i === this.#selectedIndex;
							const isAvailable = provider.available;
							const statusIndicator = this.#getStatusIndicator(provider.id);

							let line: string;
							if (isSelected) {
								const prefix = theme.fg("accent", `${theme.nav.cursor} `);
								const text = isAvailable ? theme.fg("accent", provider.name) : theme.fg("dim", provider.name);
								line = prefix + text + statusIndicator;
							} else {
								const text = isAvailable ? `  ${provider.name}` : theme.fg("dim", `  ${provider.name}`);
								line = text + statusIndicator;
							}
							// The cursor row answers the pointer like any other: its accent prefix is not a band,
							// so suppressing the band here left the row the eye was already on feeling dead.
							const strength = this.#hoverStrength(i);
							rows.push(strength > 0 ? hoverBandAt(line, rowWidth, strength) : truncateToWidth(line, rowWidth));
						}
						return rows;
					},
				),
			);
		}

		// Search status line (scrollbar covers overflow indication)
		if (this.#shouldRenderSearchStatus()) {
			body.push(this.#renderStatusLine(total));
		}

		if (total === 0) {
			body.push(
				theme.fg(
					"muted",
					`  ${this.#allProviders.length === 0 ? "No OAuth providers available" : "No matching providers"}`,
				),
			);
		}
		if (this.#statusMessage) {
			body.push("", theme.fg("warning", `  ${this.#statusMessage}`));
		}
		return body;
	}

	handleInput(keyData: string): void {
		// Escape or Ctrl+C. Cancel-key ladder, the same one SelectList and the
		// model browser use: a live search query is cleared first, and only a
		// cancel with no query closes. Going straight to the cancel callback was
		// the worst instance of it in the product, because this selector is step 1
		// of onboarding: typing one letter to find a provider and pressing Escape
		// to undo that ENDED the whole setup run, with no recovery and nothing on
		// screen that had named Escape as anything but "leave setup".
		if (matchesSelectCancel(keyData)) {
			if (this.hasActiveSearch()) {
				this.#setSearchQuery("");
				this.#requestRenderCallback?.();
				return;
			}
			this.stopValidation();
			this.#onCancelCallback();
			return;
		}

		if (this.#handleSearchInput(keyData)) {
			return;
		}

		// Up arrow
		if (matchesSelectUp(keyData)) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === 0 ? this.#filteredProviders.length - 1 : this.#selectedIndex - 1;
			}
			this.#statusMessage = undefined;
		}
		// Down arrow
		else if (matchesSelectDown(keyData)) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === this.#filteredProviders.length - 1 ? 0 : this.#selectedIndex + 1;
			}
			this.#statusMessage = undefined;
		}
		// Page up - jump up by one visible page
		else if (matchesKey(keyData, "pageUp")) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex = Math.max(0, this.#selectedIndex - this.#maxVisible);
			}
			this.#statusMessage = undefined;
		}
		// Page down - jump down by one visible page
		else if (matchesKey(keyData, "pageDown")) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex = Math.min(this.#filteredProviders.length - 1, this.#selectedIndex + this.#maxVisible);
			}
			this.#statusMessage = undefined;
		}
		// Enter
		else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#confirmSelection();
		}
	}

	/** Confirm the selected provider (Enter or mouse click). */
	#confirmSelection(): void {
		const selectedProvider = this.#filteredProviders[this.#selectedIndex];
		if (selectedProvider?.available) {
			this.#statusMessage = undefined;
			this.stopValidation();
			this.#onSelectCallback(selectedProvider.id);
		} else if (selectedProvider) {
			this.#statusMessage = "Provider unavailable in this environment.";
		}
	}

	/** Move the selection one step for a wheel notch (clamped, no wrap). */
	handleWheel(delta: -1 | 1): void {
		if (this.#filteredProviders.length === 0) return;
		const next = clampLow(this.#selectedIndex + delta, 0, this.#filteredProviders.length - 1);
		if (next === this.#selectedIndex) return;
		this.#selectedIndex = next;
		this.#statusMessage = undefined;
	}

	/**
	 * Route an SGR mouse report at component-local coordinates. Embedded hosts
	 * (the setup wizard's sign-in tab) call this directly at a line/col offset
	 * relative to where the selector's own body begins. Provider rows start at
	 * line 0 — this component renders no chrome above the list itself.
	 */
	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (event.wheel !== null) {
			this.handleWheel(event.wheel);
			return;
		}
		const index = line >= 0 && line < this.#visibleCount ? this.#scrollStart + line : undefined;
		const target = index !== undefined && index < this.#filteredProviders.length ? index : null;
		if (event.motion) {
			this.#hoveredIndex = target;
			this.#hoverFade?.set(target);
			return;
		}
		if (!event.leftClick || target === null) return;
		if (target !== this.#selectedIndex) {
			this.#selectedIndex = target;
			this.#statusMessage = undefined;
		}
		this.#confirmSelection();
	}

	/** Band strength for a provider row; without a fade the hovered row is at 1 and the rest at 0. */
	#hoverStrength(index: number): number {
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(index);
		return index === this.#hoveredIndex ? 1 : 0;
	}

	render(width: number): readonly string[] {
		return this.#buildBody(width);
	}
}
