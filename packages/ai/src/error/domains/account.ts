/**
 * The account families: the credential was refused, or it is spent.
 *
 * Both are answered one stage down, by the credential rather than by the request: `quota` rotates to
 * a sibling account, `auth` refreshes the grant. That is also what separates them at the turn — a
 * spent quota re-sends once a different credential is in hand, a refused one has nothing to re-send
 * until the refresh happens, so only the first is turn-retriable.
 */
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

// Definitive OAuth refresh failure — the stored grant/client is dead.
//
// Two spellings, because providers use both. The first alternation is the machine-readable RFC 6749
// §5.2 error codes, which is what a well-formed token endpoint returns. The second is the same
// conditions written as PROSE, which several providers return instead of, or alongside, the code:
// Kimi answers a dead grant with `400 "The provided authorization grant is invalid"`. That carries
// no code and is not a 401, so before the prose form was recognised every dead Kimi grant classified
// as transient, and the credential was blocked for five minutes and retried forever instead of being
// disabled once with a re-login prompt.
//
// The prose form is deliberately narrow: an invalidity word has to sit next to the thing that is
// invalid (`grant` or `refresh token`), in either order and with at most a short run of words
// between. A bare "invalid" or "expired" anywhere in a message is not enough, because a wrong "yes"
// here disables a working account (see {@link isDefinitiveOAuthFailure}). The transient guard still
// runs first and still wins, so a 429 or a 5xx page repeating this prose stays transient.
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

/**
 * Strip an appended stack trace from an error string before classifying it.
 *
 * Callers reach the classifier with `String(error)`, and this codebase's errors embed their cause
 * chain AND their stack, so the string that arrives is not a message: it carries source paths and
 * frame names. Matching failure keywords against that is matching against the names of our own
 * files.
 *
 * It was not theoretical. A real dead grant (`400 {"error":"invalid_grant","error_description":
 * "Refresh token not found or invalid"}`) arrived with `at async withScopedTimeoutSignal
 * (…/utils/src/scoped-timeout.ts:53:16)` in its stack, and `scoped-timeout` matches the transient
 * pattern's `timeout`. Every OAuth failure refreshed through that helper carried the word, so the
 * transient guard was reading a frame name rather than anything the provider said.
 *
 * The old ordering hid it, because the definitive check returned before the transient guard was ever
 * consulted. Making the guard authoritative surfaced it immediately, which is the useful kind of
 * regression: the guard was always wrong, it just never got to be wrong about anything that
 * mattered.
 */
export function withoutStackTrace(errorMessage: string): string {
	const stackMarker = errorMessage.indexOf("stack=");
	const withoutAppendedStack = stackMarker === -1 ? errorMessage : errorMessage.slice(0, stackMarker);
	return withoutAppendedStack
		.split("\n")
		.filter(line => !/^\s+at\s/.test(line))
		.join("\n");
}

/**
 * Whether an OAuth refresh error message means the grant is definitively dead.
 *
 * Saying yes DISABLES the credential, which forces the user through a re-login, so the two answers
 * are not symmetric. A wrong "yes" destroys a working account over a blip; a wrong "no" costs one
 * more retry. Anything ambiguous therefore resolves to no.
 *
 * That is why the transient check comes FIRST and applies to every message, not just to a bare 401.
 * A message can carry both signals: a gateway 502 whose body echoes a `WWW-Authenticate: Bearer
 * error="invalid_token"` header, a 429 whose payload repeats the request it throttled, a 5xx error
 * page containing the word "revoked". Those used to disable the credential outright, because a
 * definitive token matched and returned before the transient guard was ever consulted, and the guard
 * was only ever reached on the 401 branch. A throttled auth endpoint could permanently tear down a
 * healthy account.
 */
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
			name: "auth-failure-prose",
			why: "401/403 arrive as prose inside a wrapper as often as they arrive as a status, and 'no api key' has no status at all.",
			text: text => AUTH_FAILURE_PATTERN.test(text),
		},
	],
};
