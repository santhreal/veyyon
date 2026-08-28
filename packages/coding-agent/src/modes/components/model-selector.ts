import type { Model } from "@veyyon/ai";
import {
	type Component,
	Container,
	type HoverFadeOptions,
	matchesKey,
	type SgrMouseEvent,
	Spacer,
	Text,
	truncateToWidth,
} from "@veyyon/tui";
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
import { renderTrackingChild } from "./select-list-mouse-routing";

export type ModelAuthStatus = "authenticated" | "unauthenticated" | "keyless";

export interface ModelSelectorOptions {
	title: string;
	description?: string;
	currentSelector?: string;
	allowClear?: boolean;
	clearLabel?: string;
	currentContextTokens?: number;
}

export interface ModelSelectorCallbacks {
	onPick: (model: Model, selector: string) => void;
	onClear?: () => void;
	onCancel: () => void;
}

export function resolveModelAuthStatus(registry: ModelRegistry, model: Model): ModelAuthStatus {
	if (registry.isKeylessProvider(model.provider) && !registry.authStorage.hasAuth(model.provider)) {
		return "keyless";
	}
	if (registry.hasConfiguredAuth(model)) return "authenticated";
	return "unauthenticated";
}

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

const MODEL_SELECTOR_ITEMS = new WeakMap<ReadonlyArray<Model>, ReadonlyArray<ModelBrowserItem>>();

export function cachedAuthAwareBrowserItems(models: ReadonlyArray<Model>, registry: ModelRegistry): ModelBrowserItem[] {
	let cached = MODEL_SELECTOR_ITEMS.get(models);
	if (!cached) {
		const built = buildBrowserItems(models);
		sortModelItems(built, {});
		cached = built;
		MODEL_SELECTOR_ITEMS.set(models, cached);
	}
	return cached.map(item => {
		const row = { ...item };
		const status = resolveModelAuthStatus(registry, row.model);
		const badge = formatModelAuthBadge(status);
		row.badge = badge.text;
		row.badgeColor = badge.color;
		if (status === "unauthenticated") row.labelColor = "warning";
		return row;
	});
}

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

		const items = cachedAuthAwareBrowserItems(models, registry);
		if (this.#allowClear) {
			const label = options.clearLabel ?? "(inherit main model)";
			const detailState = label.startsWith("(") && label.endsWith(")") ? label.slice(1, -1) : label;
			items.unshift(buildInheritRow(label, `Clear the assignment — ${detailState}.`));
		}
		this.#browser.setItems(items);
		if (options.currentSelector) {
			this.#browser.setCurrentSelector(options.currentSelector);
			this.#browser.selectSelector(options.currentSelector);
		} else if (this.#allowClear) {
			this.#browser.setCurrentSelector(INHERIT_ROW_SELECTOR);
		}

		this.#browser.onActivate = item => {
			if (item.selector === INHERIT_ROW_SELECTOR) {
				this.#onClear?.();
				return;
			}
			callbacks.onPick(item.model, item.selector);
		};
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

	#browserLineOffset = 0;

	render(width: number): string[] {
		const { lines, trackedLineOffset } = renderTrackingChild(this, this.#browser as unknown as Component, width);
		this.#browserLineOffset = trackedLineOffset;
		if (lines.length > 0) {
			lines[lines.length - 1] = truncateToWidth(lines[lines.length - 1] ?? "", width);
		}
		return lines;
	}

	setHoverMotion(options: HoverFadeOptions): void {
		this.#browser.setHoverMotion(options);
	}

	dispose(): void {
		this.#browser.disposeHoverMotion();
		super.dispose();
	}

	routeMouse(event: SgrMouseEvent, line: number): void {
		this.#browser.routeMouse(event, line - this.#browserLineOffset);
	}
}
