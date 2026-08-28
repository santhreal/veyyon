import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome, ResetCreditTarget } from "../../session/auth-storage";

export interface ResetUsageAccount {
	label: string;
	availableCount: number;
	target: ResetCreditTarget;
	active: boolean;
	error?: string;
}

export function toResetUsageAccounts(statuses: ResetCreditAccountStatus[]): ResetUsageAccount[] {
	return statuses
		.map(status => ({
			label: status.email ?? status.accountId ?? "account",
			availableCount: status.availableCount,
			target: {
				credentialId: status.credentialId,
				accountId: status.accountId,
				email: status.email,
			} satisfies ResetCreditTarget,
			active: status.active,
			error: status.error,
		}))
		.sort((a, b) => {
			if (a.active !== b.active) return a.active ? -1 : 1;
			if (a.availableCount !== b.availableCount) return b.availableCount - a.availableCount;
			return a.label.localeCompare(b.label);
		});
}

export function describeRedeemOutcome(outcome: ResetCreditRedeemOutcome, label: string): string {
	switch (outcome.code) {
		case "reset":
			return `Reset applied for ${label} — your rate-limit window has been refreshed.`;
		case "already_redeemed":
			return `${label}: that reset was already redeemed.`;
		case "no_credit":
			return `${label}: no saved resets available to spend.`;
		case "nothing_to_reset":
			return `${label}: nothing to reset right now — your limits aren't constrained, so no credit was spent.`;
		case "no_account":
			return `Could not find a stored Codex account matching "${label}".`;
		case "account_unavailable":
			return `${label}: could not authenticate this account — sign in again with /login in an interactive veyyon session.`;
		default:
			return `${label}: reset did not apply (${outcome.code}).`;
	}
}
