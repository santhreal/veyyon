/**
 * Reusable searchable model selector with auth status on each row.
 *
 * Used by settings (roles / subagent.model / compaction.model) and any other
 * surface that needs "pick a model from the catalog" without reimplementing
 * search, auth badges, or clear/unset.
 */
import type { Model } from "@veyyon/ai";
import { type Component, Container, matchesKey, Spacer, Text, truncateToWidth } from "@veyyon/tui";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { theme } from "../theme/theme";
import {
	buildBrowserItems,
	buildInheritRow,
	INHERIT_ROW_SELECTOR,
	ModelBrowser,
	type ModelBrowserItem,
	sortModelItems,
} from "./model-browser";

/** Auth posture shown next to a model id in the selector. */
export type ModelAuthStatus = "authenticated" | "unauthenticated" | "keyless";

export interface ModelSelectorOptions {
	/** Overlay / submenu title (accent heading). */
	title: string;
	/** Short muted description under the title. */
	description?: string;
	/** Currently assigned selector (`provider/id`), highlighted as current. */
	currentSelector?: string;
	/**
	 * When true, the slot can return to its unset state: a pinned
	 * {@link INHERIT_ROW_SELECTOR} row leads the list, and Del/Backspace with
	 * an empty search clears the assignment. Both paths fire `onClear`.
	 */
	allowClear?: boolean;
	/** Label of the pinned clear row, e.g. `(inherit main model)`. Defaults to it. */
	clearLabel?: string;
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

		const items = buildAuthAwareBrowserItems(models, registry);
		sortModelItems(items, {});
		if (this.#allowClear) {
			// The way back to unset is a visible first-class row, not only a key.
			const label = options.clearLabel ?? "(inherit main model)";
			const detailState = label.startsWith("(") && label.endsWith(")") ? label.slice(1, -1) : label;
			items.unshift(buildInheritRow(label, `Clear the assignment — ${detailState}.`));
		}
		this.#browser.setItems(items);
		if (options.currentSelector) {
			this.#browser.setCurrentSelector(options.currentSelector);
			// Open with the assigned model selected, so a quick Enter re-picks it
			// instead of landing on the pinned clear row.
			this.#browser.selectSelector(options.currentSelector);
		} else if (this.#allowClear) {
			// Unset slot: the inherit row IS the current value, so it wears the mark.
			this.#browser.setCurrentSelector(INHERIT_ROW_SELECTOR);
		}

		this.#browser.onActivate = item => {
			if (item.selector === INHERIT_ROW_SELECTOR) {
				this.#onClear?.();
				return;
			}
			callbacks.onPick(item.model, item.selector);
		};
		// Through the field, like `#onClear` above. Reading `callbacks.onCancel`
		// straight from the closure left `#onCancel` assigned and never read, so the
		// two neighbouring callbacks looked identical while only one was live: a
		// later edit reassigning `#onCancel` would have changed nothing.
		this.#browser.onCancel = () => this.#onCancel();

		this.addChild(this.#browser as unknown as Component);
		this.addChild(new Spacer(1));
		const clearHint = this.#allowClear ? " · Del or (inherit) clears" : "";
		this.addChild(new Text(theme.fg("dim", `  type to search · ↑/↓ · Enter select${clearHint} · Esc back`), 0, 0));
	}

	handleInput(data: string): void {
		if (
			this.#allowClear &&
			this.#browser.query.length === 0 &&
			(matchesKey(data, "delete") || matchesKey(data, "backspace"))
		) {
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
