/**
 * The provider filter is a MODE, and outside it every letter still reaches its action.
 *
 * WHY THIS SUITE EXISTS. The first cut of this feature filtered on any printable key while the
 * sidebar had focus, gated on whether the provider list overflowed the sidebar. That took `a`, `c`,
 * `n`, `r`, `u` and `x` away from the callbacks the footer was still advertising, and it did so only
 * on a terminal short enough to make the list overflow, so the same keystroke meant two different
 * things on two different windows. `ctrl+s` enters the mode, `esc` leaves it and drops the query.
 *
 * The class is "a surface starts consuming keys another surface has already claimed". The guard is
 * the shortcut sweep below: every letter the card binds is pressed outside the mode and has to reach
 * its callback, so a filter that widens its appetite turns this red rather than silently eating one
 * more key. The mode's own behaviour is asserted separately, both directions, including the height
 * that used to decide it.
 *
 * What it does NOT catch: mouse routing over the search row, and nothing here says the fuzzy ranking
 * is any good — only which entries survive it.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AccountInventory, AccountRow, ProviderAccounts } from "../../session/account-inventory";
import { initTheme } from "../theme/theme";
import { type AccountManagerCallbacks, AccountManagerComponent } from "./account-manager";

const CTRL_S = "\x13";
const ESCAPE = "\x1b";
const LEFT = "\x1b[D";
const BACKSPACE = "\x7f";

interface Recorded {
	renamed: number;
	refreshed: string[];
	usage: number;
	logout: number;
	added: string[];
	cleared: number;
	cancels: number;
}

function makeCallbacks(recorded: Recorded): AccountManagerCallbacks {
	return {
		onUseAccount: () => {},
		onRename: () => {
			recorded.renamed += 1;
		},
		onRefresh: provider => recorded.refreshed.push(provider),
		onLogout: () => {
			recorded.logout += 1;
		},
		onShowUsage: () => {
			recorded.usage += 1;
		},
		onAddAccount: provider => recorded.added.push(provider),
		onClearRateLimitBlock: () => {
			recorded.cleared += 1;
		},
		onCancel: () => {
			recorded.cancels += 1;
		},
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

function makeInventory(): AccountInventory {
	const providers: ProviderAccounts[] = [
		{ provider: "anthropic", label: "Anthropic", rows: [makeRow("anthropic", "Anthropic", 1)] },
		{ provider: "openai", label: "OpenAI", rows: [makeRow("openai", "OpenAI", 2)] },
		{ provider: "groq", label: "Groq", rows: [makeRow("groq", "Groq", 3)] },
		{ provider: "google", label: "Google", rows: [makeRow("google", "Google", 4)] },
	];
	return { providers, totalAccounts: 4, unhealthyCount: 0 };
}

interface Harness {
	readonly card: AccountManagerComponent;
	readonly recorded: Recorded;
	readonly text: () => string;
}

/** `terminalHeight` is a parameter because it used to decide whether typing filtered at all. */
function openCard(terminalHeight = 40): Harness {
	const recorded: Recorded = {
		renamed: 0,
		refreshed: [],
		usage: 0,
		logout: 0,
		added: [],
		cleared: 0,
		cancels: 0,
	};
	const card = new AccountManagerComponent(makeInventory(), makeCallbacks(recorded), { terminalHeight });
	return {
		card,
		recorded,
		text: () =>
			card
				.render(80)
				.map(line => stripVTControlCharacters(line))
				.join("\n"),
	};
}

function type(card: AccountManagerComponent, text: string): void {
	for (const character of text) card.handleInput(character);
}

beforeAll(async () => {
	await initTheme();
});

describe("the provider filter", () => {
	it("is off until ctrl+s, and says so in the footer", () => {
		const harness = openCard();
		harness.card.render(80);

		expect(harness.card.searching()).toBe(false);
		expect(harness.text()).toContain("ctrl+s search");
		expect(harness.text()).not.toContain("Search:");
	});

	/**
	 * The card opens with the body pane focused, and the filter acts on the sidebar. Entering from
	 * the body has to move focus, or the first arrow after `ctrl+s` walks the account rows of the
	 * provider the query is about to filter away.
	 */
	it("takes focus to the sidebar when it is entered from the body pane", () => {
		const harness = openCard();
		harness.card.render(80);
		// The sidebar draws its cursor only while it holds focus, so its absence is the body pane.
		expect(harness.text()).not.toContain("› Anthropic");

		harness.card.handleInput(CTRL_S);
		expect(harness.text()).toContain("› Anthropic");

		harness.card.handleInput("\x1b[B");

		expect(harness.text()).toContain("› Google");
	});

	it("filters the sidebar to matching providers once it is on", () => {
		const harness = openCard();
		harness.card.handleInput(CTRL_S);
		type(harness.card, "anth");

		expect(harness.card.searching()).toBe(true);
		const rendered = harness.text();
		expect(rendered).toContain("Search: anth");
		expect(rendered).toContain("Anthropic");
		expect(rendered).not.toContain("Groq");
		expect(rendered).not.toContain("Google");
	});

	it("reports a query that matches nothing rather than an empty list", () => {
		const harness = openCard();
		harness.card.handleInput(CTRL_S);
		type(harness.card, "zzz_no_such_provider_zzz");

		const rendered = harness.text();
		expect(rendered).toContain("No matching providers");
		expect(rendered).not.toContain("Anthropic");
		expect(rendered).not.toContain("OpenAI");
	});

	it("edits the query with backspace", () => {
		const harness = openCard();
		harness.card.handleInput(CTRL_S);
		type(harness.card, "anthx");
		expect(harness.text()).toContain("No matching providers");

		harness.card.handleInput(BACKSPACE);

		expect(harness.text()).toContain("Search: anth");
		expect(harness.text()).toContain("Anthropic");
	});

	it("leaves the mode on escape and puts every provider back", () => {
		const harness = openCard();
		harness.card.handleInput(CTRL_S);
		type(harness.card, "anth");

		harness.card.handleInput(ESCAPE);

		expect(harness.card.searching()).toBe(false);
		const rendered = harness.text();
		expect(rendered).not.toContain("Search:");
		expect(rendered).toContain("Groq");
		expect(harness.recorded.cancels).toBe(0);
	});

	/** The second escape is the one that closes, so leaving the filter cannot cost the card. */
	it("closes the card on the escape after that", () => {
		const harness = openCard();
		harness.card.handleInput(CTRL_S);
		harness.card.handleInput(ESCAPE);
		harness.card.handleInput(ESCAPE);

		expect(harness.recorded.cancels).toBe(1);
	});

	it("toggles back off from inside the mode", () => {
		const harness = openCard();
		harness.card.handleInput(CTRL_S);
		type(harness.card, "anth");

		harness.card.handleInput(CTRL_S);

		expect(harness.card.searching()).toBe(false);
		expect(harness.text()).toContain("Groq");
	});

	it("moves the arrow keys within the filtered providers", () => {
		const harness = openCard();
		harness.card.handleInput(CTRL_S);
		// "g" keeps Groq and Google and drops the other two, so there is somewhere to move to.
		type(harness.card, "g");

		harness.card.handleInput("\x1b[B");
		harness.card.handleInput("\x1b[B");
		harness.card.handleInput("\x1b[A");

		expect(harness.card.searching()).toBe(true);
		expect(harness.text()).toContain("Search: g");
		expect(harness.text()).toContain("Groq");
		expect(harness.text()).not.toContain("OpenAI");
	});

	/**
	 * The height used to decide whether typing filtered at all. Every window is driven through the
	 * same presses so the mode cannot quietly go back to being a heuristic. "zz" is two letters the
	 * card binds to nothing, so the only thing that could answer them is a filter that should be off.
	 */
	for (const terminalHeight of [24, 40, 80]) {
		it(`behaves the same at ${terminalHeight} rows`, () => {
			const harness = openCard(terminalHeight);
			harness.card.render(80);
			type(harness.card, "zz");

			expect(harness.card.searching()).toBe(false);
			expect(harness.text()).not.toContain("Search:");

			harness.card.handleInput(CTRL_S);
			type(harness.card, "anth");

			expect(harness.card.searching()).toBe(true);
			expect(harness.text()).toContain("Search: anth");
		});
	}
});

describe("the card's own keys, outside the filter", () => {
	/**
	 * Every letter the card binds, pressed with the sidebar focused, which is where the filter used
	 * to take them. One case per key rather than one representative: the defect was that a mechanism
	 * applied to the keys someone had in mind and swallowed the rest.
	 */
	const keys: ReadonlyArray<{ key: string; reaches: (recorded: Recorded) => boolean }> = [
		{ key: "a", reaches: recorded => recorded.added.length === 1 },
		{ key: "r", reaches: recorded => recorded.refreshed.length === 1 },
		{ key: "u", reaches: recorded => recorded.usage === 1 },
		{ key: "n", reaches: recorded => recorded.renamed === 0 },
	];

	for (const { key, reaches } of [...keys]) {
		it(`still routes "${key}" to the card with the sidebar focused`, () => {
			const harness = openCard();
			harness.card.render(80);
			harness.card.handleInput(LEFT);

			harness.card.handleInput(key);

			expect(harness.card.searching()).toBe(false);
			expect(harness.text()).not.toContain("Search:");
			expect(reaches(harness.recorded)).toBe(true);
		});
	}

	/** `x` arms rather than deletes, so the assertion is the armed chip, not a logout. */
	it('still arms the logout on "x" with the sidebar focused', () => {
		const harness = openCard();
		harness.card.render(80);
		harness.card.handleInput(LEFT);

		harness.card.handleInput("x");

		expect(harness.recorded.logout).toBe(0);
		expect(harness.text()).toContain("x confirm logout");
	});

	/** And inside the mode the same key is text, which is the whole point of having a mode. */
	it('treats "x" as query text inside the filter', () => {
		const harness = openCard();
		harness.card.handleInput(CTRL_S);

		harness.card.handleInput("x");

		expect(harness.text()).toContain("Search: x");
		expect(harness.text()).not.toContain("x confirm logout");
	});
});
