import { describe, expect, it } from "bun:test";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome } from "@veyyon/coding-agent/session/auth-storage";
import {
	describeRedeemOutcome,
	type ResetUsageAccount,
	toResetUsageAccounts,
} from "@veyyon/coding-agent/slash-commands/helpers/reset-usage";

/**
 * `/usage reset` builds its account selector and status lines from these two pure
 * helpers, which had ZERO tests. The selector ORDER matters: the active account must
 * be preselected at the top, then the accounts with the most redeemable resets, so a
 * regression in the comparator silently offers the wrong default account to spend a
 * credit on. The outcome mapping must give a distinct, correct message per backend
 * code (and a safe fallback for the open-ended `http_<status>` codes) so a user is
 * never told "reset applied" when nothing happened.
 *
 * These assert the exact row order, the label fallback chain, the redeem target, and
 * every branch of the message map (product strings asserted verbatim).
 */

const status = (over: Partial<ResetCreditAccountStatus>): ResetCreditAccountStatus => ({
	availableCount: 0,
	credits: [],
	active: false,
	...over,
});
const labels = (rows: ResetUsageAccount[]): string[] => rows.map(r => r.label);

describe("toResetUsageAccounts", () => {
	it("orders active-first, then most credits, then label ascending", () => {
		const rows = toResetUsageAccounts([
			status({ email: "b@x.com", availableCount: 1 }),
			status({ accountId: "acc-active", active: true }),
			status({ email: "a@x.com", availableCount: 3 }),
			status({ email: "c@x.com", availableCount: 3 }),
		]);
		expect(labels(rows)).toEqual(["acc-active", "a@x.com", "c@x.com", "b@x.com"]);
	});

	it("labels by email, then accountId, then the literal 'account'", () => {
		const rows = toResetUsageAccounts([
			status({ email: "has@mail.com" }),
			status({ accountId: "acct-123" }),
			status({ error: "token fail" }),
		]);
		// All availableCount 0 and inactive -> tie broken by label ascending.
		expect(labels(rows)).toEqual(["account", "acct-123", "has@mail.com"]);
		expect(rows.find(r => r.label === "account")?.error).toBe("token fail");
	});

	it("carries the redeem target fields through for the selected account", () => {
		const [row] = toResetUsageAccounts([
			status({ email: "e@x.com", accountId: "a1", credentialId: 7, availableCount: 2 }),
		]);
		expect(row.target).toEqual({ credentialId: 7, accountId: "a1", email: "e@x.com" });
		expect(row.availableCount).toBe(2);
	});
});

describe("describeRedeemOutcome", () => {
	const message = (code: ResetCreditRedeemOutcome["code"]): string =>
		describeRedeemOutcome({ ok: code === "reset", code }, "L");

	it("returns a distinct message for every named backend and local code", () => {
		expect(message("reset")).toBe("Reset applied for L — your rate-limit window has been refreshed.");
		expect(message("already_redeemed")).toBe("L: that reset was already redeemed.");
		expect(message("no_credit")).toBe("L: no saved resets available to spend.");
		expect(message("nothing_to_reset")).toBe(
			"L: nothing to reset right now — your limits aren't constrained, so no credit was spent.",
		);
		expect(message("no_account")).toBe('Could not find a stored Codex account matching "L".');
		expect(message("account_unavailable")).toBe("L: could not authenticate this account — try /login.");
	});

	it("falls back to a safe message that names the unexpected code", () => {
		expect(message("http_500" as ResetCreditRedeemOutcome["code"])).toBe("L: reset did not apply (http_500).");
	});
});
