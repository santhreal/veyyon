/**
 * The main pane and the footer answer to the mouse.
 *
 * The card enabled SGR mouse tracking and routed the sidebar, so clicking a provider worked and
 * clicking anything else did not. The add entry ignored clicks entirely, an account's detail lines
 * were dead below its head line, and every footer chip except `esc close` was painted like a
 * control and behaved like a caption. Under a fullscreen overlay the pointer is the operator's
 * first instinct, and a pane that lights up under it and then does nothing reads as a frozen card.
 *
 * Screen coordinates are read back out of the rendered frame rather than computed, because the
 * card floats: a hardcoded row and column would pin the LAYOUT instead of the routing, and would
 * pass against a router that was off by the border inset.
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

function account(credentialId: number, name: string, extra: Partial<AccountRow> = {}): AccountRow {
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
		...extra,
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
	usage: number[];
	refreshed: string[];
	loggedOut: number[];
}

function harness(rows: AccountRow[]) {
	const recorded: Recorded = { used: [], added: [], usage: [], refreshed: [], loggedOut: [] };
	const callbacks: AccountManagerCallbacks = {
		onUseAccount: row => recorded.used.push(row.credentialId),
		onRename: () => {},
		onRefresh: provider => recorded.refreshed.push(provider),
		onLogout: row => recorded.loggedOut.push(row.credentialId),
		onShowUsage: row => recorded.usage.push(row.credentialId),
		onAddAccount: provider => recorded.added.push(provider),
		onCancel: () => {},
	};
	const component = new AccountManagerComponent(inventory(rows), callbacks, { terminalHeight: 40 });
	const frame = (): string[] => component.render(120).map(line => stripVTControlCharacters(line));

	/**
	 * Click the cell where `needle` is painted in the CURRENT frame. Re-rendering per click is the
	 * point: a chip's label and column move as the card's state changes, and a test measuring once
	 * would silently start clicking blank space.
	 */
	const clickOn = (needle: string): void => {
		const lines = frame();
		const rows = lines.filter(line => line.includes(needle));
		if (rows.length !== 1) throw new Error(`expected one line containing ${JSON.stringify(needle)}, got ${rows.length}`);
		const row = lines.indexOf(rows[0] ?? "");
		const col = (rows[0] ?? "").indexOf(needle);
		component.handleInput(`\x1b[<0;${col + 1};${row + 1}M`);
	};

	const cursorLine = (): string => {
		const body = frame()
			.map(line => {
				const cells = line.split("│");
				return cells.length >= 4 ? (cells[2] ?? "") : "";
			})
			.filter(cell => cell.includes("›"));
		if (body.length !== 1) throw new Error(`expected one body cursor, found ${body.length}`);
		return (body[0] ?? "").trim();
	};

	return { component, recorded, frame, clickOn, cursorLine };
}

const TWO = (): AccountRow[] => [
	account(1, "first"),
	account(2, "second", { email: "second@example.com", planTier: "Max 20x", usage: [{ label: "5h", usedFraction: 0.4 }] }),
];

describe("clicking inside the account manager's main pane", () => {
	/**
	 * Clicking an account MOVES THE CURSOR and stops there. Every row action (`enter`, `n`, `x`,
	 * `u`) reads the selection, so a click that also acted would route the session, or arm a
	 * logout, on a pointer the operator only meant to aim with.
	 */
	test("a click on an account row selects that account and acts on nothing", () => {
		const { recorded, clickOn, cursorLine } = harness(TWO());
		expect(cursorLine()).toContain("first");

		clickOn("◦ second");

		expect(cursorLine()).toContain("second");
		expect(recorded.used).toEqual([]);
		expect(recorded.loggedOut).toEqual([]);
	});

	/**
	 * An account occupies several lines: the head line, then its plan, usage bars and any failure
	 * reason. Only the head line used to carry the account, so clicking the plan line under
	 * "second" left the cursor where it was. The operator is aiming at a BLOCK, not at one row.
	 */
	test("a click on an account's plan line selects that account too", () => {
		const { clickOn, cursorLine } = harness(TWO());
		// The plan tier is painted on its OWN line under `second`'s head line, and only `second` has
		// one, so a hit there can only have come from the sub-line carrying its account.
		clickOn("Max 20x");

		expect(cursorLine()).toContain("second");
	});

	/**
	 * Same claim for the usage bars, which is the tallest part of a real account's block and so the
	 * likeliest place a pointer lands.
	 */
	test("a click on an account's usage bar selects that account too", () => {
		const { clickOn, cursorLine } = harness(TWO());
		clickOn("5h");

		expect(cursorLine()).toContain("second");
	});

	/**
	 * THE REPORTED DEFECT for the add entry. It is the one row on the card with no second step to
	 * offer, so a click has to start the login rather than park a cursor on it and wait for a key
	 * the operator did not need for anything else on this pane.
	 */
	test("a click on the add entry starts a login for the active provider", () => {
		const { recorded, clickOn } = harness(TWO());

		clickOn("+ add another");

		expect(recorded.added).toEqual(["anthropic"]);
	});

	/**
	 * Footer chips run the key they name. `u usage` reads the SELECTED account, so this also pins
	 * that a chip acts on the selection the card is drawing a cursor on, not on the first row.
	 */
	test("a footer chip runs its key against the selected account", () => {
		const { recorded, clickOn } = harness(TWO());

		clickOn("◦ second");
		clickOn("u usage");
		clickOn("r refresh");

		expect(recorded.usage).toEqual([2]);
		expect(recorded.refreshed).toEqual(["anthropic"]);
	});

	/**
	 * THE DANGEROUS ONE. The logout chip must go through the same two-press confirm ladder the `x`
	 * key does. A chip wired straight to `onLogout` would make one stray click destroy a credential
	 * that the keyboard deliberately refuses to remove without a second, confirmed press.
	 */
	test("the logout chip arms the confirm first and only the second click logs out", () => {
		const { recorded, frame, clickOn } = harness(TWO());

		clickOn("x logout");
		expect(recorded.loggedOut).toEqual([]);
		expect(frame().join("\n")).toContain("press x again to log out of first");

		clickOn("x confirm logout");
		expect(recorded.loggedOut).toEqual([1]);
	});

	/**
	 * A blank line between two account blocks belongs to neither. Treating "somewhere in the body
	 * column" as a hit would move the cursor to whichever account happened to be adjacent, which is
	 * a selection the operator did not make.
	 */
	test("a click on the gap between accounts changes nothing", () => {
		const { component, frame, cursorLine } = harness(TWO());
		const lines = frame();
		const secondRow = lines.findIndex(line => line.includes("◦ second"));
		// The line directly above an account block's head is the blank separator after the previous
		// block, which is exactly the row a fat-fingered click lands on.
		const gapRow = secondRow - 1;
		expect((lines[gapRow] ?? "").split("│")[2]?.trim()).toBe("");

		component.handleInput(`\x1b[<0;${(lines[secondRow] ?? "").indexOf("◦ second") + 1};${gapRow + 1}M`);

		expect(cursorLine()).toContain("first");
	});
});
