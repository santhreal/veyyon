/**
 * The `+ add another …` entry is a LIST POSITION, not a caption.
 *
 * The card used to keep it outside the navigation order: the cursor cycled through the accounts
 * and wrapped from the last one straight back to the first, so the only way to reach "add an
 * account" was to already know that `a` did it. A row you can see, that the card draws in the
 * same column as the accounts above it, and that the arrow keys refuse to visit, teaches the
 * operator that the list ends where it does not.
 *
 * Every test here drives the real component through `handleInput` and reads the cursor off the
 * rendered card, because "the cursor is on the add entry" is the whole claim.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	type AccountManagerCallbacks,
	AccountManagerComponent,
} from "@veyyon/coding-agent/modes/components/account-manager";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { AccountInventory, AccountRow } from "@veyyon/coding-agent/session/account-inventory";

beforeAll(async () => {
	await initTheme();
});

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";

function account(credentialId: number, name: string): AccountRow {
	return {
		provider: "anthropic",
		providerLabel: "Anthropic",
		credentialId,
		type: "oauth",
		origin: { kind: "oauth" },
		usage: [],
		activeForSession: false,
		pinnedForSession: false,
		name,
	};
}

function inventory(rows: AccountRow[]): AccountInventory {
	return {
		providers: [{ provider: "anthropic", label: "Anthropic", rows }],
		totalAccounts: rows.length,
		unhealthyCount: 0,
	};
}

interface Recorded {
	used: number[];
	added: string[];
	loggedOut: number[];
}

function harness(rows: AccountRow[]) {
	const recorded: Recorded = { used: [], added: [], loggedOut: [] };
	const callbacks: AccountManagerCallbacks = {
		onUseAccount: row => recorded.used.push(row.credentialId),
		onRename: () => {},
		onRefresh: () => {},
		onLogout: row => recorded.loggedOut.push(row.credentialId),
		onShowUsage: () => {},
		onAddAccount: provider => recorded.added.push(provider),
		onCancel: () => {},
	};
	const component = new AccountManagerComponent(inventory(rows), callbacks, { terminalHeight: 40 });
	/**
	 * The one body line carrying the cursor glyph, trimmed. The sidebar draws a cursor too, so the
	 * body half of the split is taken first; a test that matched the whole row would pass while the
	 * cursor sat in the provider list.
	 */
	const cursorLine = (): string => {
		const body = component
			.render(120)
			.map(line => stripVTControlCharacters(line))
			.map(line => {
				const cells = line.split("│");
				return cells.length >= 4 ? (cells[2] ?? "") : "";
			})
			.filter(cell => cell.includes("›"));
		if (body.length !== 1) throw new Error(`expected one body cursor, found ${body.length}`);
		return (body[0] ?? "").trim();
	};
	const footer = (): string =>
		component
			.render(120)
			.map(line => stripVTControlCharacters(line))
			.join("\n");
	return { component, recorded, cursorLine, footer };
}

const THREE = (): AccountRow[] => [account(1, "first"), account(2, "second"), account(3, "third")];

describe("the add-account entry is part of the list", () => {
	/**
	 * THE REPORTED DEFECT. Arrowing off the last account used to wrap straight back to the first,
	 * so the add entry was reachable by exactly one key nothing on screen mentioned in the list
	 * itself. Down from the last account has to land on it.
	 */
	test("down from the last account lands on the add entry", () => {
		const { component, cursorLine } = harness(THREE());

		component.handleInput(DOWN);
		component.handleInput(DOWN);
		expect(cursorLine()).toContain("◦ third");

		component.handleInput(DOWN);
		expect(cursorLine()).toBe("› + add another Anthropic account");
	});

	/**
	 * The other half of the same move. An entry you can arrow onto but not off again backwards is
	 * a trap: the operator has to wrap the whole list to get back to the account they were on.
	 */
	test("up from the add entry returns to the last account", () => {
		const { component, cursorLine } = harness(THREE());

		for (let i = 0; i < 3; i++) component.handleInput(DOWN);
		expect(cursorLine()).toContain("+ add another");

		component.handleInput(UP);
		expect(cursorLine()).toContain("◦ third");
	});

	/**
	 * The list WRAPS, matching `SelectList` (which every other picker in this TUI is built on) and
	 * matching the provider sidebar in this same card. Pinning both directions stops a future edit
	 * from making the add entry a dead end at one end of the list only.
	 */
	test("the list wraps through the add entry in both directions", () => {
		const { component, cursorLine } = harness(THREE());

		// Up from the FIRST account reaches the add entry, because it is the last position.
		component.handleInput(UP);
		expect(cursorLine()).toBe("› + add another Anthropic account");

		// Down from the add entry comes back to the first account.
		component.handleInput(DOWN);
		expect(cursorLine()).toContain("◦ first");
	});

	/**
	 * Locks out the worst way to wire this: leaving `enter` bound to "use the selected account"
	 * while the cursor sits on the add entry. That would re-route the session to whichever account
	 * happened to be selected last, from a row that says it starts a login.
	 */
	test("enter on the add entry starts a login and uses no account", () => {
		const { component, recorded } = harness(THREE());

		for (let i = 0; i < 3; i++) component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(recorded.added).toEqual(["anthropic"]);
		expect(recorded.used).toEqual([]);
	});

	/**
	 * Locks out a destructive key falling through the add entry onto an account. `x` reads the
	 * selection, and the add entry is not an account, so two presses of the logout key there must
	 * remove nothing at all.
	 */
	test("the logout key does nothing while the add entry is selected", () => {
		const { component, recorded } = harness(THREE());

		for (let i = 0; i < 3; i++) component.handleInput(DOWN);
		component.handleInput("x");
		component.handleInput("x");

		expect(recorded.loggedOut).toEqual([]);
	});

	/**
	 * THE REGRESSION MOST LIKELY TO BITE. `a` was the only way to add an account before this
	 * change, so it is the key every existing user has learned. It keeps working from an account
	 * row, from the add entry itself, and while the focus is in the provider sidebar.
	 */
	test("a still adds an account from every position on the card", () => {
		const { component, recorded } = harness(THREE());

		component.handleInput("a");
		for (let i = 0; i < 3; i++) component.handleInput(DOWN);
		component.handleInput("a");
		component.handleInput("\x1b[D");
		component.handleInput("a");

		expect(recorded.added).toEqual(["anthropic", "anthropic", "anthropic"]);
	});

	/**
	 * The footer names what `enter` will do. While the add entry is selected `enter` does not use
	 * an account, so a chip still reading `enter use for Anthropic` would be the card promising an
	 * action it will not take.
	 */
	test("the enter chip says add while the add entry is selected", () => {
		const { component, footer } = harness(THREE());
		expect(footer()).toContain("enter use for Anthropic");

		for (let i = 0; i < 3; i++) component.handleInput(DOWN);

		expect(footer()).toContain("enter add Anthropic account");
		expect(footer()).not.toContain("enter use for Anthropic");
	});
});
