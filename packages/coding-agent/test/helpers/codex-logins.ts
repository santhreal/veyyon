import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { CODEX_JWT_AUTH_CLAIM } from "@veyyon/catalog/wire/codex";

/** Environment variable that holds an OpenAI Codex login outside the credential store. */
export const CODEX_ENV_TOKEN = "OPENAI_CODEX_OAUTH_TOKEN";

/** An expiry no test run reaches, so a stored token is served as stored and never refreshed. */
const NEVER_EXPIRES = 4_102_444_800_000;

/** An unsigned Codex access token whose auth claim states `plan` (none when `undefined`) for `accountId`. */
export function codexToken(plan: string | undefined, accountId = "acct_test"): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const claim = { chatgpt_account_id: accountId, chatgpt_plan_type: plan };
	return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ [CODEX_JWT_AUTH_CLAIM]: claim })}.signature`;
}

/**
 * Store one OpenAI Codex OAuth account per entry of `plans`, in that order, each with its own
 * account id so none is deduplicated. Returns each account's access token, in the same order.
 */
export async function storeCodexLogins(auth: AuthStorage, plans: readonly string[]): Promise<string[]> {
	const tokens = plans.map((plan, index) => codexToken(plan, `acct_${index}`));
	if (tokens.length === 0) return tokens;
	await auth.set(
		"openai-codex",
		tokens.map((access, index) => ({
			type: "oauth" as const,
			access,
			refresh: `refresh_${index}`,
			expires: NEVER_EXPIRES,
			accountId: `acct_${index}`,
		})),
	);
	return tokens;
}
