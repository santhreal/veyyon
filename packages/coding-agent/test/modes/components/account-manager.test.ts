/**
 * Behavioral suite for the `/providers` account manager card.
 *
 * Every test here drives the REAL {@link AccountManagerComponent} and asserts the exact text a
 * user would read on screen, because the whole point of the card is that the store's several
 * credentials per provider stop being invisible. A test that only checked "some rows rendered"
 * would pass while the card showed the wrong account as the one serving the session.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	type AccountManagerCallbacks,
	AccountManagerComponent,
	type AccountManagerOptions,
} from "@veyyon/coding-agent/modes/components/account-manager";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { AccountInventory, AccountRow } from "@veyyon/coding-agent/session/account-inventory";

beforeAll(async () => {
	await initTheme();
});

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

function account(credentialId: number, overrides: Partial<AccountRow> = {}): AccountRow {
	return {
		provider: "anthropic",
		providerLabel: "Anthropic",
		credentialId,
		type: "oauth",
		origin: { kind: "oauth" },
		usage: [],
		activeForSession: false,
		pinnedForSession: false,
		...overrides,
	};
}

function inventory(rows: AccountRow[]): AccountInventory {
	return {
		providers: [{ provider: "anthropic", label: "Anthropic", rows }],
		totalAccounts: rows.length,
		unhealthyCount: rows.filter(row => row.health === "failed").length,
	};
}

interface Recorded {
	used: number[];
	renamed: Array<{ credentialId: number; name: string }>;
	refreshed: string[];
	loggedOut: number[];
	usage: number[];
	added: string[];
	cancels: number;
}

function harness(
	rows: AccountRow[],
	options: AccountManagerOptions = {},
): {
	component: AccountManagerComponent;
	recorded: Recorded;
	frame: () => string[];
	card: () => string;
	/** The whole card, ANSI stripped but columns intact, for screen-space mouse arithmetic. */
	raw: () => string[];
} {
	const recorded: Recorded = {
		used: [],
		renamed: [],
		refreshed: [],
		loggedOut: [],
		usage: [],
		added: [],
		cancels: 0,
	};
	const callbacks: AccountManagerCallbacks = {
		onUseAccount: row => recorded.used.push(row.credentialId),
		onRename: (row, name) => recorded.renamed.push({ credentialId: row.credentialId, name }),
		onRefresh: provider => recorded.refreshed.push(provider),
		onLogout: row => recorded.loggedOut.push(row.credentialId),
		onShowUsage: row => recorded.usage.push(row.credentialId),
		onAddAccount: provider => recorded.added.push(provider),
		onCancel: () => {
			recorded.cancels += 1;
		},
	};
	const component = new AccountManagerComponent(inventory(rows), callbacks, options);
	const render = (): string[] => component.render(120).map(line => stripVTControlCharacters(line));
	return {
		component,
		recorded,
		// Only the body pane. A whole card row is `│ sidebar │ body │`, and the sidebar carries
		// every other provider's name, so asserting against full rows matches text this card
		// merely happens to list beside the accounts under test.
		frame: () =>
			render().map(line => {
				const cells = line.split("│");
				return (cells.length >= 4 ? cells[2] : (cells[1] ?? line))?.trim() ?? "";
			}),
		card: () => render().join("\n"),
		raw: render,
	};
}

/** The single rendered line containing `needle`, trimmed. Throws when it is absent or ambiguous. */
function lineWith(lines: readonly string[], needle: string): string {
	const matches = lines.filter(line => line.includes(needle));
	if (matches.length !== 1) {
		throw new Error(`expected exactly one line containing ${JSON.stringify(needle)}, found ${matches.length}`);
	}
	return matches[0] ?? "";
}

const THREE_ACCOUNTS = (): AccountRow[] => [
	account(1, { name: "work", email: "first@example.com", orgName: "Example Org", activeForSession: true }),
	account(2, { name: "personal", email: "second@example.com" }),
	account(3, {
		email: "revoked@example.invalid",
		health: "failed",
		healthReason: "invalid_grant: refresh token revoked",
	}),
];

describe("AccountManagerComponent rendering", () => {
	/**
	 * Locks out the defect the card exists to fix: `/providers` used to render one row per
	 * PROVIDER, so three Anthropic credentials collapsed into a single `logged in` line and
	 * nothing said which of them the session was routed to. Each credential gets its own row,
	 * and each row's glyph reports its real state.
	 */
	test("renders one row per credential, marked serving, idle or failed", () => {
		const { frame } = harness(THREE_ACCOUNTS());
		const lines = frame();

		expect(lineWith(lines, "work")).toContain("● work");
		expect(lineWith(lines, "personal")).toContain("◦ personal");
		expect(lineWith(lines, "revoked@example.invalid")).toContain("✗ revoked@example.invalid");
		expect(lineWith(lines, "3 accounts")).toContain("Anthropic · 3 accounts · 1 needs attention");
	});

	/**
	 * Locks out summarising an upstream auth failure as "login failed". `invalid_grant: refresh
	 * token revoked` is the only string that tells a user the provider revoked the token, so
	 * re-running the same login will not help. The reason is printed verbatim, under its row.
	 */
	test("prints the upstream failure reason verbatim beneath the failed row", () => {
		const { frame } = harness(THREE_ACCOUNTS());
		const lines = frame();

		const failedIndex = lines.findIndex(line => line.includes("✗ revoked@example.invalid"));
		expect(failedIndex).toBeGreaterThanOrEqual(0);
		const reasonIndex = lines.findIndex(line => line.includes("invalid_grant: refresh token revoked"));
		expect(reasonIndex).toBeGreaterThan(failedIndex);
	});

	/**
	 * Locks out showing a rate-limited credential as simply broken. A blocked account comes back
	 * on its own, so the card owes the user the countdown rather than an error mark that invites
	 * a pointless re-login.
	 */
	test("shows the unblock countdown on a rate-limited row", () => {
		const { frame } = harness([
			account(1, { name: "work", email: "first@example.com", blockedUntilMs: NOW + 2 * HOUR }),
		]);
		const lines = frame();

		expect(lineWith(lines, "work")).toContain("⊗ work");
		expect(lineWith(lines, "unblocks in")).toContain("rate limited · unblocks in 2h");
	});

	/**
	 * Locks out the most misleading state this card can reach: a pin that a rate limit rotated
	 * off, rendered as though the user had chosen the substitute. Both accounts are named, the
	 * rotation is stated, and the substitute never claims to be pinned.
	 */
	test("reports a rotated pin instead of presenting the substitute as chosen", () => {
		const { frame } = harness([
			account(1, { name: "work", pinnedForSession: true, blockedUntilMs: NOW + 2 * HOUR }),
			account(2, { name: "personal", activeForSession: true }),
		]);
		const lines = frame();

		expect(lineWith(lines, "rotated off")).toBe("pinned to work, rotated off it onto personal");
		expect(lineWith(lines, "re-pins")).toBe("enter re-pins work · 2h until it unblocks");
		expect(lineWith(lines, "● personal")).not.toContain("pinned");
		expect(lineWith(lines, "● personal")).toContain("this session");
		expect(lineWith(lines, "⊗ work")).toContain("pinned");
	});

	/**
	 * Locks out a second display-name ladder growing inside the card. `accountDisplayLabel` is
	 * the one owner: a named account reads as its name, an unnamed one as its email, and the
	 * email is not repeated as its own detail when it was already the label.
	 */
	test("labels an account by its chosen name, falling back to the email", () => {
		const { frame } = harness([
			account(1, { name: "work", email: "first@example.com" }),
			account(2, { email: "spare@example.com" }),
		]);
		const lines = frame();

		expect(lineWith(lines, "work")).toContain("◦ work  first@example.com");
		expect(lineWith(lines, "spare@example.com")).toContain("◦ spare@example.com");
		expect(lineWith(lines, "spare@example.com")).not.toContain("spare@example.com  spare@example.com");
	});

	/**
	 * Locks out a footer that reads as a global account switch. Several providers serve one
	 * session at once, so `enter` can only ever mean "use this account FOR ITS PROVIDER"; the
	 * chip has to say which provider or the key promises something the product does not do.
	 */
	test("names the provider in the enter shortcut", () => {
		const { card } = harness(THREE_ACCOUNTS());
		expect(card()).toContain("enter use for Anthropic");
	});

	/**
	 * Locks out a card that can only show providers you already signed into. `a` adds an account
	 * for the SELECTED provider, so a provider you hold no credentials for has to be selectable
	 * or the first login for it is unreachable from the very view that manages logins.
	 */
	test("focuses a provider holding no credentials and offers to add its first account", () => {
		const { component, recorded, frame } = harness(THREE_ACCOUNTS(), { initialProviderId: "cerebras" });
		const lines = frame();

		expect(lineWith(lines, "no accounts yet")).toBe("Cerebras · no accounts yet");
		expect(lineWith(lines, "add another")).toBe("+ add another Cerebras account (a)");

		component.handleInput("a");
		expect(recorded.added).toEqual(["cerebras"]);
	});
});

describe("AccountManagerComponent interaction", () => {
	/**
	 * Locks out index-keyed selection. Health and usage probes land seconds after the card opens
	 * and replace the whole inventory; a selection stored as a list index silently slides onto a
	 * different account, and the very next `x` would log out one the user never chose.
	 */
	test("setInventory preserves the selected credential across a health update", () => {
		const { component, recorded, frame } = harness(THREE_ACCOUNTS());
		component.handleInput("\x1b[B");
		expect(lineWith(frame(), "› ")).toContain("personal");

		const probed = THREE_ACCOUNTS().map(row =>
			row.credentialId === 3 ? row : { ...row, health: "ok" as const, usage: [{ label: "5h", usedFraction: 0.7 }] },
		);
		component.setInventory({
			providers: [{ provider: "anthropic", label: "Anthropic", rows: probed }],
			totalAccounts: 3,
			unhealthyCount: 1,
		});

		expect(lineWith(frame(), "› ")).toContain("personal");
		component.handleInput("\r");
		expect(recorded.used).toEqual([2]);
	});

	/**
	 * Locks out a one-keystroke logout. Removing a credential from this card is irreversible and
	 * `x` sits next to `u`, so the first press only arms the confirm and says so; only a second
	 * press on the same row removes the account, and it does so exactly once.
	 */
	test("x arms the logout confirm and only the second press logs out", () => {
		const { component, recorded, frame } = harness(THREE_ACCOUNTS());

		component.handleInput("x");
		expect(recorded.loggedOut).toEqual([]);
		expect(lineWith(frame(), "press x again")).toBe("press x again to log out of work · esc cancels");

		component.handleInput("x");
		expect(recorded.loggedOut).toEqual([1]);
		expect(frame().join("\n")).not.toContain("press x again");
	});

	/**
	 * Locks out an armed logout surviving the key the user backs out with. Escape unwinds the
	 * confirm rather than closing the card, so a user who armed `x` by mistake is not left one
	 * stray keypress away from losing a credential.
	 */
	test("esc disarms a pending logout before it closes the card", () => {
		const { component, recorded, frame } = harness(THREE_ACCOUNTS());

		component.handleInput("x");
		component.handleInput("\x1b");
		expect(recorded.cancels).toBe(0);
		expect(frame().join("\n")).not.toContain("press x again");

		component.handleInput("x");
		expect(recorded.loggedOut).toEqual([]);
	});

	/**
	 * Locks out one Escape taking the rename editor and the whole card with it, which is how
	 * typed text disappears without the user seeing where it went. Escape cancels the innermost
	 * thing they opened; the card stays up and the name is not written.
	 */
	test("esc during a rename cancels the rename and leaves the card open", () => {
		const { component, recorded, frame } = harness(THREE_ACCOUNTS());

		// The third row is unnamed, so the editor opens empty and the typed text is all there is.
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("n");
		for (const char of "night-shift") component.handleInput(char);
		expect(lineWith(frame(), "name:")).toContain("night-shift");

		component.handleInput("\x1b");
		expect(recorded.cancels).toBe(0);
		expect(recorded.renamed).toEqual([]);
		expect(frame().join("\n")).not.toContain("name:");
		expect(lineWith(frame(), "3 accounts")).toContain("Anthropic · 3 accounts");
	});

	/**
	 * Locks out an empty rename being swallowed as a no-op. Submitting nothing is the only way a
	 * user takes a name back off an account, so the empty string has to reach the callback.
	 */
	test("submitting an empty rename clears the name", () => {
		const { component, recorded } = harness(THREE_ACCOUNTS());

		component.handleInput("n");
		for (const _ of "work") component.handleInput("\x7f");
		component.handleInput("\r");

		expect(recorded.renamed).toEqual([{ credentialId: 1, name: "" }]);
	});

	/**
	 * Locks out row actions firing against the wrong account or the wrong provider: refresh and
	 * add are provider-scoped, usage is row-scoped, and every one of them reads the SAME
	 * selection the card is drawing a cursor on.
	 */
	test("row and provider actions target the selected row and its provider", () => {
		const { component, recorded } = harness(THREE_ACCOUNTS());

		component.handleInput("\x1b[B");
		component.handleInput("u");
		component.handleInput("r");
		component.handleInput("a");

		expect(recorded.usage).toEqual([2]);
		expect(recorded.refreshed).toEqual(["anthropic"]);
		expect(recorded.added).toEqual(["anthropic"]);
	});
});

/**
 * The sidebar's provider list is SHORTER than the split it lives in: the account tally block
 * takes the last rows. Every screen-row-to-provider conversion has to agree about that, and
 * these two only misfire once there are more providers than fit, which the real login registry
 * comfortably supplies.
 */
describe("AccountManagerComponent sidebar mouse", () => {
	/** The sidebar half of a rendered card row (`│ sidebar │ body │`). */
	function sidebarCell(line: string): string {
		const cells = line.split("│");
		return cells.length >= 4 ? (cells[1] ?? "") : "";
	}

	function rowOf(lines: readonly string[], predicate: (sidebar: string) => boolean): number {
		const index = lines.findIndex(line => predicate(sidebarCell(line)));
		if (index < 0) throw new Error("no sidebar row matched");
		return index;
	}

	/**
	 * Locks out a click on the account tally selecting a provider that is scrolled out of view.
	 * The tally rows are not list rows, so the row-to-index conversion has to stop at the end of
	 * the list; without that bound a click below the fold silently switches the card to whichever
	 * provider happens to sit that far down the (invisible) remainder of the list.
	 */
	test("a click on the account tally selects no provider", () => {
		const { component, raw, frame } = harness(THREE_ACCOUNTS());
		const lines = raw();
		const summaryRow = rowOf(lines, sidebar => /\d+ accounts?/.test(sidebar));
		const col = (lines[summaryRow] ?? "").indexOf("3 accounts");
		expect(col).toBeGreaterThan(0);

		component.handleInput(`\x1b[<0;${col + 1};${summaryRow + 1}M`);

		expect(lineWith(frame(), "3 accounts")).toContain("Anthropic · 3 accounts");
	});

	/**
	 * Locks out a wheel clamp computed against the whole split instead of the list. Clamping to
	 * `entries - splitRows` leaves exactly the tally's worth of providers unreachable at the
	 * bottom, and the keyboard hides it because arrowing re-derives the scroll from the active
	 * entry.
	 */
	test("wheeling the sidebar reaches the last provider", () => {
		const { component, raw } = harness(THREE_ACCOUNTS());
		const before = raw();
		const anthropicRow = rowOf(before, sidebar => sidebar.includes("Anthropic"));
		const col = (before[anthropicRow] ?? "").indexOf("Anthropic");
		expect(before.some(line => sidebarCell(line).includes("Zhipu Coding Plan"))).toBe(false);

		for (let i = 0; i < 80; i++) {
			component.handleInput(`\x1b[<65;${col + 1};${anthropicRow + 1}M`);
		}

		expect(raw().some(line => sidebarCell(line).includes("Zhipu Coding Plan"))).toBe(true);
	});

	/**
	 * Locks out the other half of the wheel fix. Letting the wheel pan freely means the viewport
	 * no longer chases the active provider every frame, so arrowing past the fold has to scroll
	 * the list itself — otherwise the keyboard walks the selection somewhere the user cannot see.
	 */
	test("arrowing past the fold scrolls the selected provider into view", () => {
		const { component, raw } = harness(THREE_ACCOUNTS());
		component.handleInput("\x1b[D");
		for (let i = 0; i < 30; i++) component.handleInput("\x1b[B");

		const cursorRows = raw().filter(line => sidebarCell(line).includes("›"));
		expect(cursorRows).toHaveLength(1);
	});
});
