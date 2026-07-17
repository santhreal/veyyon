import { type Effort, THINKING_EFFORTS } from "@veyyon/pi-catalog/effort";
import type { ServiceTier } from "../types";

// Narrow guards over the OpenAI-compatible request option unions, shared by
// the chat and responses server parsers so the accepted value sets never
// drift. The value sets are owned by @veyyon/pi-catalog Effort and
// ai/src/types.ts ServiceTier; this module only guards against them.

const SERVICE_TIERS: readonly ServiceTier[] = ["auto", "default", "flex", "scale", "priority"];

export function isReasoningEffort(value: unknown): value is Effort {
	return typeof value === "string" && (THINKING_EFFORTS as readonly string[]).includes(value);
}

export function isServiceTier(value: unknown): value is ServiceTier {
	return typeof value === "string" && (SERVICE_TIERS as readonly string[]).includes(value);
}
