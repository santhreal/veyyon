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
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { AuthStorage } from "../../session/auth-storage";
import { pointerMotionEnabled } from "./modal-shell";
import { getDisabledProviderIds, OAUTH_SELECTOR_MAX_VISIBLE, ORIGIN_LABELS } from "./oauth-selector-helpers";
import { hoverBandAt, renderScrollableList } from "./selector-helpers";

export class OAuthSelectorComponent implements Component {
	#allProviders: OAuthProviderInfo[] = [];
	#filteredProviders: OAuthProviderInfo[] = [];
	#searchQuery = "";
	#searchTypedByUser = false;
	#selectedIndex: number = 0;
	#hoveredIndex: number | null = null;
	#hoverFade: HoverFade | undefined;
	#scrollStart = 0;
	#visibleCount = 0;
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
		if (this.#requestRenderCallback !== undefined) {
			const requestRender = this.#requestRenderCallback;
			this.#hoverFade = new HoverFade({ requestRender, enabled: pointerMotionEnabled() });
		}
		this.#loadProviders();
		this.#startValidation();
	}

	setMaxVisible(rows: number): void {
		this.#maxVisible = Math.max(1, Math.floor(rows));
	}

	hasActiveSearch(): boolean {
		return this.#searchQuery.length > 0 && (this.#searchTypedByUser || this.#isSearchEnabled());
	}

	stopValidation(): void {
		this.#validationGeneration += 1;
		this.#stopSpinner();
	}

	dispose(): void {
		this.stopValidation();
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoveredIndex = null;
	}

	invalidate(): void {}

	#hasSelectableAuth(providerId: string): boolean {
		return this.#authStorage.hasAuth(providerId);
	}

	#loadProviders(): void {
		const disabled = getDisabledProviderIds();
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
		let anyChecking = false;
		for (const state of this.#authState.values()) {
			if (state === "checking") {
				anyChecking = true;
				break;
			}
		}
		if (!anyChecking) {
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
							const strength = this.#hoverStrength(i);
							rows.push(strength > 0 ? hoverBandAt(line, rowWidth, strength) : truncateToWidth(line, rowWidth));
						}
						return rows;
					},
				),
			);
		}

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

		if (matchesSelectUp(keyData)) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === 0 ? this.#filteredProviders.length - 1 : this.#selectedIndex - 1;
			}
			this.#statusMessage = undefined;
		} else if (matchesSelectDown(keyData)) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === this.#filteredProviders.length - 1 ? 0 : this.#selectedIndex + 1;
			}
			this.#statusMessage = undefined;
		} else if (matchesKey(keyData, "pageUp")) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex = Math.max(0, this.#selectedIndex - this.#maxVisible);
			}
			this.#statusMessage = undefined;
		} else if (matchesKey(keyData, "pageDown")) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex = Math.min(this.#filteredProviders.length - 1, this.#selectedIndex + this.#maxVisible);
			}
			this.#statusMessage = undefined;
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#confirmSelection();
		}
	}

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

	handleWheel(delta: -1 | 1): void {
		if (this.#filteredProviders.length === 0) return;
		const next = clampLow(this.#selectedIndex + delta, 0, this.#filteredProviders.length - 1);
		if (next === this.#selectedIndex) return;
		this.#selectedIndex = next;
		this.#statusMessage = undefined;
	}

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

	#hoverStrength(index: number): number {
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(index);
		return index === this.#hoveredIndex ? 1 : 0;
	}

	render(width: number): readonly string[] {
		return this.#buildBody(width);
	}
}
