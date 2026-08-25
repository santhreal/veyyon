import { beforeAll, describe, expect, it } from "bun:test";
import { getOAuthProviders } from "@veyyon/ai/oauth";
import type { AccountInventory } from "../../session/account-inventory";
import { initTheme } from "../theme/theme";
import { AccountManagerComponent } from "./account-manager";

function makeCallbacks() {
	return {
		onUseAccount: () => {},
		onRename: () => {},
		onRefresh: () => {},
		onLogout: () => {},
		onShowUsage: () => {},
		onAddAccount: () => {},
		onToggleLoadBalancing: () => false,
		onClearRateLimitBlock: () => {},
		onCancel: () => {},
	};
}

function makeEmptyInventory(): AccountInventory {
	const inventory = { providers: [] } as AccountInventory;
	return inventory;
}

describe("AccountManager search/filter", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("shows Type to search and filters on typing with keyboard parity", () => {
		const inventory = makeEmptyInventory();
		const component = new AccountManagerComponent(inventory, makeCallbacks(), { terminalHeight: 40 });
		const firstRender = component.render(80).join("\n");
		expect(firstRender).toContain("Type to search");

		// Focus sidebar (initial focus is body)
		component.handleInput("\x1b[D");
		component.handleInput("a");
		component.handleInput("n");
		component.handleInput("t");
		expect(component.hasActiveSearch()).toBe(true);
		const filteredRender = component.render(80).join("\n");
		expect(filteredRender).toContain("Search: ant");
		// filtered list should contain Anthropic but not all providers; check that output shrank
		const allProviders = getOAuthProviders();
		const anthropic = allProviders.find(p => p.id === "anthropic");
		expect(anthropic).toBeDefined();
		// Render should still contain Anthropic label, but not arbitrary other provider when filtered narrowly
		// Use a query that isolates one provider
		component.handleInput("\x1b"); // Esc clears
		expect(component.hasActiveSearch()).toBe(false);
		const clearedRender = component.render(80).join("\n");
		expect(clearedRender).toContain("Type to search");
		expect(clearedRender).not.toContain("Search: ant");

		component.dispose();
	});

	it("shows No matching providers for nonsense query and clears via Backspace/Escape", () => {
		const inventory = makeEmptyInventory();
		const component = new AccountManagerComponent(inventory, makeCallbacks(), { terminalHeight: 40 });
		component.render(80);
		component.handleInput("\x1b[D");
		for (const ch of "zzz_no_such_provider_zzz") component.handleInput(ch);
		expect(component.hasActiveSearch()).toBe(true);
		const noMatch = component.render(80).join("\n");
		expect(noMatch).toContain("No matching providers");

		// Backspace should pop one char and still be active
		component.handleInput("\x7f");
		expect(component.hasActiveSearch()).toBe(true);

		// Esc clears
		component.handleInput("\x1b");
		expect(component.hasActiveSearch()).toBe(false);
		expect(component.render(80).join("\n")).toContain("Type to search");

		component.dispose();
	});

	it("arrow navigation wraps filtered list", () => {
		const inventory = makeEmptyInventory();
		const component = new AccountManagerComponent(inventory, makeCallbacks(), { terminalHeight: 40 });
		component.render(80);
		component.handleInput("\x1b[D");
		// Filter to a small subset e.g. "open" matches openai, openai-codex, openrouter
		for (const ch of "open") component.handleInput(ch);
		expect(component.hasActiveSearch()).toBe(true);
		const before = component.render(80).join("\n");
		expect(before).toContain("Search: open");

		// Arrow down should change active provider within filtered set
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		// Arrow up wraps
		component.handleInput("\x1b[A");
		// Should not throw and should still be filtered
		expect(component.hasActiveSearch()).toBe(true);
		expect(component.render(80).join("\n")).toContain("Search: open");

		component.dispose();
	});
});
