import { type SelectItem, SelectList, Spacer, Text } from "@veyyon/tui";
import { clamp } from "@veyyon/utils";
import {
	normalizeProviderMaxInFlightRequests,
	settings,
	validateProviderMaxInFlightRequests,
} from "../../../config/settings";
import { getSelectListTheme, theme } from "../../theme/theme";
import { MouseRoutedSubmenu } from "../select-list-mouse-routing";
import { TextInputSubmenu } from "../settings-submenus";

export class ProviderLimitsSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;

	constructor(
		private readonly providers: readonly string[],
		private readonly onChange: (value: Record<string, number>) => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showProviderList();
	}

	#providerIds(): string[] {
		const limits = normalizeProviderMaxInFlightRequests(settings.get("providers.maxInFlightRequests"));
		return Array.from(new Set(this.providers.concat(Object.keys(limits)))).sort((a, b) => a.localeCompare(b));
	}

	#showProviderList(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "Max In-Flight Requests")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"Select a provider, enter a positive number to cap concurrent LLM requests, or clear it for unlimited.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const limits = normalizeProviderMaxInFlightRequests(settings.get("providers.maxInFlightRequests"));
		const providerItems = this.#providerIds().map((provider): SelectItem => {
			const limit = limits[provider];
			return {
				value: provider,
				label: provider,
				description: limit === undefined ? "Unlimited" : `Limit: ${limit}`,
			};
		});
		const clearItem: SelectItem[] =
			Object.keys(limits).length === 0
				? []
				: [{ value: "__clear_all", label: "Clear all limits", description: "Make every provider unlimited" }];
		const items = providerItems.concat(clearItem);
		this.#selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (item.value === "__clear_all") {
				settings.set("providers.maxInFlightRequests", {});
				this.onChange({});
				this.#showProviderList();
				this.requestRender?.();
				return;
			}
			this.#showProviderEditor(item.value);
		};
		this.#selectList.onCancel = this.onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to edit provider · Esc to go back"), 0, 0));
	}

	#showProviderEditor(provider: string): void {
		const limits = normalizeProviderMaxInFlightRequests(settings.get("providers.maxInFlightRequests"));
		this.clear();
		this.#selectList = undefined;
		this.addChild(
			new TextInputSubmenu(
				`Max In-Flight Requests: ${provider}`,
				"Enter a positive number. Decimals round down. Clear the field to make this provider unlimited.",
				limits[provider]?.toString() ?? "",
				value => {
					const next = { ...limits };
					const trimmed = value.trim();
					if (trimmed === "") {
						delete next[provider];
					} else {
						const limit = Number(trimmed);
						if (!Number.isFinite(limit) || limit <= 0) throw new Error("Limit must be a positive number.");
						next[provider] = Math.max(1, Math.floor(limit));
					}
					const normalized = validateProviderMaxInFlightRequests(next);
					settings.set("providers.maxInFlightRequests", normalized);
					this.onChange(normalized);
					this.#showProviderList();
					this.requestRender?.();
				},
				() => {
					this.#showProviderList();
					this.requestRender?.();
				},
			),
		);
	}

	mouseTarget(): SelectList | undefined {
		return this.#selectList;
	}

	handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}
