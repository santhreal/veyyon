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

export const CLASSIFICATION_RULES: readonly ClassificationRule[] = ERROR_DOMAINS.flatMap(d => d.rules ?? []);

export const CLASS_RULES: readonly ClassRule[] = ERROR_DOMAINS.flatMap(d => d.classes ?? []);

function maskOf(domains: readonly ErrorDomain[]): number {
	return domains.reduce((bits, domain) => domain.recovers.reduce((acc, flag) => acc | flag, bits), 0);
}

export const TURN_RETRIABLE_MASK: number = maskOf(ERROR_DOMAINS.filter(d => d.recovery?.turn.action === "retry"));

export const RETRY_VETO_MASK: number = maskOf(ERROR_DOMAINS.filter(d => d.vetoesRetry === true));

export const REPLAY_SAFE_MASK: number = maskOf(ERROR_DOMAINS.filter(d => d.replaySafe === true));

export function vetoesRetry(id: number | undefined): boolean {
	return ((id ?? 0) & RETRY_VETO_MASK) !== 0;
}

export function domainOf(flag: Flag): ErrorDomain | undefined {
	return ERROR_DOMAINS.find(domain => domain.recovers.includes(flag));
}

export function recover(id: number | undefined, stage: RecoveryStage): Recovery {
	for (const domain of ERROR_DOMAINS) {
		if (domain.recovery === undefined) continue;
		if (domain.recovers.some(flag => is(id, flag))) return domain.recovery[stage];
	}
	return { action: "surface" };
}

export function retriable(id: number | undefined, opts?: { replayUnsafe?: boolean }): boolean {
	if (vetoesRetry(id)) return false;
	if (((id ?? 0) & REPLAY_SAFE_MASK) !== 0) return true;
	if (opts?.replayUnsafe) return false;
	return ((id ?? 0) & TURN_RETRIABLE_MASK) !== 0;
}

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

export function classifyIdentity(link: unknown, trace?: string[]): number {
	let kinds = 0;
	for (const rule of CLASS_RULES) {
		if (!rule.matches(link)) continue;
		kinds |= rule.flags(link);
		trace?.push(rule.name);
	}
	return kinds;
}
