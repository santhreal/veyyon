import { $flag } from "@veyyon/utils/env";
import type { Model } from "../types";

/**
 * Whether a Bedrock model accepts explicit prompt-cache points.
 *
 * Base models and system-defined inference profiles carry the model family in
 * their id/ARN. Application inference profiles do not, so the existing
 * `AWS_BEDROCK_FORCE_CACHE` escape hatch remains the final authority.
 */
export function supportsBedrockPromptCaching(model: Model<"bedrock-converse-stream">): boolean {
	if (model.cost.cacheRead || model.cost.cacheWrite) return true;
	const id = model.id.toLowerCase();
	if (id.includes("claude") && (id.includes("-4-") || id.includes("-4."))) return true;
	if (id.includes("claude-3-7-sonnet") || id.includes("claude-3-5-haiku")) return true;
	if (id.includes("claude-haiku")) return true;
	if (typeof process !== "undefined" && $flag("AWS_BEDROCK_FORCE_CACHE")) return true;
	return false;
}
