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
		// Distinct id vs label: id contains "codex", label "Codex" — proves filter hits id+label
		{ provider: "openai-codex", label: "Codex", rows: [makeRow("openai-codex", "Codex", 3)] },
		{ provider: "groq", label: "Groq", rows: [makeRow("groq", "Groq", 4)] },
		{ provider: "google", label: "Google", rows: [makeRow("google", "Google", 5)] },
		// Id holds "xyz" not present in label "CustomAlpha" — proves id-only match
		{ provider: "custom-id-xyz", label: "CustomAlpha", rows: [makeRow("custom-id-xyz", "CustomAlpha", 6)] },
	];
	return { providers, totalAccounts: 6, unhealthyCount: 0 };
}

describe("AccountManager search/filter", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("shows Type to search and filters to matching providers only", () => {
		const inventory = makeSeededInventory();
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
		expect(filteredRender).not.toContain("Codex");
		expect(filteredRender).not.toContain("CustomAlpha");

		component.handleInput("\x1b");
		expect(component.hasActiveSearch()).toBe(false);
		const clearedRender = component.render(80).join("\n");
		expect(clearedRender).toContain("Type to search");
		expect(clearedRender).not.toContain("Search: anth");

		component.dispose();
	});

	it("filters by provider id when label does not contain query", () => {
		const inventory = makeSeededInventory();
		const component = new AccountManagerComponent(inventory, makeCallbacks(), { terminalHeight: 40 });
		component.render(80);
		component.handleInput("\x1b[D");
		for (const ch of "xyz") component.handleInput(ch);
		expect(component.hasActiveSearch()).toBe(true);
		const filtered = component.render(80).join("\n");
		expect(filtered).toContain("Search: xyz");
		expect(filtered).toContain("CustomAlpha");
		expect(filtered).not.toContain("Anthropic");
		expect(filtered).not.toContain("OpenAI");
		expect(filtered).not.toContain("Codex");
		// Backspace stepwise still filters
		component.handleInput("\x7f");
		expect(component.hasActiveSearch()).toBe(true);
		expect(component.render(80).join("\n")).toContain("Search: xy");
		expect(component.render(80).join("\n")).toContain("CustomAlpha");
		component.handleInput("\x1b");
		expect(component.hasActiveSearch()).toBe(false);
		component.dispose();
	});

	it("shows No matching providers and hides all provider rows when nothing matches", () => {
		const inventory = makeSeededInventory();
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
		expect(noMatch).not.toContain("Codex");
		expect(noMatch).not.toContain("CustomAlpha");

		component.handleInput("\x7f");
		expect(component.hasActiveSearch()).toBe(true);

		component.handleInput("\x1b");
		expect(component.hasActiveSearch()).toBe(false);
		expect(component.render(80).join("\n")).toContain("Type to search");

		component.dispose();
	});

	it("arrow navigation stays within filtered providers and wraps", () => {
		const inventory = makeSeededInventory();
		const component = new AccountManagerComponent(inventory, makeCallbacks(), { terminalHeight: 40 });
		component.render(80);
		component.handleInput("\x1b[D");
		// "open" matches exactly 2 providers: OpenAI and Codex (openai-codex)
		for (const ch of "open") component.handleInput(ch);
		expect(component.hasActiveSearch()).toBe(true);
		const before = component.render(80).join("\n");
		expect(before).toContain("Search: open");
		expect(before).toContain("OpenAI");
		expect(before).toContain("Codex");
		expect(before).not.toContain("Anthropic");
		expect(before).not.toContain("Groq");
		expect(before).not.toContain("CustomAlpha");

		// Down moves within filtered set, never leaks unfiltered provider
		component.handleInput("\x1b[B");
		let afterDown = component.render(80).join("\n");
		expect(afterDown).toContain("Search: open");
		expect(afterDown).toContain("OpenAI");
		expect(afterDown).toContain("Codex");
		expect(afterDown).not.toContain("Anthropic");
		expect(afterDown).not.toContain("CustomAlpha");

		component.handleInput("\x1b[B");
		afterDown = component.render(80).join("\n");
		expect(afterDown).toContain("Search: open");
		expect(afterDown).toContain("OpenAI");
		expect(afterDown).toContain("Codex");
		expect(afterDown).not.toContain("Anthropic");

		component.handleInput("\x1b[A");
		const afterUp = component.render(80).join("\n");
		expect(afterUp).toContain("Search: open");
		expect(afterUp).toContain("OpenAI");
		expect(afterUp).toContain("Codex");
		expect(afterUp).not.toContain("Anthropic");

		component.dispose();
	});
});
