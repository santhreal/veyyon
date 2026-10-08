/**
 * The unified registry: every failure family, in the order that decides which one speaks.
 *
 * This is the only place the domains are assembled. Classification reads the rules out of it, and
 * recovery walks it in declaration order, so "what happens when a provider returns this" is one
 * array read rather than a search of the thirteen retry loops that each used to answer it.
 *
 * ORDER IS THE POLICY. A single failure carries several flags — a malformed function call is also
 * transient because the transport vocabulary contains the phrase, a coded 429 is a spent quota and
 * a throttle at once — and the first domain in this array whose flags are present is the one whose
 * recovery applies. The order below is therefore a set of decisions, each stated where it is made:
 *
 *  1. `interrupt`     A stop somebody asked for is never a fault, whatever else the message says.
 *  2. `content`       A verdict on the request vetoes retrying it, however the rest classified.
 *  3. `overflow`      A prompt that did not fit must shrink; retrying it sends the same bytes.
 *  4. `quota`         An exhausted account is more specific than a refused one, and rotating to a
 *                     sibling is cheaper and safer than forcing the operator through a re-login.
 *  5. `auth`          A refused credential is fixed one stage down, by refreshing it.
 *  6. `grammar`       Capability walls arrive as 400s and 429s that the transport rules also match,
 *  7. `fast-mode`     so they decide before the transport does or the request is re-sent unchanged.
 *  8. `tool-call`     A call that never parsed is the one family safe to replay after a tool call.
 *  9. `stream`        A turn that ended badly is re-sent, and the transport had nothing to do with it.
 * 10. `thinking-loop` Caught by the detector rather than by any provider message.
 * 11. `transport`     Before `timeout`, because a timeout that also carries a transport fault is a
 * 12. `timeout`       repeatable request, while a bare timeout means this model needs a different one.
 * 13. `provider-http` Recovers nothing: it reads a status and a code for the families that own them.
 *
 * The auth gateway's answers are assembled here as well, in {@link GATEWAY_RULES}, because a gateway
 * verdict is one more reading of the same failure and its rules belong to the same families.
 */
import {
	authDomain,
	gatewayAuthRefusalWordingRule,
	gatewayThrottleWordingRule,
	gatewayUsageLimitRule,
	quotaDomain,
} from "./domains/account";
import { refusalDomain, timeoutDomain, transportDomain } from "./domains/network";
import {
	fastModeDomain,
	gatewayInvalidRequestWordingRule,
	gatewayStatusFieldRule,
	gatewayStatusInMessageRule,
	grammarDomain,
	overflowDomain,
	providerHttpDomain,
	toolChoiceDomain,
} from "./domains/request";
import {
	contentDomain,
	gatewayCancellationIdentityRule,
	gatewayCancellationWordingRule,
	interruptDomain,
	streamDomain,
	thinkingLoopDomain,
	toolCallDomain,
} from "./domains/turn";
import type {
	ClassificationRule,
	ClassRule,
	ErrorDomain,
	GatewayRule,
	GatewaySignal,
	GatewayVerdict,
	Recovery,
	RecoveryStage,
	Signal,
} from "./domains/types";
import { type Flag, is } from "./flag";

export const ERROR_DOMAINS: readonly ErrorDomain[] = [
	interruptDomain,
	contentDomain,
	overflowDomain,
	quotaDomain,
	authDomain,
	grammarDomain,
	fastModeDomain,
	toolChoiceDomain,
	toolCallDomain,
	streamDomain,
	thinkingLoopDomain,
	refusalDomain,
	transportDomain,
	timeoutDomain,
	providerHttpDomain,
];

/**
 * Every signal rule in the registry.
 *
 * Order-independent by construction: each rule states every fact it depends on and the classifier
 * ORs the flags of all that match, so a rule cannot be shadowed by an earlier one. That is what
 * separates classification from recovery — one accumulates, the other decides.
 */
export const CLASSIFICATION_RULES: readonly ClassificationRule[] = ERROR_DOMAINS.flatMap(d => d.rules ?? []);

/**
 * Every identity rule in the registry.
 *
 * Also order-independent: the error classes are siblings that all extend `Error` directly, and the
 * one pair with an overlap states the exclusion in its own condition rather than relying on
 * position. This replaced an `else if` chain, where adding a class meant deciding where in the chain
 * it belonged and a subclass added later would have been silently shadowed.
 */
export const CLASS_RULES: readonly ClassRule[] = ERROR_DOMAINS.flatMap(d => d.classes ?? []);

function maskOf(domains: readonly ErrorDomain[]): number {
	return domains.reduce((bits, domain) => domain.recovers.reduce((acc, flag) => acc | flag, bits), 0);
}

/**
 * The flags whose turn-stage recovery is a plain retry, derived from the registry.
 *
 * This used to be a hand-kept bitmask beside the flag table, which is the shape where a flag is
 * added and the mask is not: a new failure kind was retriable or not depending on whether whoever
 * added it noticed a constant twenty lines up. Now a family is turn-retriable because it SAYS it
 * retries at the turn, and there is nothing to keep in sync.
 */
export const TURN_RETRIABLE_MASK: number = maskOf(ERROR_DOMAINS.filter(d => d.recovery?.turn.action === "retry"));

/** The flags that refuse a retry for the whole failure, however the rest of it classified. */
export const RETRY_VETO_MASK: number = maskOf(ERROR_DOMAINS.filter(d => d.vetoesRetry === true));

/** The flags whose retry is safe even when the failed turn already emitted a tool call. */
export const REPLAY_SAFE_MASK: number = maskOf(ERROR_DOMAINS.filter(d => d.replaySafe === true));

/**
 * Whether a failure refuses a retry outright, however the rest of it classified.
 *
 * ONE READER PER MASK. The veto is the registry's strongest statement about a failure, and it was
 * consulted by {@link retriable} alone: the provider ladder's own predicate re-derived transience
 * from message prose and never asked, so a content filter whose body also carried a 503 came back
 * retryable there while the turn refused it, and a cancellation came back retryable through the
 * word "aborted" in its own sentence. Both readers ask this.
 */
export function vetoesRetry(id: number | undefined): boolean {
	return ((id ?? 0) & RETRY_VETO_MASK) !== 0;
}

/** The domain that decides recovery for `flag`, or `undefined` for a bit no domain claims. */
export function domainOf(flag: Flag): ErrorDomain | undefined {
	return ERROR_DOMAINS.find(domain => domain.recovers.includes(flag));
}

/**
 * What `stage` should do about a classified failure.
 *
 * The first domain in {@link ERROR_DOMAINS} whose flags are present decides. An id that carries no
 * flag at all — a bare status, or nothing — surfaces: an unclassified failure is one nobody has a
 * recovery for, and inventing a retry for it is how a permanent 400 gets sent five times.
 */
export function recover(id: number | undefined, stage: RecoveryStage): Recovery {
	for (const domain of ERROR_DOMAINS) {
		if (domain.recovery === undefined) continue;
		if (domain.recovers.some(flag => is(id, flag))) return domain.recovery[stage];
	}
	return { action: "surface" };
}

/**
 * Whether a failed turn is worth another attempt.
 *
 * `replayUnsafe` means the failed assistant message already carried a tool call, so the tool may
 * have run and replaying would duplicate its effect. That is a separate question from whether the
 * failure was transient, and it wins: a transport fault says the next attempt could differ, never
 * that repeating the turn is safe. HTTP/2 stream resets are classified transient for exactly that
 * reason and deliberately get no bypass here, because a reset that arrives after the stream
 * delivered a tool call is precisely the case the guard exists for. The one exception is the family
 * that declares itself `replaySafe`: a malformed function call was never well-formed enough to
 * execute, so there is nothing to duplicate.
 */
export function retriable(id: number | undefined, opts?: { replayUnsafe?: boolean }): boolean {
	if (vetoesRetry(id)) return false;
	if (((id ?? 0) & REPLAY_SAFE_MASK) !== 0) return true;
	if (opts?.replayUnsafe) return false;
	return ((id ?? 0) & TURN_RETRIABLE_MASK) !== 0;
}

/**
 * Apply every signal rule to one failure and return the flags they set between them.
 *
 * `trace`, when given, collects the name of every rule that fired, in registry order. That is the
 * only way to answer "which rule classified this", which used to be answered by re-running the
 * conditions by hand against the provider's sentence.
 */
export function classifySignal(signal: Signal, trace?: string[]): number {
	let kinds = 0;
	for (const rule of CLASSIFICATION_RULES) {
		if (rule.structural && !rule.structural(signal)) continue;
		if (rule.text && !rule.text(signal.text)) continue;
		if (rule.structural === undefined && rule.text === undefined) continue;
		kinds |= rule.flags;
		trace?.push(rule.name);
	}
	return kinds;
}

/** Apply every identity rule to one link of a cause chain and return the flags they state. */
export function classifyIdentity(link: unknown, trace?: string[]): number {
	let kinds = 0;
	for (const rule of CLASS_RULES) {
		if (!rule.matches(link)) continue;
		kinds |= rule.flags(link);
		trace?.push(rule.name);
	}
	return kinds;
}

/**
 * What the auth gateway answers its client, first-match-wins in this order.
 *
 * ORDER IS THE POLICY here too, and for a different reason than in {@link ERROR_DOMAINS}: a gateway
 * sends one status per failure, so where the signal rules accumulate flags these stop at the first
 * answer. The decisions:
 *
 *  1. `gateway-status-field`            A numeric status on the thrown value is the upstream's answer.
 *  2. `gateway-cancellation-identity`   A cancellation class is the client leaving, whatever status its
 *                                       message quotes.
 *  3. `gateway-status-in-message`       A status the message states outranks every word around it.
 *  4. `gateway-cancellation-wording`
 *  5. `gateway-throttle-wording`        Both throttle rules precede the refusal wording, because
 *  6. `gateway-usage-limit`             providers word a throttle as `unauthorized due to rate limit`.
 *  7. `gateway-auth-refusal-wording`
 *  8. `gateway-invalid-request-wording`
 *
 * A failure no rule answers receives the gateway's default, a 502 `upstream_error`.
 */
export const GATEWAY_RULES: readonly GatewayRule[] = [
	gatewayStatusFieldRule,
	gatewayCancellationIdentityRule,
	gatewayStatusInMessageRule,
	gatewayCancellationWordingRule,
	gatewayThrottleWordingRule,
	gatewayUsageLimitRule,
	gatewayAuthRefusalWordingRule,
	gatewayInvalidRequestWordingRule,
];

/** One gateway rule's name and the function that answers for it. */
interface GatewayAnswer {
	readonly name: string;
	readonly answer: (signal: GatewaySignal) => GatewayVerdict | undefined;
}

/** The gateway rules in order, each wording rule's pattern compiled once from its wordings. */
const GATEWAY_ANSWERS: readonly GatewayAnswer[] = GATEWAY_RULES.map(rule => {
	if (!("wordings" in rule)) return { name: rule.name, answer: rule.answer };
	const pattern = new RegExp(String.raw`\b(?:${rule.wordings.join("|")})\b`, "i");
	return { name: rule.name, answer: signal => (pattern.test(signal.text) ? rule.verdict : undefined) };
});

/**
 * Apply the gateway rules to one failure and return the first answer, or `undefined` when none reads it.
 *
 * `trace`, when given, receives the name of the rule that answered, as {@link classifySignal}'s does.
 */
export function answerGateway(signal: GatewaySignal, trace?: string[]): GatewayVerdict | undefined {
	for (const { name, answer } of GATEWAY_ANSWERS) {
		const verdict = answer(signal);
		if (verdict === undefined) continue;
		trace?.push(name);
		return verdict;
	}
	return undefined;
}
