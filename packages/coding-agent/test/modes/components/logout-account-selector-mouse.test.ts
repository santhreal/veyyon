/**
 * The `/logout` account picker answers to the mouse in its list, not only in its chrome.
 *
 * The card is hosted as a fullscreen overlay, which is what enables SGR mouse tracking, and it
 * routed only the close glyph, the click-outside and the two footer chips. Clicking an account in
 * the list did nothing, and the wheel did nothing, on a card whose entire content is a scrollable
 * list of accounts.
 *
 * Coordinates are read out of the rendered frame rather than hardcoded: the card floats, so a
 * fixed row would pin the layout instead of the routing.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { LogoutAccountSelectorComponent } from "@veyyon/coding-agent/modes/components/logout-account-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { LogoutAccount } from "@veyyon/coding-agent/slash-commands/helpers/logout";

beforeAll(async () => {
	await initTheme();
});

const ACCOUNTS: readonly LogoutAccount[] = [
	{
		credentialId: 11,
		provider: "anthropic",
		label: "alpha@example.com",
		detail: "oauth",
		type: "oauth",
		active: true,
	},
	{
		credentialId: 12,
		provider: "anthropic",
		label: "bravo@example.com",
		detail: "oauth",
		type: "oauth",
		active: false,
	},
	{
		credentialId: 13,
		provider: "anthropic",
		label: "charlie@example.com",
		detail: "oauth",
		type: "oauth",
		active: false,
	},
];

function harness() {
	const chosen: number[] = [];
	const component = new LogoutAccountSelectorComponent(
		"Anthropic",
		ACCOUNTS.map(account => ({ ...account })),
		account => chosen.push(account.credentialId),
		() => {},
	);
	const frame = (): string[] => component.render(100).map(line => Bun.stripANSI(line));
	const cellOf = (needle: string): { row: number; col: number } => {
		const lines = frame();
		const row = lines.findIndex(line => line.includes(needle));
		if (row < 0) throw new Error(`no line contains ${JSON.stringify(needle)}`);
		return { row, col: (lines[row] ?? "").indexOf(needle) };
	};
	const send = (button: number, needle: string): void => {
		const { row, col } = cellOf(needle);
		component.handleInput(`\x1b[<${button};${col + 1};${row + 1}M`);
	};
	return {
		component,
		chosen,
		frame,
		click: (needle: string) => send(0, needle),
		wheelDown: (needle: string) => send(65, needle),
	};
}

/** The account the cursor glyph sits on. */
function cursorAccount(lines: readonly string[]): string {
	const rows = lines.filter(line => line.includes("›"));
	if (rows.length !== 1) throw new Error(`expected one cursor row, found ${rows.length}`);
	return (rows[0] ?? "").trim();
}

describe("clicking and scrolling the logout account list", () => {
	/**
	 * THE DEFECT. The list is the whole point of this card and it ignored clicks, so the operator
	 * had to arrow to an account they were already pointing at.
	 */
	test("a click on an account row moves the cursor to it", () => {
		const { click, frame } = harness();
		expect(cursorAccount(frame())).toContain("alpha@example.com");

		click("charlie@example.com");

		expect(cursorAccount(frame())).toContain("charlie@example.com");
	});

	/**
	 * A click SELECTS and stops. Removing a credential cannot be undone from this card, and the
	 * house convention for a modal list (`SelectList.clickItem`) is click-to-activate, so wiring
	 * this one the same way would turn one stray click into a destroyed login. The confirm stays
	 * the separate, deliberate step the footer names.
	 */
	test("a click never logs out on its own", () => {
		const { click, chosen, component } = harness();

		click("bravo@example.com");
		expect(chosen).toEqual([]);

		component.handleInput("\n");
		expect(chosen).toEqual([12]);
	});

	/**
	 * The wheel over a scrollable list has to move something. This card derives its visible window
	 * from the selected index on every paint, so the wheel steps the SELECTION; a private scroll
	 * offset would be recomputed away by the next frame and the pane would read as swallowing the
	 * wheel entirely.
	 */
	test("the wheel steps the selection through the list", () => {
		const { wheelDown, frame, component, chosen } = harness();

		wheelDown("alpha@example.com");

		expect(cursorAccount(frame())).toContain("bravo@example.com");
		component.handleInput("\n");
		expect(chosen).toEqual([12]);
	});
});
