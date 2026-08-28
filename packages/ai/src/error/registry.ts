/**
 * The unified registry: failure families assembled in priority order for classification and recovery.
 */
import { authDomain, quotaDomain } from "./domains/account";
import { refusalDomain, timeoutDomain, transportDomain } from "./domains/network";
import { fastModeDomain, grammarDomain, overflowDomain, providerHttpDomain } from "./domains/request";
import { contentDomain, interruptDomain, streamDomain, thinkingLoopDomain, toolCallDomain } from "./domains/turn";
import type { ClassificationRule, ClassRule, ErrorDomain, Recovery, RecoveryStage, Signal } from "./domains/types";
import { type Flag, is } from "./flag";

export const ERROR_DOMAINS: readonly ErrorDomain[] = [
	interruptDomain,
	contentDomain,
	overflowDomain,
	quotaDomain,
	authDomain,
	grammarDomain,
	fastModeDomain,
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

/** Flags whose turn-stage recovery is a plain retry, derived from the registry. */
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
