import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { Settings } from "../config/settings";
import { DEFAULT_MAX_BYTES, type InlineByteCapOptions, resolveInlineCap } from "../session/streaming-output";
import type { ToolSession } from "./index";

/** The two things needed to price a tool result, and nothing else. Deliberately structural rather than `ToolSession`. The same question is asked */
export interface InlinePricingSource {
	getTurnIndex?: () => number;
	settings?: Settings;
}

/** When a tool result should spill, for one session. This is the ONE owner of "how is this result priced". Every tool that caps */
export function inlineOutputPricing(
	session: InlinePricingSource,
): Pick<InlineByteCapOptions, "turnIndex" | "floorFraction" | "maxBytes"> {
	return {
		turnIndex: session.getTurnIndex?.(),
		floorFraction: session.settings?.get("tools.inlineOutputFloor"),
		maxBytes: configuredInlineMaxBytes(session.settings?.get("tools.artifactSpillThreshold")),
	};
}

/** The configured inline budget in BYTES, or `undefined` to take the compiled default. */
function configuredInlineMaxBytes(configuredKb: number | undefined): number | undefined {
	if (configuredKb === undefined) return undefined;
	if (Number.isFinite(configuredKb) && configuredKb > 0) return configuredKb * 1024;
	logger.warn("tools.artifactSpillThreshold is not a positive number of KB; using the compiled default instead", {
		configuredKb,
		usingBytes: DEFAULT_MAX_BYTES,
	});
	return undefined;
}

/** The same budget as {@link inlineOutputPricing}, resolved to a byte count. For a tool that bounds its output some other way than */
export function inlineBudgetFor(session: InlinePricingSource, maxBytes?: number): number {
	// Conditional, not `{ ...pricing, maxBytes }`: spreading an absent argument writes `maxBytes: undefined` OVER the configured budget, so every caller
	return resolveInlineCap({ ...inlineOutputPricing(session), ...(maxBytes !== undefined ? { maxBytes } : {}) });
}

/** Report output that was produced and can no longer be reached. The `artifact://<id>` footer is the ONLY route back to the full bytes: the */
export function reportLostOutputArtifact(toolType: string, error: unknown): void {
	logger.warn("Full tool output could not be saved as an artifact; only the truncated window is recoverable", {
		toolType,
		error: errorMessage(error),
	});
}

/** Persist a tool's full output as a session artifact and return its id, or `undefined` when the session has no artifact store or the write fails. */
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
		// Undefined is how the caller learns not to print a footer; the report is how the operator learns
		// the full output is gone, since the window they can see gives no sign of it.
		reportLostOutputArtifact(toolType, error);
		return undefined;
	}
}
