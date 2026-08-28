import { AwsCredentialsError } from "../aws";
import { Flag } from "../flag";
import { isOpaqueStatusBody, matchesUsageLimitText, parseRateLimitReason } from "../rate-limit";
import type { ErrorDomain } from "./types";

export const quotaDomain: ErrorDomain = {
	id: "quota",
	why: "The account's allowance is spent, so the same request needs a different credential rather than another attempt.",
	recovers: [Flag.UsageLimit],
	recovery: {
		transport: { action: "surface" },
		credential: { action: "rotate-credential" },
		turn: { action: "retry" },
	},
	rules: [
		{
			flags: Flag.UsageLimit,
			name: "usage-limit-vocabulary",
			why: "The quota vocabulary is the provider's own (usage_limit_reached, insufficient_quota, account rate limit), and it rotates a credential rather than retrying it.",
			text: matchesUsageLimitText,
		},
		{
			flags: Flag.UsageLimit,
			name: "opaque-or-exhausted-429",
			why: "A 429 whose body is opaque or names an exhausted quota is a wall, not a throttle: the structure decides and the prose only says which.",
			structural: signal => signal.status === 429,
			text: text => isOpaqueStatusBody(text) || parseRateLimitReason(text) === "QUOTA_EXHAUSTED",
		},
	],
};

const AUTH_FAILURE_PATTERN =
	/\b(?:401|403|unauthorized|forbidden|authentication|auth[_ ]?unavailable|no auth available|(?:invalid|no)[_ ]?api[_ ]?key)\b/i;

const NAMED_AUTH_REFUSAL_PATTERN = /\b(?:auth[_ ]?unavailable|no auth available)\b/i;

const OAUTH_DEFINITIVE_FAILURE_PATTERN = new RegExp(
	[
		String.raw`invalid_grant|invalid_token|unauthorized_client|\brevoked\b|refresh[\s_]?token.*expired`,
		String.raw`(?:authorization\s+)?grant(?:\s+\w+){0,3}\s+(?:is\s+|was\s+|has\s+been\s+)?(?:invalid|expired|revoked)`,
		String.raw`refresh[\s_]?token(?:\s+\w+){0,3}\s+(?:is\s+|was\s+|has\s+been\s+)?(?:invalid|expired|revoked|not found)`,
		String.raw`(?:invalid|expired|revoked)\s+(?:\w+\s+){0,2}(?:authorization\s+)?(?:grant|refresh[\s_]?token)`,
	].join("|"),
	"i",
);
const OAUTH_TRANSIENT_FAILURE_PATTERN =
	/timeout|network|fetch failed|ECONN(?:REFUSED|RESET)|ETIMEDOUT|EAI_AGAIN|socket hang up|\b(?:408|425|429|5\d{2})\b|rate.?limit|too many requests|temporar|unavailable|forbidden|permission_denied|cloudflare|captcha/i;
const OAUTH_HTTP_AUTH_PATTERN = /\b401\b/;

export function withoutStackTrace(errorMessage: string): string {
	const stackMarker = errorMessage.indexOf("stack=");
	const withoutAppendedStack = stackMarker === -1 ? errorMessage : errorMessage.slice(0, stackMarker);
	return withoutAppendedStack
		.split("\n")
		.filter(line => !/^\s+at\s/.test(line))
		.join("\n");
}

export function isDefinitiveOAuthFailure(errorMessage: string): boolean {
	const diagnostic = withoutStackTrace(errorMessage);
	if (OAUTH_TRANSIENT_FAILURE_PATTERN.test(diagnostic)) return false;
	if (OAUTH_DEFINITIVE_FAILURE_PATTERN.test(diagnostic)) return true;
	return OAUTH_HTTP_AUTH_PATTERN.test(diagnostic);
}

export const authDomain: ErrorDomain = {
	id: "auth",
	why: "The credential presented with the request was refused, so it is the credential that has to change.",
	recovers: [Flag.AuthFailed],
	recovery: {
		transport: { action: "surface" },
		credential: { action: "reauth" },
		turn: { action: "surface" },
	},
	classes: [
		{
			name: "aws-credential-chain",
			why: "AWS states a missing or unusable credential chain in its type, before any request is even signed.",
			matches: link => link instanceof AwsCredentialsError,
			flags: () => Flag.AuthFailed,
		},
	],
	rules: [
		{
			flags: Flag.AuthFailed,
			name: "named-auth-refusal-code",
			why: "`auth_unavailable` is a code the gateway emits when it holds no usable credential, so it is a fact about the response and answers whatever status carries it.",
			text: text => NAMED_AUTH_REFUSAL_PATTERN.test(text),
		},
		{
			flags: Flag.AuthFailed,
			name: "auth-failure-prose",
			why: "401/403 arrive as prose inside a wrapper as often as they arrive as a status, and 'no api key' has no status at all.",
			structural: signal => signal.status === undefined || signal.status < 500,
			text: text => AUTH_FAILURE_PATTERN.test(text),
		},
	],
};
