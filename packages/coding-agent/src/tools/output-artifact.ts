import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { Settings } from "../config/settings";
import { DEFAULT_MAX_BYTES, type InlineByteCapOptions, resolveInlineCap } from "../session/streaming-output";
import type { ToolSession } from "./index";

export interface InlinePricingSource {
	getTurnIndex?: () => number;
	settings?: Settings;
}

export function inlineOutputPricing(
	session: InlinePricingSource,
): Pick<InlineByteCapOptions, "turnIndex" | "floorFraction" | "maxBytes"> {
	return {
		turnIndex: session.getTurnIndex?.(),
		floorFraction: session.settings?.get("tools.inlineOutputFloor"),
		maxBytes: configuredInlineMaxBytes(session.settings?.get("tools.artifactSpillThreshold")),
	};
}

function configuredInlineMaxBytes(configuredKb: number | undefined): number | undefined {
	if (configuredKb === undefined) return undefined;
	if (Number.isFinite(configuredKb) && configuredKb > 0) return configuredKb * 1024;
	logger.warn("tools.artifactSpillThreshold is not a positive number of KB; using the compiled default instead", {
		configuredKb,
		usingBytes: DEFAULT_MAX_BYTES,
	});
	return undefined;
}

export function inlineBudgetFor(session: InlinePricingSource, maxBytes?: number): number {
	return resolveInlineCap({ ...inlineOutputPricing(session), ...(maxBytes !== undefined ? { maxBytes } : {}) });
}

export function reportLostOutputArtifact(toolType: string, error: unknown): void {
	logger.warn("Full tool output could not be saved as an artifact; only the truncated window is recoverable", {
		toolType,
		error: errorMessage(error),
	});
}

export async function saveOutputArtifact(
	session: ToolSession,
	toolType: string,
	text: string,
): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.(toolType);
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, text);
		return alloc.id;
	} catch (error) {
		reportLostOutputArtifact(toolType, error);
		return undefined;
	}
}
