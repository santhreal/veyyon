import { errorMessage, logger } from "@veyyon/utils";
import type { Settings } from "../config/settings";
import { type InlineByteCapOptions, resolveInlineCap } from "../session/streaming-output";
import type { ToolSession } from "./index";

/**
 * The two things needed to price a tool result, and nothing else.
 *
 * Deliberately structural rather than `ToolSession`. The same question is asked
 * from a full tool session, from a `CustomToolContext` handed to an MCP or
 * extension tool, and from the centralised artifact spill, and none of those
 * are each other. Requiring the widest type at the one owner is what pushed the
 * other callers into inventing their own flat budget, which is how there came
 * to be two answers to one question.
 */
export interface InlinePricingSource {
	getTurnIndex?: () => number;
	settings?: Settings;
}

/**
 * When a tool result should spill, for one session.
 *
 * This is the ONE owner of "how is this result priced". Every tool that caps
 * its inline output spreads the same two inputs into
 * {@link enforceInlineByteCap}, and reading them separately at each call site
 * is how they drift: one tool ends up scaling by turn and another does not, for
 * no reason anyone chose. Spread this instead and add the `saveArtifact` the
 * tool owns.
 *
 * `turnIndex` is how long the result will sit in context; `floorFraction` is
 * how tightly an early result may be held. Both come from the session, so a
 * lighter tool session that implements neither gets the flat cap, which is the
 * unpriced behaviour and the safe default.
 */
export function inlineOutputPricing(
	session: InlinePricingSource,
): Pick<InlineByteCapOptions, "turnIndex" | "floorFraction"> {
	return {
		turnIndex: session.getTurnIndex?.(),
		floorFraction: session.settings?.get("tools.inlineOutputFloor"),
	};
}

/**
 * The same budget as {@link inlineOutputPricing}, resolved to a byte count.
 *
 * For a tool that bounds its output some other way than
 * {@link enforceInlineByteCap}. grep is the case: it keeps a HEAD window only,
 * because matches arrive in order and cutting the tail loses the least, whereas
 * a command's output usually matters most at both ends. Those truncation shapes
 * are deliberately different; the budget must not be, or the same bytes are
 * priced one way as a grep result and another as a bash result.
 */
export function inlineBudgetFor(session: InlinePricingSource, maxBytes?: number): number {
	return resolveInlineCap({ ...inlineOutputPricing(session), maxBytes });
}

/**
 * Report output that was produced and can no longer be reached.
 *
 * The `artifact://<id>` footer is the ONLY route back to the full bytes: the
 * visible result is a bounded head/tail window and the raw text is kept nowhere
 * else, so a failed write loses output the operator asked for. The caller does
 * carry on with the window it already built, which is why this has to be said
 * out loud rather than inferred from a missing footer.
 *
 * One owner, because two paths reach the same outcome and must say the same
 * thing: the tool spill below, and the session's own `bash-original` save, which
 * writes through `SessionManager` instead of the tool session.
 */
export function reportLostOutputArtifact(toolType: string, error: unknown): void {
	logger.warn("Full tool output could not be saved as an artifact; only the truncated window is recoverable", {
		toolType,
		error: errorMessage(error),
	});
}

/**
 * Persist a tool's full output as a session artifact and return its id, or
 * `undefined` when the session has no artifact store or the write fails.
 *
 * This is the ONE owner of the `allocateOutputArtifact(toolType) + write`
 * pattern. Every tool that offloads oversized output (bash, grep, browser, gh,
 * ...) routes its spill through here, so the `artifact://<id>` recovery
 * contract lives in exactly one place. Pair it with
 * {@link enforceInlineByteCap} as the `saveArtifact` callback.
 *
 * A failed allocation or write returns `undefined` rather than throwing: the
 * inline result the caller already built (a bounded head/tail window) stays
 * intact, only the full-output recovery footer is omitted. The caller never
 * depends on the artifact for correctness of the visible result. It is still
 * reported through {@link reportLostOutputArtifact}, because the footer is the
 * only way back to the full bytes.
 *
 * A session with no `allocateOutputArtifact` at all is a different case and
 * stays silent: an MCP or extension tool context legitimately has no artifact
 * store, so there is nothing to lose and nothing to say.
 */
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
