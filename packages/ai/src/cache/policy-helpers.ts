import { $env } from "@veyyon/utils/env";
import type { CacheEnforcement } from "../types";

export type { CacheEnforcement };

export function resolveCacheEnforcement(explicit?: CacheEnforcement): CacheEnforcement {
	if (explicit) return explicit;
	const configured = $env.VEYYON_CACHE_ENFORCEMENT?.trim().toLowerCase();
	if (configured === "off" || configured === "warn" || configured === "error") return configured;
	return "warn";
}
