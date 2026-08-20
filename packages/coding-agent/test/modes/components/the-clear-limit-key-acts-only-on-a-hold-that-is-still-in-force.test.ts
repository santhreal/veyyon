/**
 * WHY. The card grew a `c clear limit` chip and a `c` key so an operator could lift a
 * rate-limit hold the provider may no longer be enforcing, and nothing exercised the key:
 * every account-manager test in this directory stubs `onClearRateLimitBlock` and drives
 * some other key, so the chip could have been painted beside a key that did nothing, or
 * the key could have fired on a row whose chip was never offered. Both are the same
 * defect class -- a control whose appearance and whose effect are decided by two
 * predicates that can drift apart -- and the suite closes it by asserting they are ONE
 * predicate across every boundary of the hold: absent, already expired, still in force.
 *
 * Two further things are pinned because equivalence alone cannot see them. The exact set
 * of rows that offer the control, so changing `blockedUntilMs > Date.now()` to a mere
 * presence check (which would move chip and key together and keep any equivalence test
 * green) turns this red instead. And the identity of the row handed to the callback, so
 * the key cannot act on the card's first blocked account while the cursor sits on another.
 *
 * WHAT THIS DOES NOT CATCH. The callback's body lives in `SelectorController`, which
 * builds it around `authStorage.clearCredentialBlocks` and a single-account re-probe;
 * that storage call is covered by the `packages/ai` account suites, but the controller's
 * construction of the callback is still unexercised, so a wiring mistake there would pass
 * here.
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

const HOUR = 60 * 60_000;
const CHIP = "c clear limit";

function account(credentialId: number, name: string, extra: Partial<AccountRow> = {}): AccountRow {
	return {
		provider: "anthropic",
		providerLabel: "Anthropic",
		credentialId,
		type: "oauth",
		origin: { kind: "oauth" },
		usage: [],
		activeForSession: false,
		activeIsPrediction: false,
		selectedForProvider: false,
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

/**
 * Every boundary of the hold, in one card. The deadlines are offsets from the instant the
 * rows are built, because the predicate under test compares against `Date.now()` and a
 * fixture pinned to an absolute time drifts across it.
 */
function boundaryRows(now: number): AccountRow[] {
	return [
		account(1, "no hold at all"),
		account(2, "a hold that ran out", { blockedUntilMs: now - HOUR }),
		account(3, "a hold still in force", { blockedUntilMs: now + HOUR }),
	];
}

function harness(rows: AccountRow[]) {
	const cleared: AccountRow[] = [];
	const callbacks: AccountManagerCallbacks = {
		onUseAccount: () => {},
		onRename: () => {},
		onRefresh: () => {},
		onLogout: () => {},
		onShowUsage: () => {},
		onAddAccount: () => {},
		onToggleLoadBalancing: () => false,
		onClearRateLimitBlock: row => cleared.push(row),
		onCancel: () => {},
	};
	const component = new AccountManagerComponent(inventory(rows), callbacks, { terminalHeight: 40 });
	const offersChip = (): boolean =>
		component
			.render(120)
			.map(line => stripVTControlCharacters(line))
			.some(line => line.includes(CHIP));
	return { component, cleared, offersChip };
}

describe("the clear-limit control", () => {
	test("is offered and acts for exactly the rows whose hold has not run out", () => {
		const now = Date.now();
		const rows = boundaryRows(now);
		const { component, cleared, offersChip } = harness(rows);
		// One render before any key: the card computes its selection against a laid-out
		// frame, and a component that has never painted answers from zeroed geometry.
		component.render(120);

		const offered: string[] = [];
		const acted: string[] = [];
		for (const row of rows) {
			const chip = offersChip();
			const before = cleared.length;
			component.handleInput("c");
			const fired = cleared.length > before;

			// The one invariant: what the footer offers is what the key does. A chip beside a
			// dead key and a key with no chip are both this assertion failing.
			expect(fired).toBe(chip);
			if (chip) offered.push(row.name ?? "");
			if (fired) {
				acted.push(row.name ?? "");
				// …and it acts on the SELECTED row, not on the card's first held account.
				expect(cleared.at(-1)?.credentialId).toBe(row.credentialId);
			}
			component.handleInput("\x1b[B");
		}

		// Pinned as a set, not a count: a predicate that stopped comparing the deadline
		// against now would offer the control on the expired row too, and would move the
		// chip and the key together, so the equivalence above would stay green.
		expect(offered).toEqual(["a hold still in force"]);
		expect(acted).toEqual(["a hold still in force"]);
		expect(cleared.map(row => row.credentialId)).toEqual([3]);
	});

	test("is neither offered nor firing on the add entry, which selects no account", () => {
		const now = Date.now();
		const rows = boundaryRows(now);
		const { component, cleared, offersChip } = harness(rows);
		component.render(120);

		// Past the last account is the add entry, and it holds no credential to unblock.
		for (let step = 0; step < rows.length; step += 1) component.handleInput("\x1b[B");

		expect(offersChip()).toBe(false);
		component.handleInput("c");
		expect(cleared).toEqual([]);
	});

	test("a card with no held account anywhere offers nothing to lift", () => {
		const { component, cleared, offersChip } = harness([account(1, "one"), account(2, "two")]);
		component.render(120);

		expect(offersChip()).toBe(false);
		component.handleInput("c");
		component.handleInput("\x1b[B");
		component.handleInput("c");
		expect(cleared).toEqual([]);
	});
});
