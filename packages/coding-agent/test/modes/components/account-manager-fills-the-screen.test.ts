/**
 * The card returns exactly as many rows as the screen has.
 *
 * The host mounts this component with `ui.showOverlay(manager, { anchor: "bottom-center",
 * maxHeight: "100%", fullscreen: true })`, which is how a view claims the terminal's alternate
 * screen. A frame TALLER than the terminal is clipped by that overlay, and because this one is
 * bottom-anchored the clip comes off the top: the title row and the `[x]` disappear, and every
 * row recorded in the card's own geometry is then off by the clipped amount, so the close glyph
 * and the footer chips answer to clicks several rows away from where they are painted.
 *
 * The card used to floor its height at 16 rows, so any terminal shorter than that got exactly
 * this. `computeModalDims` already refuses a screen too small to draw a card on, so the floor was
 * standing in for a case that was already handled.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { AccountManagerComponent } from "@veyyon/coding-agent/modes/components/account-manager";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { AccountInventory } from "@veyyon/coding-agent/session/account-inventory";

beforeAll(async () => {
	await initTheme();
});

const INVENTORY: AccountInventory = {
	providers: [
		{
			provider: "anthropic",
			label: "Anthropic",
			rows: [
				{
					provider: "anthropic",
					providerLabel: "Anthropic",
					credentialId: 1,
					type: "oauth",
					origin: { kind: "oauth" },
					usage: [],
					activeForSession: true,
					selectedForProvider: false,
					name: "work",
				},
			],
		},
	],
	totalAccounts: 1,
	unhealthyCount: 0,
};

function card(terminalHeight: number): readonly string[] {
	const component = new AccountManagerComponent(
		INVENTORY,
		{
			onUseAccount: () => {},
			onRename: () => {},
			onRefresh: () => {},
			onLogout: () => {},
			onShowUsage: () => {},
			onAddAccount: () => {},
			onToggleLoadBalancing: () => false,
			onCancel: () => {},
		},
		{ terminalHeight },
	);
	return component.render(100);
}

describe("the account manager sizes its frame to the screen it is given", () => {
	/**
	 * A 13-row terminal is an ordinary split pane, and it is below the floor the card used to
	 * impose. The heights either side of that floor are checked together so a future minimum
	 * cannot be reintroduced for "just the small case".
	 */
	test.each([12, 13, 15, 16, 24, 40, 60])("gives a %i-row terminal exactly that many rows", height => {
		expect(card(height)).toHaveLength(height);
	});

	/**
	 * Sizing down must still draw a CARD, not a screen of blank padding. The honest-height fix
	 * would be worthless if the short-terminal path fell through to the "too small to paint"
	 * branch, so the operator has to still see the title and the account.
	 */
	test("still paints a usable card on a short terminal", () => {
		const lines = card(14)
			.map(line => Bun.stripANSI(line))
			.join("\n");

		expect(lines).toContain("Accounts");
		expect(lines).toContain("work");
	});
});
