import { beforeAll, describe, expect, it } from "bun:test";
import type { AccountInventory, AccountRow, ProviderAccounts } from "../../session/account-inventory";
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

function makeRow(provider: string, label: string, credentialId: number): AccountRow {
	return {
		provider,
		providerLabel: label,
		credentialId,
		type: "api_key",
		usage: [],
		activeForSession: false,
		activeIsPrediction: false,
		selectedForProvider: false,
	};
}

function makeSeededInventory(): AccountInventory {
	const providers: ProviderAccounts[] = [
		{ provider: "anthropic", label: "Anthropic", rows: [makeRow("anthropic", "Anthropic", 1)] },
		{ provider: "openai", label: "OpenAI", rows: [makeRow("openai", "OpenAI", 2)] },
		{ provider: "groq", label: "Groq", rows: [makeRow("groq", "Groq", 3)] },
		{ provider: "google", label: "Google", rows: [makeRow("google", "Google", 4)] },
	];
	return { providers, totalAccounts: 4, unhealthyCount: 0 };
}
function makeEmptyInventory(): AccountInventory {
	return makeSeededInventory();
}
describe("AccountManager search/filter", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("shows Type to search and filters to matching providers only", () => {
		const inventory = makeEmptyInventory();
		const component = new AccountManagerComponent(inventory, makeCallbacks(), { terminalHeight: 40 });
		const firstRender = component.render(80).join("\n");
		expect(firstRender).toContain("Type to search");

		component.handleInput("\x1b[D");
		for (const ch of "anth") component.handleInput(ch);
		expect(component.hasActiveSearch()).toBe(true);
		const filteredRender = component.render(80).join("\n");
		expect(filteredRender).toContain("Search: anth");
		expect(filteredRender).toContain("Anthropic");
		expect(filteredRender).not.toContain("Groq");
		expect(filteredRender).not.toContain("Google");

		component.handleInput("\x1b");
		expect(component.hasActiveSearch()).toBe(false);
		const clearedRender = component.render(80).join("\n");
		expect(clearedRender).toContain("Type to search");
		expect(clearedRender).not.toContain("Search: anth");

		component.dispose();
	});

	it("shows No matching providers and hides all provider rows when nothing matches", () => {
		const inventory = makeEmptyInventory();
		const component = new AccountManagerComponent(inventory, makeCallbacks(), { terminalHeight: 40 });
		component.render(80);
		component.handleInput("\x1b[D");
		for (const ch of "zzz_no_such_provider_zzz") component.handleInput(ch);
		expect(component.hasActiveSearch()).toBe(true);
		const noMatch = component.render(80).join("\n");
		expect(noMatch).toContain("No matching providers");
		expect(noMatch).not.toContain("Anthropic");
		expect(noMatch).not.toContain("Groq");
		expect(noMatch).not.toContain("OpenAI");

		component.handleInput("\x7f");
		expect(component.hasActiveSearch()).toBe(true);

		component.handleInput("\x1b");
		expect(component.hasActiveSearch()).toBe(false);
		expect(component.render(80).join("\n")).toContain("Type to search");

		component.dispose();
	});

	it("arrow navigation stays within filtered providers", () => {
		const inventory = makeEmptyInventory();
		const component = new AccountManagerComponent(inventory, makeCallbacks(), { terminalHeight: 40 });
		component.render(80);
		component.handleInput("\x1b[D");
		for (const ch of "open") component.handleInput(ch);
		expect(component.hasActiveSearch()).toBe(true);
		const before = component.render(80).join("\n");
		expect(before).toContain("Search: open");
		expect(before).toContain("OpenAI");
		expect(before).not.toContain("Anthropic");

		component.handleInput("\x1b[B");
		let afterDown = component.render(80).join("\n");
		expect(afterDown).toContain("Search: open");
		expect(afterDown).not.toContain("Anthropic");
		expect(afterDown).toContain("OpenAI");

		component.handleInput("\x1b[B");
		afterDown = component.render(80).join("\n");
		expect(afterDown).not.toContain("Anthropic");

		component.handleInput("\x1b[A");
		const afterUp = component.render(80).join("\n");
		expect(afterUp).toContain("Search: open");
		expect(afterUp).not.toContain("Anthropic");

		component.dispose();
	});
});
