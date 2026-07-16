/**
 * Reusable searchable model selector with auth status on each row.
 *
 * Used by settings (roles / subagent.model / compaction.model) and any other
 * surface that needs "pick a model from the catalog" without reimplementing
 * search, auth badges, or clear/unset.
 */
import type { Model } from "@veyyon/pi-ai";
import { type Component, Container, matchesKey, Spacer, Text, truncateToWidth } from "@veyyon/pi-tui";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { theme } from "../theme/theme";
import { buildBrowserItems, ModelBrowser, type ModelBrowserItem, sortModelItems } from "./model-browser";

/** Auth posture shown next to a model id in the selector. */
export type ModelAuthStatus = "authenticated" | "unauthenticated" | "keyless";

export interface ModelSelectorOptions {
	/** Overlay / submenu title (accent heading). */
	title: string;
	/** Short muted description under the title. */
	description?: string;
	/** Currently assigned selector (`provider/id`), highlighted as current. */
	currentSelector?: string;
	/** When true, Del/Backspace with an empty search clears the assignment. */
	allowClear?: boolean;
	/** Optional session context size for over-limit dimming. */
	currentContextTokens?: number;
}

export interface ModelSelectorCallbacks {
	onPick: (model: Model, selector: string) => void;
	onClear?: () => void;
	onCancel: () => void;
}

/** Resolve whether a model can be used without further login. */
export function resolveModelAuthStatus(registry: ModelRegistry, model: Model): ModelAuthStatus {
	if (registry.isKeylessProvider(model.provider) && !registry.authStorage.hasAuth(model.provider)) {
		return "keyless";
	}
	if (registry.hasConfiguredAuth(model)) return "authenticated";
	return "unauthenticated";
}

/** Human badge for a {@link ModelAuthStatus}. */
export function formatModelAuthBadge(status: ModelAuthStatus): {
	text: string;
	color: "success" | "warning" | "dim";
} {
	switch (status) {
		case "authenticated":
			return { text: "auth", color: "success" };
		case "keyless":
			return { text: "local", color: "dim" };
		case "unauthenticated":
			return { text: "no auth", color: "warning" };
	}
}

/**
 * Build browser rows with auth badges. Shared by settings and any host that
 * needs the same catalog + auth chrome.
 */
export function buildAuthAwareBrowserItems(models: ReadonlyArray<Model>, registry: ModelRegistry): ModelBrowserItem[] {
	const items = buildBrowserItems(models);
	for (const item of items) {
		const status = resolveModelAuthStatus(registry, item.model);
		const badge = formatModelAuthBadge(status);
		item.badge = badge.text;
		item.badgeColor = badge.color;
		if (status === "unauthenticated") {
			item.labelColor = "warning";
		}
	}
	return items;
}

/**
 * Host panel: title + searchable {@link ModelBrowser} with auth badges.
 * Embed this in settings submenus, overlays, or any other TUI surface.
 */
export class ModelSelectorPanel extends Container {
	#browser: ModelBrowser;
	#allowClear: boolean;
	#onClear?: () => void;
	#onCancel: () => void;

	constructor(
		settings: Settings,
		registry: ModelRegistry,
		models: ReadonlyArray<Model>,
		options: ModelSelectorOptions,
		callbacks: ModelSelectorCallbacks,
	) {
		super();
		this.#allowClear = options.allowClear === true;
		this.#onClear = callbacks.onClear;
		this.#onCancel = callbacks.onCancel;

		this.addChild(new Text(theme.bold(theme.fg("accent", options.title)), 0, 0));
		if (options.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", options.description), 0, 0));
		}
		this.addChild(new Spacer(1));

		this.#browser = new ModelBrowser(settings, {
			showProvider: true,
			currentContextTokens: options.currentContextTokens,
			disableOverContext: false,
			emptyText: () => "No models available — configure a provider or /login",
		});
		this.#browser.setCurrentSelector(options.currentSelector);

		const items = buildAuthAwareBrowserItems(models, registry);
		sortModelItems(items, {});
		this.#browser.setItems(items);

		this.#browser.onActivate = item => {
			callbacks.onPick(item.model, item.selector);
		};
		this.#browser.onCancel = () => callbacks.onCancel();

		this.addChild(this.#browser as unknown as Component);
		this.addChild(new Spacer(1));
		const clearHint = this.#allowClear ? " · Del clear" : "";
		this.addChild(new Text(theme.fg("dim", `  type to search · ↑/↓ · Enter select${clearHint} · Esc back`), 0, 0));
	}

	handleInput(data: string): void {
		if (this.#allowClear && this.#browser.query.length === 0 && matchesKey(data, "delete")) {
			this.#onClear?.();
			return;
		}
		this.#browser.handleInput(data);
	}

	render(width: number): string[] {
		const lines = [...super.render(width)];
		if (lines.length > 0) {
			lines[lines.length - 1] = truncateToWidth(lines[lines.length - 1] ?? "", width);
		}
		return lines;
	}
}
