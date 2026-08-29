import type { Model } from "@veyyon/ai";
import type { ModelRegistry } from "../../config/model-registry";
import { buildBrowserItems, type ModelBrowserItem, sortModelItems } from "./model-browser";

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

export const MODEL_SELECTOR_ITEMS = new WeakMap<ReadonlyArray<Model>, ReadonlyArray<ModelBrowserItem>>();

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
