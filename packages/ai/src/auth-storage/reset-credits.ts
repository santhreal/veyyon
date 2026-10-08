/**
 * Spending one saved usage reset: an OpenAI Codex saved reset or an Anthropic usage-limit grant.
 */

import type { FetchImpl } from "../types";
import { claimAnthropicReset, fetchAnthropicResetStatus, selectAnthropicResetGrant } from "../usage/anthropic-reset";
import { consumeCodexResetCredit, listCodexResetCredits } from "../usage/openai-codex-reset";
import type { OAuthAccess, ResetCreditRedeemCode } from "./types";

/** An Anthropic claim result in the provider-neutral {@link ResetCreditRedeemCode} vocabulary. */
function anthropicRedeemCode(result: string): ResetCreditRedeemCode {
	switch (result) {
		case "already_used":
			return "already_redeemed";
		case "not_limited":
			return "nothing_to_reset";
		default:
			return result;
	}
}

export async function spendCodexReset(
	access: OAuthAccess,
	auth: { accessToken: string; baseUrl?: string; fetch: FetchImpl; signal?: AbortSignal },
	requestedCreditId: string | undefined,
): Promise<{ code: ResetCreditRedeemCode; creditId?: string }> {
	let creditId = requestedCreditId;
	if (!creditId) {
		const list = await listCodexResetCredits({ ...auth, accountId: access.accountId });
		const credit = list?.credits.find(entry => (entry.status ?? "available") === "available") ?? list?.credits[0];
		if (!credit) return { code: "no_credit" };
		creditId = credit.id;
	}
	const result = await consumeCodexResetCredit({ ...auth, creditId, accountId: access.accountId });
	return { code: result.code, creditId };
}

export async function spendAnthropicReset(
	access: OAuthAccess,
	auth: { accessToken: string; baseUrl?: string; fetch: FetchImpl; signal?: AbortSignal },
	requestedGrantId: string | undefined,
): Promise<{ code: ResetCreditRedeemCode; creditId?: string }> {
	// The claim must name the server's next grant, so the status is read live even when the
	// caller names one: a stale id would be rejected with `not_next_grant` after the round trip.
	const read = await fetchAnthropicResetStatus(auth);
	if (!read) return { code: "status_unavailable", creditId: requestedGrantId };
	const grant = selectAnthropicResetGrant(read.status, requestedGrantId);
	if (!grant) return { code: read.status.eligible ? "no_credit" : "ineligible", creditId: requestedGrantId };
	const orgId = access.orgId ?? read.orgId;
	if (!orgId) return { code: "no_organization", creditId: grant.id };
	const claim = await claimAnthropicReset({ ...auth, orgId, grantId: grant.id });
	return { code: anthropicRedeemCode(claim.result), creditId: grant.id };
}
