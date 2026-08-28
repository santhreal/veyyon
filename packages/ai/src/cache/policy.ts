import { $env } from "@veyyon/utils/env";
import type { CacheEnforcement } from "../types";
import { type CacheVerdict, describeCacheVerdict, isCacheHealthy } from "./verdict";

export type { CacheEnforcement };

export function resolveCacheEnforcement(explicit?: CacheEnforcement): CacheEnforcement {
	if (explicit) return explicit;
	const configured = $env.VEYYON_CACHE_ENFORCEMENT?.trim().toLowerCase();
	if (configured === "off" || configured === "warn" || configured === "error") return configured;
	return "warn";
}

export class CacheRejectedError extends Error {
	readonly verdict: CacheVerdict;
	readonly provider: string;
	readonly modelId: string;

	constructor(verdict: CacheVerdict, provider: string, modelId: string) {
		super(
			`${provider}/${modelId}: ${describeCacheVerdict(verdict)}. ` +
				`The previous turn paid full input rate for a prompt it asked the provider to cache. ` +
				`Set cache.enforcement to "warn" to continue anyway.`,
		);
		this.name = "CacheRejectedError";
		this.verdict = verdict;
		this.provider = provider;
		this.modelId = modelId;
	}
}

export function isEnforceableFailure(verdict: CacheVerdict): boolean {
	return verdict.kind === "rejected";
}

export interface CacheEnforcementDecision {
	report: boolean;
	failNext: boolean;
}

export function decideCacheEnforcement(verdict: CacheVerdict, enforcement: CacheEnforcement): CacheEnforcementDecision {
	if (enforcement === "off") return { report: false, failNext: false };
	if (isCacheHealthy(verdict)) return { report: false, failNext: false };
	return { report: true, failNext: enforcement === "error" && isEnforceableFailure(verdict) };
}
