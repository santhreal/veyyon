import { getOAuthProviders } from "@veyyon/ai/oauth";
import type { OAuthProviderInfo } from "@veyyon/ai/oauth/types";
import {
	type Component,
	clampLow,
	extractPrintableText,
	fuzzyFilter,
	matchesKey,
	padding,
	routeSgrMouseInput,
	ScrollView,
	type SgrMouseEvent,
} from "@veyyon/tui";
import { settings } from "../../config/settings";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { AuthStorage, CredentialOriginKind } from "../../session/auth-storage";
import {
	computeModalDims,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	renderModalShell,
	SELECT_LIST_SHORTCUTS,
	withCompact,
} from "./modal-shell";

const OAUTH_SELECTOR_MAX_VISIBLE = 10;

/**
 * Provider ids the user has disabled via settings. `/login` (login mode) hides
 * these so a disabled provider's models stay out of reach end-to-end, mirroring
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
 * Component that renders an OAuth provider selector.
 *
 * Two hosting modes:
 * - Embedded (`standalone: false`, the default): content-only rows, no
 *   chrome. Used inline by the setup wizard's Sign-in tab, which supplies its
 *   own scene border and forwards mouse via {@link routeMouse} at a local
 *   line/col offset.
 * - Standalone (`standalone: true`): a floating ModalShell medium card,
 *   hosted fullscreen by `SelectorController.showOAuthSelector`. Handles its
 *   own SGR mouse input (chrome + body) via {@link handleInput}.
 */
export class OAuthSelectorComponent implements Component {
	#allProviders: OAuthProviderInfo[] = [];
	#filteredProviders: OAuthProviderInfo[] = [];
	#searchQuery = "";
	#selectedIndex: number = 0;
	#hoveredIndex: number | null = null;
	/** First provider index of the visible ScrollView window (last #buildBody). */
	#scrollStart = 0;
	#visibleCount = 0;
	#mode: "login" | "logout";
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
	#standalone: boolean;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#onRequestRender?: () => void;

	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		onSelect: (providerId: string) => void,
		onCancel: () => void,
		options?: {
			validateAuth?: (providerId: string) => Promise<boolean>;
			requestRender?: () => void;
			standalone?: boolean;
		},
	) {
		this.#mode = mode;
		this.#authStorage = authStorage;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#validateAuthCallback = options?.validateAuth;
		this.#requestRenderCallback = options?.requestRender;
		this.#standalone = options?.standalone ?? false;
		this.#loadProviders();
		this.#startValidation();
	}

	setOnRequestRender(cb: () => void): void {
		this.#onRequestRender = cb;
	}

	stopValidation(): void {
		this.#validationGeneration += 1;
		this.#stopSpinner();
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	#hasSelectableAuth(providerId: string): boolean {
		return this.#mode === "logout" ? this.#authStorage.has(providerId) : this.#authStorage.hasAuth(providerId);
	}

	#loadProviders(): void {
		const providers = getOAuthProviders();
		if (this.#mode === "logout") {
			// Logout stays unfiltered by `disabledProviders`: a now-disabled
			// provider may still hold stored credentials worth removing.
			this.#allProviders = providers.filter(provider => this.#hasSelectableAuth(provider.id));
		} else {
			const disabled = getDisabledProviderIds();
			// Hide a login entry when either its own id or the provider id it
			// stores credentials under is disabled, so alias logins (e.g.
			// `openai-codex-device` ⇒ `openai-codex`) disappear alongside the
			// model provider they authenticate.
			this.#allProviders = providers.filter(
				provider =>
					!disabled.has(provider.id) &&
					!(provider.storeCredentialsAs && disabled.has(provider.storeCredentialsAs)),
			);
		}
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
		return this.#allProviders.length > OAUTH_SELECTOR_MAX_VISIBLE;
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

	#setSearchQuery(query: string): void {
		this.#searchQuery = query;
		this.#filteredProviders = query.trim()
			? fuzzyFilter(this.#allProviders, query, provider => this.#getProviderSearchText(provider))
			: this.#allProviders;
		this.#selectedIndex = 0;
		this.#statusMessage = undefined;
	}

	#handleSearchInput(keyData: string): boolean {
		if (!this.#isSearchEnabled()) return false;

		if (matchesKey(keyData, "backspace")) {
			if (this.#searchQuery.length === 0) return false;
			const chars = [...this.#searchQuery];
			chars.pop();
			this.#setSearchQuery(chars.join(""));
			return true;
		}

		const printableText = extractPrintableText(keyData);
		if (printableText === undefined) return false;
		if (this.#searchQuery.length === 0 && printableText.trim().length === 0) return false;

		this.#setSearchQuery(this.#searchQuery + printableText);
		return true;
	}

	#buildBody(width: number): string[] {
		const total = this.#filteredProviders.length;
		const maxVisible = OAUTH_SELECTOR_MAX_VISIBLE;
		const startIndex =
			total <= maxVisible ? 0 : clampLow(this.#selectedIndex - Math.floor(maxVisible / 2), 0, total - maxVisible);
		const endIndex = Math.min(startIndex + maxVisible, total);
		this.#scrollStart = startIndex;
		this.#visibleCount = endIndex - startIndex;

		const rows: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const provider = this.#filteredProviders[i];
			if (!provider) continue;
			const isSelected = i === this.#selectedIndex;
			const isAvailable = provider.available;
			const statusIndicator = this.#getStatusIndicator(provider.id);

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", `${theme.nav.cursor} `);
				const text = isAvailable ? theme.fg("accent", provider.name) : theme.fg("dim", provider.name);
				line = prefix + text + statusIndicator;
			} else {
				const text = isAvailable ? `  ${provider.name}` : theme.fg("dim", `  ${provider.name}`);
				line = text + statusIndicator;
			}
			if (!isSelected && i === this.#hoveredIndex) {
				line = theme.bg("selectedBg", line);
			}
			rows.push(line);
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

		// Search status line (scrollbar covers overflow indication)
		if (this.#shouldRenderSearchStatus()) {
			body.push(this.#renderStatusLine(total));
		}

		if (total === 0) {
			const message =
				this.#allProviders.length === 0
					? this.#mode === "login"
						? "No OAuth providers available"
						: "No stored provider credentials to log out"
					: "No matching providers";
			body.push(theme.fg("muted", `  ${message}`));
		}
		if (this.#statusMessage) {
			body.push("", theme.fg("warning", `  ${this.#statusMessage}`));
		}
		return body;
	}

	handleInput(keyData: string): void {
		if (this.#standalone && keyData.startsWith("\x1b[<")) {
			routeSgrMouseInput(keyData, event => this.#routeStandaloneMouse(event));
			return;
		}

		// Escape or Ctrl+C
		if (matchesSelectCancel(keyData)) {
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
				this.#selectedIndex = Math.max(0, this.#selectedIndex - OAUTH_SELECTOR_MAX_VISIBLE);
			}
			this.#statusMessage = undefined;
		}
		// Page down - jump down by one visible page
		else if (matchesKey(keyData, "pageDown")) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex = Math.min(
					this.#filteredProviders.length - 1,
					this.#selectedIndex + OAUTH_SELECTOR_MAX_VISIBLE,
				);
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
			return;
		}
		if (!event.leftClick || target === null) return;
		if (target !== this.#selectedIndex) {
			this.#selectedIndex = target;
			this.#statusMessage = undefined;
		}
		this.#confirmSelection();
	}

	/** Standalone-only: hit-test ModalShell chrome first, then forward to {@link routeMouse}. */
	#routeStandaloneMouse(event: SgrMouseEvent): boolean {
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
			this.stopValidation();
			this.#onCancelCallback();
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "confirm") {
			this.#confirmSelection();
			return true;
		}
		const geo = this.#shellGeometry;
		if (!geo) return true;
		this.routeMouse(event, event.row - geo.bodyRowStart, event.col - (geo.leftPad + 2));
		return true;
	}

	render(width: number): readonly string[] {
		if (!this.#standalone) {
			return this.#buildBody(width);
		}

		const height = process.stdout.rows || 40;
		const sizing = withCompact(MODAL_SIZING_MEDIUM, height < 24);
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: height }, () => padding(width));
		}

		const shell = renderModalShell({
			title: this.#mode === "login" ? "Login" : "Logout",
			sizing,
			areaWidth: width,
			areaHeight: height,
			body: this.#buildBody(dims.contentWidth),
			shortcuts: SELECT_LIST_SHORTCUTS,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		return shell.lines;
	}
}
