/**
 * The provider picker signs IN, and that is the only thing it does.
 *
 * It used to carry a `logout` mode that filtered the list to providers holding a stored credential.
 * Logging out is choosing an ACCOUNT rather than a provider, so the account card owns it now, one
 * row per credential: `test/modes/controllers/selector-controller-logout.test.ts` drives `/logout`
 * end to end there, including the case this file used to cover with "keeps disabled providers as
 * logout targets" (a disabled provider's stored credential stays reachable).
 *
 * What remains here is the login list: fuzzy search over an overflowing list, and the two ways a
 * disabled provider disappears from it (its own id, or the id it stores credentials under).
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getOAuthProviders } from "@veyyon/ai/oauth";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { OAuthSelectorComponent } from "@veyyon/coding-agent/modes/components/oauth-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";

beforeAll(async () => {
	await initTheme();
});

const authStorage = {
	has: (_providerId: string) => false,
	hasAuth: (_providerId: string) => false,
	getCredentialOrigin: (_providerId: string) => undefined,
} as unknown as AuthStorage;

describe("OAuthSelectorComponent", () => {
	it("fuzzy-filters overflowing provider lists from typed input", () => {
		const providers = getOAuthProviders();
		expect(providers.length).toBeGreaterThan(10);
		const target =
			providers.find(provider => provider.available && provider.id === "vllm") ??
			providers.find(provider => provider.available) ??
			providers[0];
		expect(target).toBeDefined();
		if (!target) return;

		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			authStorage,
			providerId => selected.push(providerId),
			() => {},
		);

		for (const char of target.id) {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain(target.name);
		expect(rendered).toContain(`Search: ${target.id}`);

		component.handleInput("\n");
		expect(selected).toEqual([target.id]);
	});

	describe("disabledProviders", () => {
		afterEach(() => {
			resetSettingsForTest();
		});

		it("hides disabled providers from the login list even when searched", async () => {
			const providers = getOAuthProviders();
			const victim =
				providers.find(provider => provider.available && provider.id === "vllm") ??
				providers.find(provider => provider.available) ??
				providers[0];
			expect(victim).toBeDefined();
			if (!victim) return;

			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: [victim.id] } });

			const component = new OAuthSelectorComponent(
				authStorage,
				() => {},
				() => {},
			);
			for (const char of victim.id) {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).not.toContain(victim.name);
		});

		it("hides alias logins whose storeCredentialsAs target is disabled", async () => {
			const alias = getOAuthProviders().find(provider => provider.storeCredentialsAs === "openai-codex");
			expect(alias).toBeDefined();
			if (!alias) return;
			expect(alias.id).not.toBe("openai-codex");

			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: ["openai-codex"] } });

			const component = new OAuthSelectorComponent(
				authStorage,
				() => {},
				() => {},
			);
			for (const char of alias.id) {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).not.toContain(alias.name);
		});
	});
});
